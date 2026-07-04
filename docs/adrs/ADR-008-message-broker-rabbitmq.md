# ADR-008: Message Broker — RabbitMQ

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

O stack inclui workers de background que processam tarefas assíncronas: envio de
emails, integrações com sistemas externos, processamento de eventos pesados. A API
Mojolicious deve publicar tarefas em uma fila e retornar imediatamente ao cliente, sem
aguardar o processamento. É necessário um message broker que:

- Desacople produtores (API) de consumidores (workers)
- Garanta entrega persistente das mensagens (não perdê-las se o worker cair)
- Permita múltiplos consumidores e roteamento flexível

## Decisão

**RabbitMQ** como message broker, acessado exclusivamente via **Net::AMQP::RabbitMQ**
— tanto para publicar (dentro de jobs Minion, não na rota HTTP diretamente) quanto
para consumir (worker dedicado, em loop síncrono).

**Revisão 2026-07-04**: a versão original desta ADR previa `Mojo::RabbitMQ::Client`
para publicação não-bloqueante direto no handler HTTP. Na implementação real, a rota
HTTP nunca fala com o RabbitMQ diretamente — ela sempre enfileira um job no Minion
(ver fluxo abaixo), e é o **job Minion** que publica, de forma síncrona, com
`Net::AMQP::RabbitMQ`. `Mojo::RabbitMQ::Client` nunca chegou a ser usado; removido
desta ADR para refletir o que está de fato implementado e testado.

## Justificativa

O RabbitMQ é o message broker open source mais amplamente adotado. Implementa o
protocolo AMQP 0-9-1, que provê: persistência de mensagens (durable queues),
confirmação de entrega (acknowledgement), roteamento flexível via exchanges e dead
letter queues para tratamento de falhas.

O modelo de uso no stack é assimétrico por design:

- **Publicação (API)**: a rota Mojolicious enfileira um job no **Minion** (backend
  PostgreSQL) e retorna imediatamente. O job Minion é executado pelo worker Minion
  e publica a mensagem no RabbitMQ via `Net::AMQP::RabbitMQ`. Esta indireção garante
  que a publicação seja durável mesmo que o RabbitMQ esteja temporariamente
  indisponível — o job permanece na fila Minion até que possa ser processado.
- **Consumo (NotificationWorker)**: um processo Perl dedicado roda em loop contínuo
  consumindo mensagens do RabbitMQ. Usa `Net::AMQP::RabbitMQ` (síncrono, adequado
  para um processo que não serve HTTP).

```
HTTP Handler → minion->enqueue('job_name', [...])
                  ↓  (PostgreSQL Minion queue)
           Minion Worker → Net::AMQP::RabbitMQ → RabbitMQ Exchange
                                                        ↓
                                            NotificationWorker (consumidor)
```

**Por que sempre passar pelo Minion, nunca publicar direto do handler HTTP**: a
latência extra de enfileirar (grava uma linha no Postgres, o worker Minion pega em
seguida) é pequena e compensa a durabilidade — se o RabbitMQ estiver indisponível no
momento da requisição, o job Minion continua na fila e é reprocessado quando o
broker voltar. Publicar direto do handler HTTP eliminaria essa etapa, mas faria a
requisição do usuário depender da disponibilidade do RabbitMQ no exato momento —
inaceitável para uma ação como "criar ticket", que não deve falhar por causa de um
serviço de notificação fora do ar.

Workers são containers separados no Kubernetes: mesmo Deployment, mesma imagem Docker
da API, apenas o `command` é diferente (aponta para o script do worker em vez do
Hypnotoad).

**Nota importante — Minion como alternativa simples:**  
Para projetos que não precisam de roteamento avançado via exchanges, de interoperabilidade
com sistemas externos via AMQP ou de múltiplos produtores/consumidores independentes,
o **Minion** (job queue nativo do Mojolicious, com backend PostgreSQL) é a alternativa
mais simples e integrada ao stack. A escolha por RabbitMQ aplica-se quando há
requisitos de mensageria avançada ou integração com outros sistemas.

Referências: [RabbitMQ](../references/rabbitmq.md),
[The Twelve-Factor App](../references/twelve-factor-app.md),
[Mojolicious](../references/mojolicious.md)

### Configuração no Docker Compose

```yaml
services:
  rabbitmq:
    image: rabbitmq:4.3-management
    environment:
      RABBITMQ_DEFAULT_USER: myapp
      RABBITMQ_DEFAULT_PASS: dev_password
    ports:
      - "5672:5672"    # AMQP
      - "15672:15672"  # Management UI (desenvolvimento)
    healthcheck:
      test: rabbitmq-diagnostics -q ping
      interval: 10s
      timeout: 5s
      retries: 5
```

### Registro do Minion no startup

Minion usa a mesma instância `Mojo::Pg` da aplicação — sem novo serviço de backing
além do que a ADR-016 já declara:

```perl
# lib/MyApp.pm (trecho)
sub startup {
    my $self = shift;

    $self->_setup_database;   # $self->pg — ver ADR-016
    $self->plugin('Minion', Pg => $self->pg);
    $self->minion->add_task(publish_order_created => \&MyApp::Job::PublishOrderCreated::run);

    # ... rotas e outros helpers ...
}
```

### Controller: enfileira no Minion, não fala com o RabbitMQ

```perl
# lib/MyApp/Controller/Order.pm
package MyApp::Controller::Order;
use Mojo::Base 'Mojolicious::Controller', -strict;

sub create {
    my $c     = shift;
    my $order = $c->req->json;

    my $created = $c->pg->db->query(
        'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id',
        $order->{user_id}, $order->{total}
    )->hash;

    # Enfileira — retorna imediatamente, o job roda no worker Minion (processo separado)
    $c->minion->enqueue(publish_order_created => [$created->{id}]);

    $c->render(json => { id => $created->{id} }, status => 202);
}
```

### Job Minion: publica no RabbitMQ de forma síncrona

```perl
# lib/MyApp/Job/PublishOrderCreated.pm
package MyApp::Job::PublishOrderCreated;
use v5.42;
use utf8;

sub run {
    my ($job, $order_id) = @_;
    my $app = $job->app;

    require Net::AMQP::RabbitMQ;
    require Mojo::JSON;

    my $mq = Net::AMQP::RabbitMQ->new;
    eval {
        $mq->connect(
            $ENV{RABBITMQ_HOST} // 'localhost',
            { user => $ENV{RABBITMQ_USER} // 'myapp', password => $ENV{RABBITMQ_PASSWORD} // 'dev_password', vhost => '/' }
        );
        $mq->channel_open(1);
        $mq->exchange_declare(1, 'orders', { exchange_type => 'topic', durable => 1 });
        $mq->publish(1, 'order.created', Mojo::JSON::encode_json({ order_id => $order_id }), {
            exchange => 'orders',
        });
        $mq->disconnect;
    };
    warn "Falha ao publicar no RabbitMQ: $@" if $@;

    $job->finish({ published => !$@ });
}

1;
```

A conexão AMQP é aberta e fechada a cada chamada — aceitável porque jobs Minion são
esporádicos, não um loop de alta frequência. O `eval` garante que uma falha do
RabbitMQ não derruba o worker Minion nem perde o job (ele pode ser reenfileirado).

### Worker consumidor (Net::AMQP::RabbitMQ)

```perl
#!/usr/bin/env perl
# script/worker.pl
use v5.42;    # habilita strict e warnings automaticamente

use lib 'lib';
use Net::AMQP::RabbitMQ;
use Mojo::JSON qw(decode_json);
use MyApp::Service::OrderProcessor;

my $mq = Net::AMQP::RabbitMQ->new;

# Net::AMQP::RabbitMQ recebe host e opções separados (não aceita URL AMQP diretamente)
my $host = $ENV{RABBITMQ_HOST}     // 'localhost';
my $user = $ENV{RABBITMQ_USER}     // 'myapp';
my $pass = $ENV{RABBITMQ_PASSWORD} // 'dev_password';

$mq->connect($host, { user => $user, password => $pass, vhost => '/' });
$mq->channel_open(1);

# Declarar exchange e queue (idempotente)
$mq->exchange_declare(1, 'orders', { exchange_type => 'topic', durable => 1 });
$mq->queue_declare(1, 'order.created', { durable => 1 });
$mq->queue_bind(1, 'order.created', 'orders', 'order.created');

# Um worker de cada vez (prefetch = 1)
$mq->basic_qos(1, { prefetch_count => 1 });
$mq->consume(1, 'order.created');

say "Worker iniciado. Aguardando mensagens...";

my $processor = MyApp::Service::OrderProcessor->new;

while (1) {
    my $msg = $mq->recv(0);    # 0 = bloqueante
    next unless $msg;

    my $payload = decode_json($msg->{body});

    eval { $processor->process($payload) };
    if ($@) {
        # Rejeitar mensagem (sem requeue) em caso de erro permanente
        $mq->reject(1, $msg->{delivery_tag}, 0);
        warn "Erro ao processar mensagem $msg->{delivery_tag}: $@";
    }
    else {
        # Confirmar processamento com sucesso
        $mq->ack(1, $msg->{delivery_tag});
    }
}
```

### Kubernetes: API e Worker com a mesma imagem

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: myapp:latest
          command: ["carton", "exec", "hypnotoad", "-f", "script/my_app.pl"]
          envFrom:
            - secretRef:
                name: myapp-secrets

---
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-worker
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: worker
          image: myapp:latest      # mesma imagem da API
          command: ["carton", "exec", "perl", "script/worker.pl"]
          envFrom:
            - secretRef:
                name: myapp-secrets
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Minion** (Mojolicious job queue) | Excelente para casos simples: usa PostgreSQL (já no stack), integração nativa Mojo, interface de administração via plugin. Recomendado quando não há requisito de interoperabilidade AMQP — não rejeitado por inadequação, mas por ser menos adequado que RabbitMQ quando múltiplos produtores/consumidores e roteamento avançado são necessários |
| **Redis Pub/Sub** | Sem persistência garantida de mensagens (at-most-once); mensagens publicadas enquanto não há consumidor são perdidas |
| **Apache Kafka** | Complexidade operacional muito maior (Zookeeper/KRaft, particionamento, retenção de logs); adequado para streaming de alto volume, não para task queues de web services |
| **AnyEvent::RabbitMQ** | Alternativa async para RabbitMQ em Perl, mas com manutenção incerta; como a publicação sempre acontece dentro de um job Minion (não no handler HTTP), não há necessidade de um cliente AMQP não-bloqueante — `Net::AMQP::RabbitMQ` síncrono é suficiente e mais simples |
| **`Mojo::RabbitMQ::Client`** (decisão original desta ADR) | Cliente AMQP não-bloqueante para publicar direto do handler HTTP. Nunca chegou a ser implementado — a publicação sempre passou pelo Minion (ver "Revisão 2026-07-04"), tornando um cliente async desnecessário: o job Minion já roda fora do ciclo de requisição/resposta. Reforça a rejeição: é um projeto morto — última release v0.3.1 em 2019-08-20, repositório arquivado pelo mantenedor em 2025-01-24 (somente leitura desde então) |

## Consequências

**Positivo**:
- Desacoplamento total entre API e workers: ambos escaláveis independentemente
- Persistência de mensagens: durable queues garantem que mensagens não se percam
- Roteamento via exchanges: múltiplos tipos de worker podem consumir o mesmo exchange

**Negativo**:
- Segundo serviço de backing a operar (além do PostgreSQL)
- Módulo `Net::AMQP::RabbitMQ` tem dependência XS (requer compilador C no build)
- Dead letter queue e retry strategies precisam ser configurados explicitamente

**Ações necessárias**:
- Adicionar serviço `rabbitmq` ao Docker Compose com healthcheck
- Declarar `Net::AMQP::RabbitMQ` no `cpanfile` (usado tanto no worker consumidor quanto nos jobs Minion que publicam mensagens)
- Expor `RABBITMQ_HOST`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD` como variáveis de ambiente (Secret no Kubernetes)
- Criar Deployment separado para os workers no Kubernetes
- Configurar dead letter queue para mensagens rejeitadas
