---
sidebar_position: 8
title: "Guia 8 — Filas com PgQue e Minion"
---

# Guia 8 — Processamento Assíncrono com Minion e PgQue

> **Referência arquitetural**:
> [ADR-022 — Filas em PostgreSQL](/adrs/ADR-022-filas-em-postgresql) e
> [ADR-023 — Topologia de Instâncias PostgreSQL](/adrs/ADR-023-topologia-de-instancias-postgresql)

---

## O que você vai construir

Ao final deste guia você terá:

- Um job Minion enfileirado por uma rota HTTP, executado por um worker Minion
  separado do processo web, com backend na instância `db-jobs`
- Esse job publicando um evento no PgQue via `pgque.send()` (instância `db-events`)
- Um processo de ticker dedicado (`script/pgque_ticker`) mantendo a fila rotacionando
- Um `NotificationWorker` dedicado consumindo essa fila em loop contínuo com
  `pgque.receive()`/`ack()`/`nack()`

---

## Pré-requisitos

- [Guia 7](/guides/contrato-de-api-openapi) concluído
- Instância PostgreSQL `db-events` rodando (`docker compose up -d postgres-events`)
  e com o PgQue instalado (`carton exec perl eng/bootstrap_pgque.pl`)
- `Minion`, `Minion::Backend::Pg` no `cpanfile` (sem dependência XS nova — PgQue é
  SQL puro, consumido via `Mojo::Pg`, já no stack desde a ADR-016)

---

## Por que dois mecanismos — Minion **e** PgQue

São camadas com papéis diferentes, não alternativas concorrentes:

- **Minion**: fila de jobs *interna* à aplicação, backend PostgreSQL dedicado
  (`db-jobs`, ADR-023). Bom para trabalho que só a própria Stega precisa processar —
  verificar SLA, gerar relatório, converter um webhook em ticket.
- **PgQue**: log de eventos multi-consumidor, também em PostgreSQL (`db-events`,
  instância separada) — para notificar canais externos (e-mail, Slack) de forma
  desacoplada, com fan-out real (múltiplos consumidores nomeados podem ler o mesmo
  evento, cada um com seu próprio cursor).

A rota HTTP **nunca fala com o PgQue diretamente**. Ela enfileira um job Minion e
retorna; é o job (executado pelo worker Minion, fora do ciclo de requisição/resposta)
quem publica o evento via `pgque.send()`:

```
HTTP Handler → $c->minion->enqueue(...)
                  ↓ (fila em db-jobs)
           Minion Worker → pgque.send() → fila stega.notifications (db-events)
                                                  ↓ (tick do script/pgque_ticker)
                                    NotificationWorker (pgque.receive/ack/nack)
```

Isso evita que a resposta ao usuário dependa da disponibilidade de `db-events` no
exato momento da requisição — se essa instância estiver fora do ar, o job Minion
continua na fila de `db-jobs` e publica quando ela voltar.

---

## Passo 1 — Registrar o Minion (instância própria, `db-jobs`)

```perl
# lib/Stega.pm
sub _setup_minion {
    my $self = shift;

    # db-jobs — instância própria, NUNCA $self->pg (que aponta para db-app, ADR-023)
    my $jobs_cfg = $self->config->{postgresql}{jobs};
    $self->plugin('Minion', Pg => Mojo::Pg->new(Stega::Config::pg_dsn(@{$jobs_cfg}{qw(url username password)})));

    $self->minion->add_task(
        send_welcome_notification => \&Stega::Job::SendWelcomeNotification::run
    );
}
```

Diferente do Guia 5 (onde `$app->pg` aponta para `db-app`), o Minion usa uma
conexão `Mojo::Pg` **dedicada** para `db-jobs` — nunca reaproveita `$self->pg`. É
uma instância PostgreSQL própria (ADR-023), não um schema dentro do banco da
aplicação.

---

## Passo 2 — Enfileirar um job a partir de um Controller

```perl
# lib/Stega/Controller/Auth.pm (trecho do callback de login)
if ($user->{is_first_login}) {
    $c->minion->enqueue(send_welcome_notification => [$user->{id}]);
}
```

`enqueue` só grava uma linha na fila do Minion (tabela `minion_jobs`, em `db-jobs`)
e retorna imediatamente — o job roda depois, no processo do worker Minion.

---

## Passo 3 — O job: publica no PgQue

```perl
# lib/Stega/Notification.pm — módulo compartilhado pelos três Jobs que publicam eventos
package Stega::Notification;
use v5.42;
use utf8;

sub publish {
    my ($app, $type, $payload) = @_;

    $app->pg_events->db->query(
        'select pgque.send(?, ?, ?::jsonb)',
        'stega.notifications', $type, { json => $payload }
    );
}

1;
```

```perl
# lib/Stega/Job/SendWelcomeNotification.pm
package Stega::Job::SendWelcomeNotification;
use v5.42;
use utf8;

use Stega::Notification;

sub run {
    my ($job, $user_id) = @_;

    my $app  = $job->app;
    my $user = $app->pg->db->query('SELECT * FROM users WHERE id = $1', $user_id)->hash;
    return $job->finish({ skipped => 'usuário não encontrado' }) unless $user;

    Stega::Notification::publish($app, 'ticket.welcome', {
        user_id      => $user_id,
        email        => $user->{email},
        display_name => $user->{display_name},
    });

    $job->finish({ notified => $user->{email} });
}

1;
```

`$app->pg_events` é a instância `Mojo::Pg` dedicada a `db-events` (ver
`Stega.pm::_setup_database`, ADR-023) — nunca `$app->pg` (que é `db-app`). O
`{json => $payload}` do `Mojo::Pg` serializa o payload para `jsonb` sem
`encode_json` manual, evitando a classe de bug de codificação já coberta na
ADR-017. No consumo vale o simétrico: o payload volta do banco já decodificado
para caracteres, então `from_json`, nunca `decode_json` (ver o Passo 6 e a
[seção Mojo::JSON da página do Mojolicious](/stack/mojolicious#mojojson--to_jsonfrom_json-vs-encode_jsondecode_json)).

Note que não há `require` condicional nem `eval` em volta da publicação, ao
contrário do padrão antigo com `Net::AMQP::RabbitMQ`: `pgque.send()` é uma
chamada SQL comum na mesma família de conexões `Mojo::Pg` que o resto da
aplicação já usa — não há um cliente de protocolo externo cuja falha de
carregamento precise ser isolada.

---

## Passo 4 — Rodar o worker Minion

> **Não roda em Windows nativo.** `Minion.pm::worker()` recusa operar
> (`croak 'Minion workers do not support fork emulation'`) em qualquer Perl com
> fork emulado via ithreads (`$Config{d_pseudofork}`, o caso do
> Strawberry/berrybrew) — restrição do próprio Minion (ADR-008), não desta
> ADR-022/PgQue. Use Docker Compose (`docker compose --profile full up -d
> minion-worker`) ou WSL2 para este processo especificamente; os outros três
> processos deste guia rodam nativamente sem exceção. Ver "Revisão 2026-07-08"
> na [ADR-014](/adrs/ADR-014-ambiente-de-desenvolvimento-local). Resolver essa
> exceção de vez é pendência de pesquisa aberta na
> [ADR-024](/adrs/ADR-024-jobs-assincronos-multiplataforma) — ainda `Proposta`,
> sem decisão; inclui um inventário de uso real dos 4 jobs Minion desta
> aplicação e a pergunta em aberto sobre se o PgQue sozinho cobriria os mesmos
> cenários.

```bash
carton exec perl script/stega minion worker
```

Processa a fila continuamente. Em produção, é um `Deployment` separado do
Kubernetes, mesma imagem da API, só o `command` muda (Guia 9).

---

## Passo 5 — O processo de ticker

O PgQue só materializa eventos em lotes (`batch`) que `pgque.receive()` consegue
ler depois que um **tick** acontece — sem um processo chamando `pgque.ticker()`
periodicamente, os eventos publicados por `pgque.send()` ficam pendentes para
sempre.

```perl
#!/usr/bin/env perl
# script/pgque_ticker — tick de rotação do PgQue (ADR-022)
#
# Processo de execução da aplicação (ADR-013, revisão 2026-07-07), não uma
# ferramenta de apoio ao desenvolvimento — roda continuamente em produção.
# EXATAMENTE UMA réplica: o PgQue não coordena chamadas concorrentes de
# ticker() quando o agendamento é externo (fora do pg_cron).
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Mojo::Pg;
use Stega::Config;

my $events_cfg = Stega::Config::load()->{postgresql}{events};
my $db = Mojo::Pg->new(Stega::Config::pg_dsn(@{$events_cfg}{qw(url username password)}))->db;

say '[pgque_ticker] Iniciado. Ctrl+C para encerrar.';

my $last_maint = 0;
my $last_rotate_step2 = 0;

while (1) {
    $db->query('select pgque.ticker()');

    my $now = time;
    if ($now - $last_maint >= 30) {
        $db->query('select pgque.maint()');
        $db->query('select pgque.maint_retry_events()');
        $last_maint = $now;
    }
    if ($now - $last_rotate_step2 >= 10) {
        $db->query('select pgque.maint_rotate_tables_step2()');
        $last_rotate_step2 = $now;
    }

    select undef, undef, undef, 0.25;    # ~250ms entre ticks
}
```

Cada chamada `$db->query(...)` fora de uma transação explícita já é autocommit no
`Mojo::Pg` — satisfaz a exigência do PgQue de que `ticker()` e
`maint_rotate_tables_step2()` rodem em transações **separadas** entre si (ver
ADR-022, "Tick de rotação"). `maint_rotate_tables_step2()` não é opcional: sem
ele, a rotação anti-bloat das tabelas do PgQue para depois da primeira execução.

Rode com:

```bash
carton exec perl script/pgque_ticker
```

---

## Passo 6 — Consumir no `NotificationWorker`

```perl
# lib/Stega/Worker/NotificationWorker.pm
package Stega::Worker::NotificationWorker;
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;

use Mojo::Pg;
use Mojo::JSON qw(from_json);
use Stega::Config;

sub run {
    my $events_cfg = Stega::Config::load()->{postgresql}{events};
    my $db = Mojo::Pg->new(Stega::Config::pg_dsn(@{$events_cfg}{qw(url username password)}))->db;

    $db->query('select pgque.subscribe(?, ?)', 'stega.notifications', 'notification_worker');

    say '[NotificationWorker] Aguardando eventos. Ctrl+C para encerrar.';

    while (1) {
        # Colunas de pgque.message: msg_id, batch_id, type, payload (texto
        # JSON, não jsonb nativo — decodificação manual), retry_count,
        # created_at, extra1..4.
        my $messages = $db->query(
            'select * from pgque.receive(?, ?, ?)',
            'stega.notifications', 'notification_worker', 20
        )->hashes;

        unless (@$messages) {
            sleep 1;
            next;
        }

        for my $msg (@$messages) {
            # from_json, nunca decode_json: o DBD::Pg já decodificou o payload
            # para caracteres — decode_json (que espera bytes) morre em
            # qualquer texto acentuado. Ver a seção Mojo::JSON em
            # /stack/mojolicious.
            eval { _dispatch($msg->{type}, from_json($msg->{payload})) };
            if ($@) {
                warn "[NotificationWorker] Erro ao processar evento: $@\n";
                # pgque.nack() exige um pgque.message completo (10 campos),
                # mas só lê msg_id — os demais são re-consultados
                # internamente. ROW(...) com NULL nos campos não usados evita
                # tentar serializar um hashref Perl como composite type.
                $db->query(
                    'select pgque.nack(?, ROW(?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::pgque.message, ?::interval, ?)',
                    $msg->{batch_id}, $msg->{msg_id}, '60 seconds', "$@"
                );
            }
        }

        $db->query('select pgque.ack(?)', $messages->[0]{batch_id});
    }
}

1;
```

Diferente do job Minion (conexão de vida curta), este worker mantém uma conexão
persistente com `db-events` — faz sentido, porque roda em loop contínuo. `ack`/
`nack` não são alternativos: `nack` por evento agenda retry (ou dead-letter, após
o número máximo de tentativas); `ack` por lote finaliza e avança o cursor do
consumidor — sem ele, o mesmo lote é reentregue indefinidamente.

Rode com:

```bash
carton exec perl script/worker
```

---

## Quatro processos, quatro responsabilidades

| Processo | Comando | Papel |
|----------|---------|-------|
| API + Web | `carton exec hypnotoad -f script/stega` | Serve HTTP, enfileira jobs Minion |
| Minion worker | `carton exec perl script/stega minion worker` | Processa jobs internos (`db-jobs`), publica eventos no PgQue — não roda em Windows nativo, ver Passo 4 |
| Ticker do PgQue | `carton exec perl script/pgque_ticker` | Materializa lotes (`tick`) e faz manutenção anti-bloat (`db-events`) |
| Notification worker | `carton exec perl script/worker` | Consome PgQue, despacha e-mail/Slack |

Os quatro compartilham a mesma imagem Docker — só o comando de entrada muda (Guia 9).

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| Job Minion roda mas evento nunca chega no worker | `script/pgque_ticker` não está rodando — sem tick, `receive()` não retorna nada | `docker compose --profile full up -d pgque-ticker` |
| Fila cresce sem consumidor | `NotificationWorker` não está rodando, ou nunca chamou `pgque.subscribe()` | `docker compose --profile full up -d notification-worker`; confirme com `select * from pgque.get_consumer_info('stega.notifications');` |
| Eventos nunca saem de retry/nunca chegam ao dead-letter | `pgque.maint_retry_events()` não está rodando periodicamente | Confirme que `script/pgque_ticker` está de fato chamando `maint_retry_events()` a cada ~30s, não só `ticker()` |
| Tabelas do PgQue crescem sem rotacionar | `maint_rotate_tables_step2()` não está rodando a cada ~10s | É a causa mais comum de "esqueceram de implementar o step2" — ver ADR-022, "Tick de rotação" |
| Duas réplicas do ticker rodando ao mesmo tempo | `replicas` do Deployment/serviço maior que 1 | O PgQue não coordena chamadas concorrentes de `ticker()` fora do `pg_cron` — sempre `replicas: 1` |
| `Minion workers do not support fork emulation` ao rodar o Passo 4 | Windows nativo (`$Config{d_pseudofork}`) — limitação do Minion, não do PgQue | Docker Compose ou WSL2 só para o worker Minion — ver a nota no Passo 4. Resolver de vez é pendência da [ADR-024](/adrs/ADR-024-jobs-assincronos-multiplataforma) |

---

## Próximos passos

Com processamento assíncrono funcionando, o guia final cobre como tudo isso roda em
produção:

- **Guia 9 — Containerização e Deployment**: a mesma imagem Docker para os quatro
  processos, InitContainers de migration e bootstrap do PgQue, Kubernetes

Explore agora:
- [**ADR-022**](/adrs/ADR-022-filas-em-postgresql): a decisão completa — por que
  PgQue substitui o RabbitMQ, a API usada (`send`/`receive`/`ack`/`nack`) e o
  mecanismo de tick
- [**ADR-023**](/adrs/ADR-023-topologia-de-instancias-postgresql): por que
  `db-events` é uma instância PostgreSQL separada de `db-app`/`db-jobs`
- [**ADR-024**](/adrs/ADR-024-jobs-assincronos-multiplataforma): pendência de
  pesquisa (ainda `Proposta`, sem decisão) sobre o Minion não rodar
  nativamente no Windows — inclui o inventário de uso real dos 4 jobs desta
  aplicação e a pergunta em aberto sobre se o PgQue sozinho cobriria os mesmos
  cenários
