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

**RabbitMQ** como message broker, acessado pela API via **Mojo::RabbitMQ::Client**
(publicação não-bloqueante) e pelos workers via **Net::AMQP::RabbitMQ** (consumo
em loop síncrono em processo dedicado).

## Justificativa

O RabbitMQ é o message broker open source mais amplamente adotado. Implementa o
protocolo AMQP 0-9-1, que provê: persistência de mensagens (durable queues),
confirmação de entrega (acknowledgement), roteamento flexível via exchanges e dead
letter queues para tratamento de falhas.

O modelo de uso no stack é assimétrico por design:

- **Publicação (API)**: a rota Mojolicious publica uma mensagem e retorna HTTP 202.
  Usa `Mojo::RabbitMQ::Client` para não bloquear o event loop.
- **Consumo (Worker)**: um processo Perl dedicado roda em loop contínuo consumindo
  mensagens. Usa `Net::AMQP::RabbitMQ` (síncrono, adequado para um processo que não
  serve HTTP).

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
    image: rabbitmq:3.13-management-alpine
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

### Registro do helper no startup

```perl
# lib/MyApp.pm (trecho — registro do helper rabbitmq)
use Mojo::Base 'Mojolicious';
use Mojo::RabbitMQ::Client;

sub startup {
    my $self = shift;

    # URL AMQP montada a partir das variáveis de ambiente
    my $host = $ENV{RABBITMQ_HOST}     // 'localhost';
    my $user = $ENV{RABBITMQ_USER}     // 'myapp';
    my $pass = $ENV{RABBITMQ_PASSWORD} // 'dev_password';

    my $rabbitmq = Mojo::RabbitMQ::Client->new(
        url => "amqp://$user:$pass\@$host/"
    );

    $self->helper(rabbitmq => sub { $rabbitmq });

    # ... rotas e outros helpers ...
}
```

### Publicação na API (não-bloqueante com Mojo::RabbitMQ::Client)

```perl
# lib/MyApp/Controller/Order.pm
package MyApp::Controller::Order;
use Mojo::Base 'Mojolicious::Controller';
use Mojo::JSON qw(encode_json);

sub create {
    my $self  = shift;
    my $order = $self->req->json;

    # Persistir o pedido no PostgreSQL (ADR-016)
    my $created = $self->pg->db->query(
        'INSERT INTO orders (user_id, total) VALUES (?, ?) RETURNING id',
        $order->{user_id}, $order->{total}
    )->hash;

    my $body = encode_json({
        order_id => $created->{id},
        user_id  => $order->{user_id},
    });

    # Publicar evento de forma não-bloqueante via helper registrado no startup
    $self->rabbitmq->open_channel->then(sub {
        my $channel = shift;
        $channel->publish(
            exchange    => 'orders',
            routing_key => 'order.created',
            body        => $body,
            props       => { delivery_mode => 2 },  # persistente
        );
    })->catch(sub { $self->app->log->error("AMQP publish failed: @_") });

    # Retorna imediatamente — o worker processa em background
    $self->render(json => { id => $created->{id} }, status => 202);
}

1;
```

### Worker consumidor (Net::AMQP::RabbitMQ)

```perl
#!/usr/bin/env perl
# script/worker.pl
use v5.38;    # habilita strict e warnings automaticamente

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
| **AnyEvent::RabbitMQ** | Alternativa async para RabbitMQ em Perl, mas com manutenção incerta; Mojo::RabbitMQ::Client cobre a necessidade de publicação não-bloqueante com manutenção mais ativa |

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
- Declarar `Mojo::RabbitMQ::Client` e `Net::AMQP::RabbitMQ` no `cpanfile`
- Expor `RABBITMQ_HOST`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD` como variáveis de ambiente (Secret no Kubernetes)
- Criar Deployment separado para os workers no Kubernetes
- Configurar dead letter queue para mensagens rejeitadas
