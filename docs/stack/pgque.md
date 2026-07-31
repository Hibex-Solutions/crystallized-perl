---
sidebar_position: 7
title: PgQue
---

# PgQue

> **Decisão**: PgQue (SQL puro + PL/pgSQL, Apache-2.0) como mecanismo de fila de
> eventos multi-consumidor, em PostgreSQL — substitui o RabbitMQ. Consumido
> inteiramente via `Mojo::Pg`, sem cliente de protocolo externo nem dependência XS.
> [ADR-022 — Filas em PostgreSQL](/adrs/ADR-022-filas-em-postgresql)

---

## Por que PgQue

A Stega usa **dois mecanismos de fila**: o Minion (PostgreSQL backend, instância
`db-jobs`) para jobs internos e persistentes da aplicação, e o PgQue (PostgreSQL
backend, instância `db-events` — ADR-023) para comunicação entre serviços
desacoplados — especialmente o `NotificationWorker`, que roda como processo
separado e consome eventos para envio de e-mail e Slack.

O PgQue oferece um log de eventos com **fan-out multi-consumidor**: qualquer
número de consumidores nomeados pode ler o mesmo evento, cada um com seu próprio
cursor de progresso — o mesmo papel que exchanges/routing keys cumpriam no
RabbitMQ, com um modelo conceitualmente diferente (log compartilhado + cursor por
consumidor, não roteamento por chave). Como é SQL puro rodando dentro do próprio
PostgreSQL, elimina a dependência XS (`Net::AMQP::RabbitMQ`) que não compilava no
Windows.

---

## Um mecanismo, dois papéis — nunca publicação direta do handler HTTP

A rota HTTP **nunca fala com o PgQue**. Ela enfileira um job Minion; é o job
(rodando no worker Minion, fora do ciclo de requisição/resposta) quem publica:

```
HTTP Handler → $c->minion->enqueue(...)
                  ↓ (fila em db-jobs)
           Minion Worker → pgque.send() → fila stega.notifications (db-events)
                                                  ↓ (tick do script/pgque_ticker)
                                    NotificationWorker (pgque.receive/ack/nack)
```

| Papel | Onde roda | Bloqueia o quê? |
|-------|-----------|------------------|
| Publicar (dentro do job Minion) | Worker Minion, processo separado do web | Nada — não há requisição HTTP em andamento nesse processo |
| Consumir | `NotificationWorker`, loop dedicado | Nada — o processo existe só para isso |
| Tick de rotação | `script/pgque_ticker`, loop dedicado, `replicas: 1` | Nada — processo de infraestrutura, não serve tráfego nem consome fila de jobs |

Como a publicação nunca acontece dentro do processo que serve HTTP, a resposta ao
usuário nunca depende da disponibilidade de `db-events` no exato momento da
requisição — se essa instância estiver fora do ar, o job Minion continua na fila
de `db-jobs` e publica quando ela voltar.

---

## Instâncias PostgreSQL para desenvolvimento

```yaml
# compose.yml
services:
  postgres-events:
    image: postgres:17-alpine    # imagem intocada — sem pg_cron nem extensão custom
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres_dev
      POSTGRES_DB: stega-events
    ports:
      - "55434:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d stega-events"]
      interval: 5s
      retries: 10

  bootstrap-pgque:
    build: .
    depends_on:
      postgres-events: { condition: service_healthy }
    command: perl eng/bootstrap_pgque.pl
    restart: "no"
```

`bootstrap-pgque` instala `vendor/pgque/pgque.sql` (vendorizado, v0.2.0) e concede
o papel `pgque_admin` à credencial que a aplicação usa para se conectar — passo
idempotente, separado do fluxo de migrations de domínio (ADR-023).

---

## Mantendo a cópia vendorizada atualizada

O build da imagem Docker e o CI só leem `vendor/pgque/pgque.sql` já commitado —
nenhum dos dois baixa nada da rede (essa é a razão original de vendorizar em vez
de instalar em tempo de build, ver ADR-022). Atualizar para uma nova versão do
PgQue é uma atividade de desenvolvimento, feita com `eng/pgque_vendor.pl` na
Stega — a única ferramenta do repositório que fala com o GitHub do PgQue
(`github.com/NikolayS/PgQue`), e só quando um desenvolvedor a invoca:

```bash
# tag/commit vendorizados + checagem de integridade local
carton exec perl eng/pgque_vendor.pl status
# Windows/PowerShell: carton exec perl eng/pgque_vendor.pl status | Out-Host

# tags disponíveis no GitHub
carton exec perl eng/pgque_vendor.pl list
# Windows/PowerShell: carton exec perl eng/pgque_vendor.pl list | Out-Host

# baixa pgque.sql/LICENSE/NOTICE, reescreve SOURCE.json
carton exec perl eng/pgque_vendor.pl update v0.3.0
# Windows/PowerShell: carton exec perl eng/pgque_vendor.pl update v0.3.0 | Out-Host

# git diff --no-index contra qualquer tag do GitHub
carton exec perl eng/pgque_vendor.pl diff v0.3.0
# Windows/PowerShell: carton exec perl eng/pgque_vendor.pl diff v0.3.0 | Out-Host

# sem tag: valida contra a própria tag vendorizada
carton exec perl eng/pgque_vendor.pl diff
# Windows/PowerShell: carton exec perl eng/pgque_vendor.pl diff | Out-Host
```

`vendor/pgque/SOURCE.json` é a fonte de verdade sobre o que está vendorizado —
tag, commit resolvido daquela tag (não a tag em si, que é uma referência
mutável) e checksum SHA-256 de cada arquivo. O `diff` sem argumento existe
especificamente para validar integridade: compara o `pgque.sql` local contra o
GitHub na mesma tag registrada em `SOURCE.json`, detectando corrupção ou edição
manual do arquivo vendorizado. Detalhes completos (inclusive a nota de
`| Out-Host`/encoding para Windows/PowerShell):
[`DEVELOPMENT.md`](https://github.com/Hibex-Solutions/crystallized-perl-stega/blob/main/DEVELOPMENT.md#atualizando-o-pgque-vendorizado-engpgque_vendorpl)
da Stega.

---

## Publicar: dentro de um job Minion

```perl
# lib/Stega/Notification.pm — compartilhado pelos Jobs que publicam eventos
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

`$app->pg_events` é a instância `Mojo::Pg` dedicada a `db-events` (ADR-023) —
nunca `$app->pg` (que é `db-app`). Diferente do padrão antigo com
`Net::AMQP::RabbitMQ`, não há `require` condicional nem `eval` de isolamento: não
existe cliente de protocolo externo cujo carregamento possa falhar — `pgque.send()`
é uma chamada SQL comum, na mesma família de conexões `Mojo::Pg` do resto da
aplicação.

O Controller que enfileira este job nem sabe que PgQue existe:

```perl
# lib/Stega/Controller/Auth.pm (trecho do callback de login)
if ($user->{is_first_login}) {
    $c->minion->enqueue(send_welcome_notification => [$user->{id}]);
}
```

---

## Consumir: worker dedicado (`pgque.receive`/`ack`/`nack`)

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
        # JSON — decodificação manual, não é jsonb nativo), retry_count,
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
            # para caracteres — decode_json (que espera bytes) morre em texto
            # acentuado. Ver a seção Mojo::JSON em /stack/mojolicious.
            eval { _dispatch($msg->{type}, from_json($msg->{payload})) };
            if ($@) {
                warn "[NotificationWorker] Erro ao processar evento: $@\n";
                # nack() exige um pgque.message completo (10 campos), mas só
                # lê msg_id — os demais são re-consultados internamente.
                # ROW(...) com NULL nos campos não usados evita tentar
                # serializar um hashref Perl como composite type.
                $db->query(
                    'select pgque.nack(?, ROW(?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::pgque.message, ?::interval, ?)',
                    $msg->{batch_id}, $msg->{msg_id}, '60 seconds', "$@"
                );
            }
        }

        $db->query('select pgque.ack(?)', $messages->[0]{batch_id});
    }
}

sub _dispatch {
    my ($type, $payload) = @_;

    my %handlers = (
        'ticket.welcome'      => \&_notify_welcome,
        'ticket.sla_breached' => \&_notify_sla_breach,
        'report.weekly_ready' => \&_send_report_email,
    );

    my $handler = $handlers{$type};
    $handler ? $handler->($payload) : warn "[NotificationWorker] Tipo de evento não mapeado: $type\n";
}

1;
```

Diferente do job Minion, este worker mantém **uma conexão persistente** — faz
sentido, porque roda em loop contínuo, não esporadicamente. `ack`/`nack` não são
alternativos: `nack` por evento agenda retry (ou dead-letter, após o número máximo
de tentativas configurado); `ack` por lote finaliza e avança o cursor do
consumidor — sem ele, o mesmo lote é reentregue indefinidamente.

```bash
# script/worker — inicia o NotificationWorker
carton exec perl script/worker
```

---

## O tick: sem ele, `receive()` nunca retorna nada

O PgQue só materializa eventos publicados em **lotes** (`batch`) que
`pgque.receive()` consegue ler depois que um tick acontece. Um processo dedicado,
de longa duração, precisa chamar `pgque.ticker()` continuamente:

```perl
#!/usr/bin/env perl
# script/pgque_ticker
use v5.42;
use utf8;
use Mojo::Pg;
use Stega::Config;

my $events_cfg = Stega::Config::load()->{postgresql}{events};
my $db = Mojo::Pg->new(Stega::Config::pg_dsn(@{$events_cfg}{qw(url username password)}))->db;

my ($last_maint, $last_rotate_step2) = (0, 0);
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

    select undef, undef, undef, 0.25;
}
```

`maint_rotate_tables_step2()` **não é opcional**: o PgQue exige rotação em duas
etapas, cada uma em sua própria transação (`maint()` pula deliberadamente o step2).
Sem chamá-lo periodicamente, a rotação anti-bloat das tabelas do PgQue acontece uma
única vez e nunca mais — o anti-bloat, que é a razão central de usar PgQue em vez
de uma tabela própria, para silenciosamente. **Exatamente uma réplica** deste
processo: o PgQue não coordena chamadas concorrentes de `ticker()` fora do
`pg_cron`.

---

## Tipos de evento publicados hoje na Stega

| Tipo (`type`) | Publicado por | Consumido por |
|-------------------|---------------|---------------|
| `ticket.welcome` | Job Minion `send_welcome_notification` (primeiro login) | `NotificationWorker` → e-mail de boas-vindas |
| `ticket.sla_breached` | Job Minion `check_sla_breaches` | `NotificationWorker` → alerta no Slack do produto |
| `report.weekly_ready` | Job Minion `generate_activity_report` | `NotificationWorker` → e-mail com relatório |

Mudanças de status, atribuição e comentários de ticket **não** passam pelo
PgQue — ficam registradas na tabela `events` (auditoria in-app, ver Guia 4/ADR-020),
que é um mecanismo diferente com um propósito diferente (histórico consultável na
UI, não notificação externa). Se um evento desses precisar virar notificação
externa no futuro, o padrão é o mesmo do `ticket.welcome`: publicar de dentro do
job Minion que já processa aquela ação.

---

## Minion vs. PgQue — quando usar cada um

| Critério | Minion (`db-jobs`) | PgQue (`db-events`) |
|----------|--------------------|----------------------|
| Processamento interno à aplicação | ✅ ideal | sobredimensionado |
| Comunicação entre serviços separados, fan-out real | ❌ não projetado | ✅ ideal |
| Múltiplos consumidores independentes do mesmo evento | ❌ fila única | ✅ um cursor por consumidor nomeado |
| Reprocessamento com backoff | ✅ nativo | ✅ nativo (`nack` + `maint_retry_events`) |
| Requer processo de tick dedicado | ❌ não | ✅ sim (`script/pgque_ticker`) |
| Sem dependência XS | ✅ | ✅ (SQL puro via `Mojo::Pg`) |

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `script/pgque_ticker` não está rodando | Eventos publicados nunca aparecem em `receive()` — não há tick materializando lotes | Sempre suba o ticker junto dos demais processos (`docker compose --profile full up -d pgque-ticker`) |
| `maint_rotate_tables_step2()` esquecido | Rotação acontece uma vez e nunca mais — bloat cresce silenciosamente | O ticker precisa chamar essa função a cada ~10s, em transação própria, além de `ticker()`/`maint()` |
| Duas réplicas do ticker | O PgQue não coordena `ticker()` concorrente fora do `pg_cron` | `replicas: 1`, sempre — nunca escale este processo horizontalmente |
| Evento sem `ack` em caso de sucesso | O mesmo lote é reentregue indefinidamente | Sempre `ack(batch_id)` ao final do processamento do lote, mesmo que alguns eventos individuais tenham levado `nack` |
| Consumidor nunca registrado | `pgque.receive()` para um consumidor que nunca chamou `subscribe()` não retorna nada | `subscribe()` é idempotente — chame no início do `run()` do worker, sempre |
| Publicar direto de um Controller | Acopla a resposta HTTP à disponibilidade de `db-events` | Sempre publique de dentro de um job Minion — ver seção acima |
