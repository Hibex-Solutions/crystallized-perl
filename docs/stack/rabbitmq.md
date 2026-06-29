---
sidebar_position: 7
title: RabbitMQ
---

# RabbitMQ

> **Decisão**: RabbitMQ via AMQP 0-9-1 como message broker para comunicação
> assíncrona entre serviços. `Mojo::RabbitMQ::Client` para publicação
> não-bloqueante; `Net::AMQP::RabbitMQ` para consumo bloqueante em workers.
> [ADR-008 — Message Broker RabbitMQ](/adrs/ADR-008-message-broker-rabbitmq)

---

## Por que RabbitMQ

A Stega usa **dois mecanismos de fila**: o Minion (PostgreSQL backend) para jobs
internos e persistentes da aplicação, e o RabbitMQ para comunicação entre serviços
desacoplados — especialmente o `NotificationWorker`, que roda como processo separado
e consome mensagens para envio de e-mail e Slack.

O RabbitMQ com AMQP 0-9-1 oferece roteamento semântico via exchanges e routing
keys, que o Minion (fila simples) não provê. Isso permite que diferentes workers
consumam somente os tipos de mensagem que os interessam, sem polling de uma fila
comum.

---

## Dois clientes, dois usos

| Módulo | Tipo | Onde usar |
|--------|------|-----------|
| `Mojo::RabbitMQ::Client` | Não-bloqueante (assíncrono) | Publicação de mensagens a partir de controllers e jobs Minion |
| `Net::AMQP::RabbitMQ` | Bloqueante (síncrono) | Consumo em workers dedicados (`NotificationWorker`) |

Workers dedicados são processos separados — o bloqueio do loop não é um problema
porque o processo existe apenas para consumir mensagens.

---

## Imagem Docker para desenvolvimento

```yaml
# compose.yml
services:
  rabbitmq:
    image: rabbitmq:3-management
    environment:
      RABBITMQ_DEFAULT_USER: stega
      RABBITMQ_DEFAULT_PASS: dev_password
    ports:
      - "5672:5672"     # AMQP
      - "15672:15672"   # Management UI (http://localhost:15672)
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "ping"]
      interval: 10s
      retries: 5
```

---

## Publicação não-bloqueante (Mojo::RabbitMQ::Client)

```perl
# lib/Stega/Controller/Ticket.pm
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';
use Mojo::JSON qw(encode_json);

sub update_status {
    my $self = shift;
    my $id   = $self->param('id');
    my $body = $self->req->json;
    my $new_status = $body->{status};

    # 1. Persistir no banco
    $self->pg->db->update('tickets',
        { status => $new_status, updated_at => \'now()' },
        { id     => $id }
    );

    # 2. Publicar evento no RabbitMQ (não-bloqueante)
    $self->app->mq->publish_message(
        exchange    => 'stega.notifications',
        routing_key => 'ticket.status_changed',
        body        => encode_json({
            ticket_id  => $id,
            new_status => $new_status,
            actor_id   => $self->stash('jwt_claims')->{sub},
        }),
    );

    $self->render(json => { ok => 1 });
}

1;
```

```perl
# lib/Stega.pm — configuração do cliente RabbitMQ como helper
use Mojo::RabbitMQ::Client;

my $mq = Mojo::RabbitMQ::Client->new(
    url => sprintf(
        'amqp://%s:%s@%s',
        $ENV{RABBITMQ_USER}     // 'stega',
        $ENV{RABBITMQ_PASSWORD} // 'dev_password',
        $ENV{RABBITMQ_HOST}     // 'localhost',
    )
);
$self->helper(mq => sub { $mq });
```

---

## Consumo bloqueante (Net::AMQP::RabbitMQ)

```perl
# lib/Stega/Worker/NotificationWorker.pm
package Stega::Worker::NotificationWorker;
use strict;
use warnings;
use Net::AMQP::RabbitMQ;
use Mojo::JSON qw(decode_json);

sub run {
    my $mq = Net::AMQP::RabbitMQ->new;

    $mq->connect($ENV{RABBITMQ_HOST} // 'localhost', {
        user     => $ENV{RABBITMQ_USER}     // 'stega',
        password => $ENV{RABBITMQ_PASSWORD} // 'dev_password',
        vhost    => '/',
    });

    $mq->channel_open(1);

    # Declarar exchange (idempotente — seguro executar sempre)
    $mq->exchange_declare(1, 'stega.notifications', {
        exchange_type => 'topic',
        durable       => 1,
    });

    # Fila durável e binding com wildcard
    $mq->queue_declare(1, 'notifications', { durable => 1 });
    $mq->queue_bind(1, 'notifications', 'stega.notifications', 'ticket.#');

    $mq->consume(1, 'notifications');

    # Loop de consumo — bloqueia o processo
    while (my $msg = $mq->recv) {
        eval {
            my $payload = decode_json($msg->{body});
            _dispatch($msg->{routing_key}, $payload);
            $mq->ack(1, $msg->{delivery_tag});
        };
        if (my $err = $@) {
            warn "Erro ao processar mensagem: $err";
            $mq->nack(1, $msg->{delivery_tag}, 0, 1);  # requeue
        }
    }
}

sub _dispatch {
    my ($routing_key, $payload) = @_;

    if ($routing_key eq 'ticket.status_changed') {
        _send_email($payload);
    } elsif ($routing_key eq 'ticket.sla_breached') {
        _send_slack_alert($payload);
    } elsif ($routing_key eq 'ticket.comment_added') {
        _notify_participants($payload);
    }
}

1;
```

```perl
# eng/worker.pl — inicia o NotificationWorker
use strict;
use warnings;
use lib 'lib';
use Stega::Worker::NotificationWorker;

Stega::Worker::NotificationWorker->run;
```

```bash
# Iniciar o worker
carton exec perl eng/worker.pl
```

---

## Routing keys da Stega

| Routing key | Publicado por | Consumido por |
|-------------|--------------|--------------|
| `ticket.status_changed` | Controller ao mudar status | NotificationWorker → e-mail ao autor |
| `ticket.assigned` | Controller ao atribuir agente | NotificationWorker → e-mail ao agente |
| `ticket.comment_added` | Controller ao adicionar comentário | NotificationWorker → e-mail aos participantes |
| `ticket.sla_breached` | Job Minion `check_sla_breaches` | NotificationWorker → Slack do produto |
| `ticket.resolved` | Controller ao resolver ticket | NotificationWorker → e-mail ao autor |
| `report.weekly_ready` | Job Minion `generate_activity_report` | NotificationWorker → e-mail com relatório |

---

## Minion vs. RabbitMQ — quando usar cada um

| Critério | Minion (PostgreSQL) | RabbitMQ |
|----------|--------------------|-|
| Processamento interno à aplicação | ✅ ideal | sobredimensionado |
| Comunicação entre serviços separados | ❌ não projetado | ✅ ideal |
| Roteamento semântico (topic/direct) | ❌ fila única | ✅ exchanges e bindings |
| Reprocessamento com backoff | ✅ nativo | configuração manual |
| Sem serviço externo adicional | ✅ usa o PostgreSQL existente | ❌ serviço separado |

Na Stega, o Minion lida com `send_welcome_notification`, `check_sla_breaches`,
`process_webhook_payload` e `generate_activity_report`. O RabbitMQ recebe os eventos
que os jobs Minion publicam para que o `NotificationWorker` possa consumi-los
de forma totalmente desacoplada.

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Exchange não declarado no consumer | Se a aplicação caiu antes de declarar, o consumer falha | Declare exchanges no worker também (idempotente) |
| Mensagem sem ack em caso de erro | Mensagem fica "unacked" e bloqueia a fila | Sempre `ack` ou `nack` — use `eval` para garantir |
| `Net::AMQP::RabbitMQ` em Mojolicious | Bloqueante — paralisa o event loop | Use `Mojo::RabbitMQ::Client` para publicação; `Net::AMQP` apenas em workers isolados |
| Fila não-durável | Reinicialização do RabbitMQ apaga a fila e mensagens pendentes | Declare filas com `durable => 1` em produção |
| Routing key muito genérica | `#` consome tudo do exchange, incluindo mensagens não intencionais | Seja específico: `ticket.#` em vez de `#` |
