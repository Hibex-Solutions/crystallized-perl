---
sidebar_position: 7
title: RabbitMQ
---

# RabbitMQ

> **Decisão**: RabbitMQ via AMQP 0-9-1 como message broker para comunicação
> assíncrona entre serviços. Um único cliente, `Net::AMQP::RabbitMQ` (bloqueante),
> usado tanto para publicar (dentro de jobs Minion, nunca direto do handler HTTP)
> quanto para consumir (worker dedicado).
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

## Um cliente, dois papéis — nunca publicação direta do handler HTTP

A rota HTTP **nunca fala com o RabbitMQ**. Ela enfileira um job Minion; é o job
(rodando no worker Minion, fora do ciclo de requisição/resposta) quem publica:

```
HTTP Handler → $c->minion->enqueue(...)
                  ↓ (fila no Postgres)
           Minion Worker → Net::AMQP::RabbitMQ → RabbitMQ Exchange
                                                        ↓
                                            NotificationWorker (consumidor)
```

| Papel | Onde roda | Bloqueia o quê? |
|-------|-----------|------------------|
| Publicar (dentro do job Minion) | Worker Minion, processo separado do web | Nada — não há requisição HTTP em andamento nesse processo |
| Consumir | `NotificationWorker`, loop dedicado | Nada — o processo existe só para isso |

Como a publicação nunca acontece dentro do processo que serve HTTP, não há event
loop compartilhado para proteger — `Net::AMQP::RabbitMQ` (bloqueante) é suficiente
nos dois papéis. Um cliente não-bloqueante (`Mojo::RabbitMQ::Client`, avaliado e
descartado — ver ADR-008) resolveria um problema que esta arquitetura não tem, e
carregaria o risco extra de ser um projeto sem manutenção (última release em 2019,
repositório arquivado em 2025).

---

## Imagem Docker para desenvolvimento

```yaml
# compose.yml
services:
  rabbitmq:
    image: rabbitmq:4.3-management
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

## Publicar: dentro de um job Minion

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
        $mq->connect($ENV{RABBITMQ_HOST} // 'localhost', {
            user     => $ENV{RABBITMQ_USER}     // 'stega',
            password => $ENV{RABBITMQ_PASSWORD} // 'dev_password',
            vhost    => $ENV{RABBITMQ_VHOST}    // '/',
        });
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

Note os `require` dentro da sub, não no topo do arquivo — carregamento preguiçoso.
`Stega::Job::SendWelcomeNotification` compila sem `Net::AMQP::RabbitMQ` instalado; o
módulo só é exigido quando o job de fato roda (relevante no Windows — ver
"Armadilhas comuns" abaixo). A conexão abre e fecha a cada chamada — aceitável para
jobs esporádicos.

O Controller que enfileira este job nem sabe que RabbitMQ existe:

```perl
# lib/Stega/Controller/Auth.pm (trecho do callback de login)
if ($user->{is_first_login}) {
    $c->minion->enqueue(send_welcome_notification => [$user->{id}]);
}
```

---

## Consumir: worker dedicado (`Net::AMQP::RabbitMQ`)

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
    $mq->queue_bind(1, 'stega.notifications.dispatch', 'stega.notifications', 'report.#');
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

sub _dispatch {
    my ($routing_key, $payload) = @_;

    my %handlers = (
        'ticket.welcome'      => \&_notify_welcome,
        'ticket.sla_breached' => \&_notify_sla_breach,
        'report.weekly_ready' => \&_send_report_email,
    );

    my $handler = $handlers{$routing_key};
    $handler ? $handler->($payload) : warn "[NotificationWorker] Routing key não mapeada: $routing_key\n";
}

1;
```

Diferente do job Minion, este worker mantém **uma conexão persistente** — faz
sentido, porque roda em loop contínuo, não esporadicamente. Duas bindings
(`ticket.#` e `report.#`) na mesma fila cobrem os dois prefixos de routing key que a
Stega publica hoje. `reject(..., 0)` (sem requeue) assume erro permanente — se o
tipo de falha justificasse retry, seria `reject(..., 1)`.

```bash
# eng/worker.pl — inicia o NotificationWorker
carton exec perl eng/worker.pl
```

---

## Routing keys publicadas hoje na Stega

| Routing key | Publicada por | Consumida por |
|-------------|---------------|---------------|
| `ticket.welcome` | Job Minion `send_welcome_notification` (primeiro login) | `NotificationWorker` → e-mail de boas-vindas |
| `ticket.sla_breached` | Job Minion `check_sla_breaches` | `NotificationWorker` → alerta no Slack do produto |
| `report.weekly_ready` | Job Minion `generate_activity_report` | `NotificationWorker` → e-mail com relatório |

Mudanças de status, atribuição e comentários de ticket **não** passam pelo RabbitMQ —
ficam registradas na tabela `events` (auditoria in-app, ver Guia 4/ADR-020), que é um
mecanismo diferente com um propósito diferente (histórico consultável na UI, não
notificação externa). Se um evento desses precisar virar notificação externa no
futuro, o padrão é o mesmo do `ticket.welcome`: publicar de dentro do job Minion que
já processa aquela ação.

---

## Minion vs. RabbitMQ — quando usar cada um

| Critério | Minion (PostgreSQL) | RabbitMQ |
|----------|--------------------|-|
| Processamento interno à aplicação | ✅ ideal | sobredimensionado |
| Comunicação entre serviços separados | ❌ não projetado | ✅ ideal |
| Roteamento semântico (topic/direct) | ❌ fila única | ✅ exchanges e bindings |
| Reprocessamento com backoff | ✅ nativo | configuração manual |
| Sem serviço externo adicional | ✅ usa o PostgreSQL existente | ❌ serviço separado |

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Exchange não declarado no consumer | Se a aplicação caiu antes de declarar, o consumer falha | Declare exchanges no worker também (idempotente) |
| Mensagem sem ack em caso de erro | Mensagem fica "unacked" e bloqueia a fila | Sempre `ack` ou `reject` — use `eval` para garantir |
| Publicar direto de um Controller | Acopla a resposta HTTP à disponibilidade do RabbitMQ | Sempre publique de dentro de um job Minion — ver seção acima |
| Fila não-durável | Reinicialização do RabbitMQ apaga a fila e mensagens pendentes | Declare filas com `durable => 1` em produção |
| Routing key muito genérica | `#` consome tudo do exchange, incluindo mensagens não intencionais | Seja específico: `ticket.#` em vez de `#` |
| `Net::AMQP::RabbitMQ` não instala no Windows | Módulo embute cliente C que assume `poll()`, ausente no MinGW/Winsock | Rode o worker via Docker Compose no Windows — o resto da app funciona com Perl nativo |
