---
sidebar_position: 8
title: "Guia 8 — RabbitMQ e Minion"
---

# Guia 8 — Processamento Assíncrono com Minion e RabbitMQ

> **Referência arquitetural**:
> [ADR-008 — Message Broker RabbitMQ](/adrs/ADR-008-message-broker-rabbitmq)

---

## O que você vai construir

Ao final deste guia você terá:

- Um job Minion enfileirado por uma rota HTTP, executado por um worker Minion
  separado do processo web
- Esse job publicando uma mensagem no RabbitMQ via `Net::AMQP::RabbitMQ`
- Um `NotificationWorker` dedicado consumindo essa fila em loop contínuo

---

## Pré-requisitos

- [Guia 7](/guides/contrato-de-api-openapi) concluído
- RabbitMQ **4.3** rodando (`docker compose up -d rabbitmq`)
- `Minion`, `Minion::Backend::Pg` e `Net::AMQP::RabbitMQ` **2.40000+** no `cpanfile`

:::caution Windows nativo
`Net::AMQP::RabbitMQ` embute um cliente C (`rabbitmq-c`) que assume `poll()`
disponível — ausente no MinGW/Winsock (só existe `WSAPoll()`, nome e assinatura
diferentes). O `cpanm install` falha com `undefined reference to 'poll'`, e não há
flag que resolva (`--notest`/`--force` não ajudam — é falha de link, não de teste).
Para desenvolvimento nativo no Windows, o `NotificationWorker` (e qualquer job que
publique no RabbitMQ) precisa rodar via Docker Compose — o resto da aplicação
funciona normalmente com Perl nativo, já que nada mais no processo web depende
desse módulo em tempo de carregamento. Ver `DEVELOPMENT.md`/`TESTING.md` da Stega
para o roteiro completo com essa exceção.
:::

---

## Por que dois mecanismos — Minion **e** RabbitMQ

São camadas com papéis diferentes, não alternativas concorrentes:

- **Minion**: fila de jobs *interna* à aplicação, backend PostgreSQL (sem serviço
  novo). Bom para trabalho que só a própria Stega precisa processar — verificar SLA,
  gerar relatório, converter um webhook em ticket.
- **RabbitMQ**: broker *externo*, para notificar sistemas de fora (e-mail, Slack) —
  interoperabilidade via AMQP que o Minion não oferece.

A rota HTTP **nunca fala com o RabbitMQ diretamente**. Ela enfileira um job Minion e
retorna; é o job (executado pelo worker Minion, fora do ciclo de requisição/resposta)
quem publica no RabbitMQ:

```
HTTP Handler → $c->minion->enqueue(...)
                  ↓ (fila no Postgres)
           Minion Worker → Net::AMQP::RabbitMQ → RabbitMQ Exchange
                                                        ↓
                                            NotificationWorker (consumidor)
```

Isso evita que a resposta ao usuário dependa da disponibilidade do RabbitMQ no exato
momento da requisição — se o broker estiver fora do ar, o job Minion continua na
fila e publica quando ele voltar.

---

## Passo 1 — Registrar o Minion

```perl
# lib/Stega.pm
sub _setup_minion {
    my $self = shift;

    $self->plugin('Minion', Pg => $self->pg);    # mesma instância Mojo::Pg da app

    $self->minion->add_task(
        send_welcome_notification => \&Stega::Job::SendWelcomeNotification::run
    );
}
```

Minion compartilha a conexão `Mojo::Pg` já existente (Guia 5) — sem novo backing
service.

---

## Passo 2 — Enfileirar um job a partir de um Controller

```perl
# lib/Stega/Controller/Auth.pm (trecho do callback de login)
if ($user->{is_first_login}) {
    $c->minion->enqueue(send_welcome_notification => [$user->{id}]);
}
```

`enqueue` só grava uma linha na fila do Minion (tabela `minion_jobs`, no mesmo
Postgres) e retorna imediatamente — o job roda depois, no processo do worker Minion.

---

## Passo 3 — O job: publica no RabbitMQ

```perl
# lib/Stega/Job/SendWelcomeNotification.pm
package Stega::Job::SendWelcomeNotification;
use v5.42;
use utf8;

sub run {
    my ($job, $user_id) = @_;

    my $app  = $job->app;
    my $user = $app->pg->db->query('SELECT * FROM users WHERE id = $1', $user_id)->hash;
    return $job->finish({ skipped => 'usuário não encontrado' }) unless $user;

    _publish_notification($app, 'ticket.welcome', {
        user_id      => $user_id,
        email        => $user->{email},
        display_name => $user->{display_name},
    });

    $job->finish({ notified => $user->{email} });
}

sub _publish_notification {
    my ($app, $routing_key, $payload) = @_;

    require Net::AMQP::RabbitMQ;
    require JSON::PP;

    my $mq = Net::AMQP::RabbitMQ->new;
    eval {
        $mq->connect(
            $ENV{RABBITMQ_HOST} // 'localhost',
            {
                user     => $ENV{RABBITMQ_USER}     // 'stega',
                password => $ENV{RABBITMQ_PASSWORD} // 'dev_password',
                vhost    => $ENV{RABBITMQ_VHOST}    // '/',
                port     => $ENV{RABBITMQ_PORT}     // 5672,
            }
        );
        $mq->channel_open(1);
        $mq->exchange_declare(1, 'stega.notifications', { exchange_type => 'topic', durable => 1 });
        $mq->publish(1, $routing_key, JSON::PP::encode_json($payload), {
            exchange => 'stega.notifications',
        });
        $mq->disconnect;
    };
    warn "Falha ao publicar notificação: $@" if $@;
}

1;
```

Note os dois `require` dentro da sub, não no topo do arquivo — carregamento
preguiçoso. Isso significa que `Stega::Job::SendWelcomeNotification` **compila** sem
`Net::AMQP::RabbitMQ` instalado; o módulo só é exigido quando o job de fato roda.
É por isso que a limitação do Windows (nota acima) não impede o resto da aplicação
de funcionar — só afeta quem tenta executar este job ou o worker de notificação.

A conexão AMQP abre e fecha a cada publicação — aceitável para jobs esporádicos, não
um loop de alta frequência (esse é o `NotificationWorker`, que mantém uma conexão
persistente).

---

## Passo 4 — Rodar o worker Minion

```bash
carton exec perl script/stega minion worker
```

Processa a fila continuamente. Em produção, é um `Deployment` separado do
Kubernetes, mesma imagem da API, só o `command` muda (Guia 9).

---

## Passo 5 — Consumir no `NotificationWorker`

```perl
# lib/Stega/Worker/NotificationWorker.pm
package Stega::Worker::NotificationWorker;
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;

use Net::AMQP::RabbitMQ;
use JSON::PP qw(decode_json);

sub run {
    my $mq = Net::AMQP::RabbitMQ->new;

    $mq->connect($ENV{RABBITMQ_HOST} // 'localhost', {
        user     => $ENV{RABBITMQ_USER}     // 'stega',
        password => $ENV{RABBITMQ_PASSWORD} // 'dev_password',
        vhost    => $ENV{RABBITMQ_VHOST}    // '/',
    });
    $mq->channel_open(1);
    $mq->exchange_declare(1, 'stega.notifications', { exchange_type => 'topic', durable => 1 });
    $mq->queue_declare(1, 'stega.notifications.dispatch', { durable => 1 });
    $mq->queue_bind(1, 'stega.notifications.dispatch', 'stega.notifications', 'ticket.#');
    $mq->consume(1, 'stega.notifications.dispatch');

    say '[NotificationWorker] Aguardando mensagens. Ctrl+C para encerrar.';

    while (my $msg = $mq->recv(0)) {
        eval {
            my $payload = decode_json($msg->{body});
            _dispatch($msg->{routing_key} // '', $payload);
            $mq->ack(1, $msg->{delivery_tag});
        };
        if ($@) {
            warn "[NotificationWorker] Erro ao processar mensagem: $@\n";
            $mq->reject(1, $msg->{delivery_tag}, 0);    # sem requeue — erro permanente
        }
    }
}

1;
```

Diferente do job Minion, este worker mantém **uma conexão persistente** — faz
sentido, porque roda em loop contínuo, não esporadicamente. `$mq->recv(0)`
(bloqueante) espera até a próxima mensagem; `ack`/`reject` confirmam ou recusam
explicitamente, controlando se a mensagem sai da fila ou é reprocessada.

Rode com:

```bash
carton exec perl eng/worker.pl
```

---

## Três processos, três responsabilidades

| Processo | Comando | Papel |
|----------|---------|-------|
| API + Web | `carton exec hypnotoad -f script/stega` | Serve HTTP, enfileira jobs Minion |
| Minion worker | `carton exec perl script/stega minion worker` | Processa jobs internos, publica no RabbitMQ |
| Notification worker | `carton exec perl eng/worker.pl` | Consome RabbitMQ, despacha e-mail/Slack |

Os três compartilham a mesma imagem Docker — só o comando de entrada muda (Guia 9).

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| `Net::AMQP::RabbitMQ` falha ao instalar no Windows (`undefined reference to 'poll'`) | Limitação real do MinGW, não do seu ambiente | Rode o worker via Docker Compose; o resto funciona nativo |
| Job Minion roda mas mensagem nunca chega no worker | Exchange/routing key não coincidem entre publicador e consumidor | Confira `exchange_declare`/`queue_bind` nos dois lados usam o mesmo nome |
| Fila cresce sem consumidor | `NotificationWorker` não está rodando | `docker compose --profile full up -d notification-worker` |
| Job Minion trava sem erro | Conexão AMQP sem timeout numa rede instável | Adicionar timeout explícito ao `connect()` se isso for observado em produção |

---

## Próximos passos

Com processamento assíncrono funcionando, o guia final cobre como tudo isso roda em
produção:

- **Guia 9 — Containerização e Deployment**: a mesma imagem Docker para os três
  processos, InitContainer de migrations, Kubernetes

Explore agora:
- [**ADR-008**](/adrs/ADR-008-message-broker-rabbitmq): a decisão completa — por que
  RabbitMQ além do Minion, e a revisão que alinhou a ADR ao fluxo real (sempre via
  job Minion, nunca publicação direta do handler HTTP)
