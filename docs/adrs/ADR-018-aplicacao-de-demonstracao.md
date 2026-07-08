# ADR-018: Aplicação de Demonstração — Stega

**Status**: Aceita  
**Data**: 2026-06-27  
**Revisada**: 2026-06-27

## Contexto

Os guias de usuário deste projeto precisam de exemplos de código concretos e
executáveis para demonstrar cada aspecto do stack. Sem uma aplicação de referência
canônica, cada guia inventa seu próprio domínio (`MyApp`, `BlogApp`, `ShopApp`) —
resultando em fragmentação que confunde o leitor: nomes de tabelas, controllers e
rotas mudam de capítulo para capítulo sem razão técnica.

Uma aplicação de demonstração unificada resolve isso: todos os exemplos do projeto
— guias, ADRs, trechos de código — referenciam a mesma aplicação, com o mesmo
schema de banco, os mesmos nomes de módulos e as mesmas rotas. O leitor acumula
contexto ao longo dos guias em vez de reaprender o domínio a cada seção.

A aplicação de demonstração também precisa ser suficientemente rica para exercitar
**todos** os componentes do stack sem artifícios. Isso requer: frontend com
autenticação real, banco relacional com busca indexada, dados semi-estruturados em
JSONB, fila local de jobs (Minion) e log de eventos multi-consumidor (PgQue, em
processo separado, ADR-022). Uma aplicação CRUD simples não satisfaria esse
requisito.

## Decisão

**Stega** — um sistema de tickets de suporte para produtos de software — é a
aplicação de demonstração oficial do stack Crystallized Perl. Todos os guias e
exemplos de código que precisam de um domínio concreto usam a Stega.

### Nome e origem

**Stega** deriva de *Stegosaurus* (grego *stégē* = cobertura, abrigo, proteção).
A escolha é intencional: um sistema de suporte **protege** os usuários de problemas
com o produto, **cobre** lacunas de conhecimento e **abriga** o histórico completo
de cada interação. As placas dorsais do Estegossauro — organizadas em fileiras,
cada uma com uma função — servem como metáfora visual para a fila de tickets.

### Repositório

A aplicação reside em um **repositório separado**:

```
hibex-solutions/crystallized-perl-stega
```

Separado do repositório de documentação por três razões:

1. Permite que a aplicação tenha seu próprio histórico Git e issues
2. Pode ser clonado e executado independentemente, sem a documentação
3. Mantém este repositório focado exclusivamente em conteúdo

### Domínio da aplicação

Stega é um sistema multi-produto de tickets de suporte — um Zendesk simplificado
para empresas de software que precisam rastrear solicitações de clientes, atribuir
agentes e resolver problemas com trilha de auditoria completa.

**Por que esse domínio?**

| Requisito didático | Como o domínio satisfaz |
|--------------------|------------------------|
| Frontend com autenticação | Portal do cliente e painel do agente; login via Keycloak OIDC |
| Gestão de usuários e acesso | Três papéis distintos (cliente, agente, admin) com permissões reais |
| Banco relacional com migração | Produtos, tickets, usuários — relações reais com integridade referencial |
| Indexação para busca | Busca em texto completo nos tickets com `tsvector` e índice GIN |
| Dados semi-estruturados JSONB | Campos personalizados por produto, metadados de comentários, log de eventos |
| Fila local de jobs (Minion) | Jobs de SLA, relatórios, processamento de webhooks recebidos |
| Log de eventos multi-consumidor (PgQue) | Worker dedicado para e-mail e Slack desacoplado da aplicação principal |
| Integrações externas | Recepção de webhooks do GitHub; envio de webhooks para sistemas externos |

### Papéis de usuário

| Papel | Descrição | Gerenciado por |
|-------|-----------|----------------|
| `customer` | Abre e acompanha tickets dos próprios produtos | Keycloak |
| `agent` | Atende tickets, adiciona comentários internos, muda status | Keycloak |
| `admin` | Gerencia produtos, usuários e regras de SLA | Keycloak |

O papel do usuário é lido a partir do access token do Keycloak — não do id_token.
O access token carrega o campo `realm_access.roles` (padrão Keycloak) ou a claim
simplificada `role` para tokens HS256 de teste. O middleware de autenticação
(`Stega::Controller::Auth::require_jwt`) extrai o papel com:

```perl
my $role = $claims->{role}
    // do {
        my $roles = ($claims->{realm_access} // {})->{roles} // [];
        (grep { /^(admin|agent|customer)$/ } @$roles)[0] // 'customer'
    };
```

### Entidades do domínio

| Entidade | Descrição |
|----------|-----------|
| `Product` | Produto de software para o qual clientes abrem tickets |
| `User` | Espelho local do usuário Keycloak (sincronizado no login) |
| `Ticket` | Solicitação de suporte com status, prioridade e busca indexada |
| `Comment` | Mensagem na discussão de um ticket (interna ou pública) |
| `Event` | Log imutável de cada mudança de estado de um ticket |
| `Tag` | Rótulo de classificação associado a tickets |

### Schema do banco de dados

As migrations seguem a convenção de diretórios da ADR-016: cada versão é uma pasta
`migrations/N/` com `up.sql`/`down.sql`, carregada via
`Mojo::Pg::Migrations->from_dir`.

```sql
-- migrations/1/up.sql
-- create_users
CREATE TABLE users (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_id  TEXT         NOT NULL UNIQUE,
    email        TEXT         NOT NULL UNIQUE,  -- UNIQUE removido pela migration 8
    display_name TEXT         NOT NULL,
    avatar_url   TEXT,
    role         TEXT         NOT NULL DEFAULT 'customer',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

> **Atenção**: a migration 8 (`migrations/8/up.sql`) remove a constraint `UNIQUE`
> do campo `email`, pois o identificador primário de usuário é `keycloak_id`. O e-mail
> pode mudar no Keycloak e dois ambientes de teste podem ter JWTs com o mesmo e-mail
> mas `keycloak_id`s distintos.

```sql
-- migrations/2/up.sql
-- create_products
CREATE TABLE products (
    id          BIGSERIAL    PRIMARY KEY,
    name        TEXT         NOT NULL,
    slug        TEXT         NOT NULL UNIQUE,
    description TEXT,
    settings    JSONB,
    -- settings: {"sla_hours": {"critical": 4, "high": 8, "medium": 24},
    --             "webhook_url": "https://...", "slack_channel": "#suporte",
    --             "github_repo": "org/repo"}
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

```sql
-- migrations/3/up.sql
-- create_tickets
CREATE TABLE tickets (
    id              BIGSERIAL    PRIMARY KEY,
    product_id      BIGINT       NOT NULL REFERENCES products(id),
    author_id       UUID         NOT NULL REFERENCES users(id),
    assignee_id     UUID         REFERENCES users(id),
    title           TEXT         NOT NULL,
    body            TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'open',
    -- status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
    priority        TEXT         NOT NULL DEFAULT 'medium',
    -- priority: 'low' | 'medium' | 'high' | 'critical'
    custom_fields   JSONB,
    -- custom_fields: campos livres definidos pelo produto
    -- ex: {"version": "2.3.1", "os": "Windows 11", "browser": "Chrome 120"}
    search_vector   TSVECTOR,    -- mantido por trigger (ver migration 4)
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX ON tickets (status);
CREATE INDEX ON tickets (priority);
CREATE INDEX ON tickets (assignee_id);
CREATE INDEX ON tickets (product_id, status);
CREATE INDEX ON tickets (author_id);
```

```sql
-- migrations/4/up.sql
-- add_ticket_search
CREATE INDEX tickets_search_idx ON tickets USING GIN (search_vector);

CREATE OR REPLACE FUNCTION tickets_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('portuguese', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('portuguese', coalesce(NEW.body,  '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_search_vector_trig
BEFORE INSERT OR UPDATE OF title, body ON tickets
FOR EACH ROW EXECUTE FUNCTION tickets_search_vector_update();
```

```sql
-- migrations/5/up.sql
-- create_comments
CREATE TABLE comments (
    id          BIGSERIAL    PRIMARY KEY,
    ticket_id   BIGINT       NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id   UUID         NOT NULL REFERENCES users(id),
    body        TEXT         NOT NULL,
    is_internal BOOLEAN      NOT NULL DEFAULT false,
    -- comentários internos visíveis apenas para agentes e admins
    metadata    JSONB,
    -- metadata: {"mentions": ["uuid1", "uuid2"],
    --             "attachments": [{"name": "log.txt", "size": 40960, "url": "..."}],
    --             "format": "markdown"}
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ON comments (ticket_id);
```

```sql
-- migrations/6/up.sql
-- create_events
CREATE TABLE events (
    id          BIGSERIAL    PRIMARY KEY,
    ticket_id   BIGINT       NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id    UUID         REFERENCES users(id),
    type        TEXT         NOT NULL,
    -- type: 'ticket.created' | 'status.changed' | 'priority.changed' |
    --        'assigned' | 'comment.added' | 'resolved' | 'ticket.sla_breached'
    payload     JSONB        NOT NULL DEFAULT '{}',
    -- payload: {"old_status": "open", "new_status": "in_progress",
    --            "assigned_to": "uuid", "reason": "..."}
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ON events (ticket_id);
CREATE INDEX ON events (type);
CREATE INDEX ON events USING GIN (payload);
```

```sql
-- migrations/7/up.sql
-- create_tags
CREATE TABLE tags (
    id   BIGSERIAL  PRIMARY KEY,
    name TEXT       NOT NULL UNIQUE
);

CREATE TABLE ticket_tags (
    ticket_id  BIGINT  NOT NULL REFERENCES tickets(id)  ON DELETE CASCADE,
    tag_id     BIGINT  NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
);
```

```sql
-- migrations/8/up.sql
-- relax_user_email_unique: email não é identificador primário; keycloak_id é
-- a chave. A constraint UNIQUE em email impede upserts legítimos quando dois
-- JWTs têm o mesmo email mas keycloak_ids distintos (e.g., ambientes de teste).
ALTER TABLE users DROP CONSTRAINT users_email_key;
```

```sql
-- migrations/9/up.sql
-- ticket_assignment_index: índice parcial para a consulta de visibilidade
-- de agentes — acelera a busca de tickets em que o agente foi atribuído em
-- algum momento.
CREATE INDEX IF NOT EXISTS events_assigned_to
    ON events ((payload->>'assigned_to'))
    WHERE type = 'assigned';
```

Cada `up.sql` tem um `down.sql` correspondente com a operação inversa (ver os
arquivos reais em `migrations/` no repositório da Stega).

### Frontend e rotas da aplicação

A Stega expõe duas superfícies: uma **interface web server-rendered** (HTML gerado
por templates Mojolicious + Bootstrap) e uma **API REST** com contrato OpenAPI v3.
Ambas convivem na mesma aplicação Mojolicious; a interface web usa sessão de cookie
(via Keycloak OIDC), a API usa JWT Bearer.

#### Interface web

```
GET  /                        ← dashboard: meus tickets (cliente) ou fila (agente)
GET  /login                   ← redireciona para Keycloak
GET  /auth/callback           ← callback OIDC: cria sessão local e sincroniza user
GET  /logout                  ← encerra sessão local e invalida token no Keycloak

GET  /tickets                 ← lista de tickets com filtro e busca
GET  /tickets/new             ← formulário de abertura de ticket
POST /tickets                 ← submete novo ticket
GET  /tickets/:id             ← detalhe do ticket + thread de comentários
POST /tickets/:id/comments    ← adiciona comentário (HTML form)
POST /tickets/:id/status      ← muda status (agente/admin)

GET  /profile                 ← perfil do usuário
POST /profile/avatar          ← atualiza URL do avatar
GET  /profile/password        ← redireciona para fluxo de troca de senha no Keycloak

GET  /admin/products          ← lista de produtos (admin)
GET  /admin/products/new      ← formulário de novo produto (admin)
POST /admin/products          ← cria produto (admin)
PATCH /admin/products/:id     ← atualiza configurações do produto (admin)
GET  /admin/users             ← lista de usuários (admin)
```

#### API REST (prefixo `/api/v1`)

```
GET    /healthz                            ← sem autenticação (ADR-010)

GET    /api/v1/tickets                     ← lista + busca (?q=texto&status=open)
POST   /api/v1/tickets                     ← abre ticket
GET    /api/v1/tickets/:id                 ← detalhe do ticket
PATCH  /api/v1/tickets/:id                 ← atualiza status, prioridade, responsável
DELETE /api/v1/tickets/:id                 ← arquiva ticket (admin)

GET    /api/v1/tickets/:id/comments        ← lista comentários (internos excluídos para customers)
POST   /api/v1/tickets/:id/comments        ← adiciona comentário com JSONB metadata
PATCH  /api/v1/tickets/:id/comments/:cid   ← edita comentário

GET    /api/v1/tickets/:id/events          ← log de auditoria do ticket

GET    /api/v1/products                    ← lista produtos ativos
POST   /api/v1/products                    ← cria produto (admin)
PATCH  /api/v1/products/:id               ← atualiza produto (admin)

GET    /api/v1/users                       ← lista usuários (agent/admin)
GET    /api/v1/users/:id                   ← perfil do usuário

POST   /api/v1/webhooks/github             ← recebe eventos do GitHub (issue → ticket)
POST   /api/v1/webhooks/generic            ← receptor de webhook genérico
```

A busca em `/api/v1/tickets?q=texto` usa `search_vector @@ plainto_tsquery('portuguese', $1)`
com o índice GIN criado na migration 004 — sem extensão adicional, sem serviço externo.

### Estrutura de módulos Perl

```
lib/
├── Stega.pm                             ← aplicação principal (herda Mojolicious)
└── Stega/
    ├── Controller/
    │   ├── Auth.pm                      ← login, callback OIDC, logout, perfil
    │   ├── Dashboard.pm                 ← página inicial (web)
    │   ├── Ticket.pm                    ← CRUD de tickets (web + API)
    │   ├── Comment.pm                   ← thread de discussão
    │   ├── Product.pm                   ← gestão de produtos (admin)
    │   ├── User.pm                      ← gestão de usuários (admin/agent)
    │   ├── Webhook.pm                   ← recepção de webhooks externos
    │   └── Health.pm                    ← GET /healthz
    ├── Model/
    │   ├── Ticket.pm                    ← forma dos dados (Moo)
    │   ├── Comment.pm                   ← modelo de comentário (Moo)
    │   ├── Product.pm                   ← modelo de produto (Moo)
    │   └── User.pm                      ← modelo de usuário local (Moo)
    ├── Domain/
    │   └── TicketPolicy.pm              ← regras de negócio puras, sem banco (ADR-011)
    ├── Job/
    │   ├── SendWelcomeNotification.pm   ← Minion: notificação ao primeiro login
    │   ├── CheckSlaBreaches.pm          ← Minion: verifica tickets sem resposta no prazo
    │   ├── ProcessWebhookPayload.pm     ← Minion: converte evento GitHub em ticket
    │   └── GenerateActivityReport.pm   ← Minion: relatório semanal por produto
    ├── Notification.pm                  ← publish(): envia evento via pgque.send() (ADR-022)
    └── Worker/
        └── NotificationWorker.pm        ← pgque.receive()/ack()/nack(): e-mail e Slack
```

### Fila local de jobs — Minion

A Stega usa o **Minion** (job queue nativo do Mojolicious) com backend PostgreSQL
(`Minion::Backend::Pg`) para jobs internos que precisam de persistência e
reprocessamento, mas não requerem roteamento externo via broker.

O Minion usa uma instância `Mojo::Pg` própria, para `db-jobs` — nunca a mesma
instância da aplicação (ADR-023):

```perl
# em Stega.pm, dentro de startup()
my $jobs_cfg = $self->config->{postgresql}{jobs};
$self->plugin('Minion', Pg => Mojo::Pg->new(Stega::Config::pg_dsn(@{$jobs_cfg}{qw(url username password)})));

$self->minion->add_task(send_welcome_notification => \&Stega::Job::SendWelcomeNotification::run);
$self->minion->add_task(check_sla_breaches        => \&Stega::Job::CheckSlaBreaches::run);
$self->minion->add_task(process_webhook_payload   => \&Stega::Job::ProcessWebhookPayload::run);
$self->minion->add_task(generate_activity_report  => \&Stega::Job::GenerateActivityReport::run);
```

| Job Minion | Disparado por | O que faz |
|------------|--------------|-----------|
| `send_welcome_notification` | Primeiro login do usuário (callback OIDC) | Envia notificação de boas-vindas; não bloqueia o redirecionamento pós-login |
| `check_sla_breaches` | Agendamento periódico (worker Minion) | Varre tickets `open` ou `in_progress` sem atualização dentro do prazo do SLA; publica evento `ticket.sla_breached` via PgQue (`db-events`) |
| `process_webhook_payload` | `POST /api/v1/webhooks/github` | Converte issue do GitHub em ticket da Stega; processa de forma assíncrona para responder 200 ao GitHub imediatamente |
| `generate_activity_report` | Agendamento semanal | Agrega métricas por produto (tickets abertos, tempo médio de resolução) e publica via PgQue (`db-events`) para envio por e-mail |

O worker Minion é executado com:

```bash
carton exec perl -Ilib script/stega minion worker
```

### Serviço de notificações — PgQue

O **NotificationWorker** é um processo **completamente separado** da aplicação web.
Ele consome eventos da fila `stega.notifications` no PgQue (PostgreSQL, instância
`db-events`) e despacha para canais externos (e-mail, Slack, webhooks de saída).
Usa `pgque.receive()`/`ack()`/`nack()` via `Mojo::Pg` (síncrono, adequado para
workers dedicados — conforme ADR-022).

```perl
# lib/Stega/Worker/NotificationWorker.pm
package Stega::Worker::NotificationWorker;
use v5.42;
use utf8;

use Stega::Config;
use Mojo::Pg;
use Mojo::JSON qw(decode_json);

sub run {
    my $events_cfg = Stega::Config::load()->{postgresql}{events};
    my $pg         = Mojo::Pg->new(Stega::Config::pg_dsn(@{$events_cfg}{qw(url username password)}));
    my $db         = $pg->db;

    $db->query('select pgque.subscribe(?, ?)', 'stega.notifications', 'notification_worker');

    say '[NotificationWorker] Aguardando eventos. Ctrl+C para encerrar.';

    while (1) {
        # Colunas de pgque.message: msg_id, batch_id, type, payload (texto
        # JSON, decodificação manual), retry_count, created_at, extra1..4.
        my $messages = $db->query(
            'select * from pgque.receive(?, ?, ?)',
            'stega.notifications', 'notification_worker', 20
        )->hashes;

        unless (@$messages) {
            sleep 1;
            next;
        }

        for my $msg (@$messages) {
            eval {
                _dispatch($msg->{type}, decode_json($msg->{payload}));
            };
            if ($@) {
                warn "[NotificationWorker] Erro: $@\n";
                # nack() exige um pgque.message completo (10 campos), mas só
                # lê msg_id — ROW(...) com NULL nos demais evita serializar
                # um hashref Perl como composite type.
                $db->query(
                    'select pgque.nack(?, ROW(?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::pgque.message, ?::interval, ?)',
                    $msg->{batch_id}, $msg->{msg_id}, '60 seconds', "$@"
                );
            }
        }

        $db->query('select pgque.ack(?)', $messages->[0]{batch_id});
    }
}
```

| Tipo de evento (`type`) | Evento | Ação do worker |
|-------------|--------|----------------|
| `ticket.assigned` | Ticket atribuído a um agente | E-mail ao agente com resumo do ticket |
| `ticket.status_changed` | Status do ticket mudou | E-mail ao autor com o novo status |
| `ticket.comment_added` | Novo comentário público | E-mail a todos os participantes; menciona usuários do campo `metadata.mentions` |
| `ticket.sla_breached` | SLA ultrapassado (vem do Minion) | Alerta no Slack do canal configurado em `products.settings.slack_channel` |
| `ticket.resolved` | Ticket marcado como resolvido | E-mail ao autor com pesquisa de satisfação (link externo) |
| `report.weekly_ready` | Relatório semanal pronto (vem do Minion) | E-mail com relatório em anexo para admins do produto |

O worker é executado como um processo independente no Kubernetes
(`stega-notification-worker`) e como um contêiner separado no Docker Compose do
ambiente de desenvolvimento — junto de um segundo processo novo, o **ticker do
PgQue** (`stega-pgque-ticker`, `script/pgque_ticker`), que chama `pgque.ticker()`
em loop apertado para materializar os batches que `receive()` consome (ver
ADR-022, seção "Tick de rotação").

### Integrações externas recebidas

A Stega recebe eventos externos via webhooks autenticados:

| Integração | Endpoint | Comportamento |
|-----------|----------|---------------|
| GitHub Issues | `POST /api/v1/webhooks/github` | Issue aberta → ticket Stega; issue fechada → ticket resolvido. Mapeamento por `product.settings.github_repo` |
| Genérico | `POST /api/v1/webhooks/generic` | Payload bruto salvo como `custom_fields` em novo ticket; útil para sistemas legados |

Todos os webhooks recebidos: (1) respondem `202 Accepted` imediatamente e (2)
enfileiram um job `process_webhook_payload` no Minion para processamento assíncrono.
Isso garante que o GitHub ou sistema externo não aguarde o processamento completo.

### Mapeamento completo ADR → componente da Stega

| ADR | Componente exercitado | Onde aparece na Stega |
|-----|----------------------|-----------------------|
| ADR-004 | Mojolicious + Hypnotoad | Framework principal; `Stega.pm`; frontend server-rendered + API no mesmo processo |
| ADR-005 | Carton + cpanm | `cpanfile` com todas as dependências fixadas; `carton exec` em todos os comandos |
| ADR-006 | Moo + Moo::Role | `Stega::Model::Ticket`, `::Comment`, `::Product`, `::User` — lógica de domínio isolada dos controllers |
| ADR-007 | PostgreSQL 17 | Quatro instâncias por finalidade (ADR-023); migrations em `db-app`; dois usuários (DDL e DML) em produção |
| ADR-008 | RabbitMQ (histórico, revogado) | Substituído pelo PgQue — ver ADR-022. Mantido aqui só como registro histórico do que a Stega usou entre 2026-06-27 e 2026-07-07 |
| ADR-009 | Keycloak + JWT | Login OIDC (web); JWT Bearer (API); sincronização de usuário no callback; claim `role` para RBAC |
| ADR-010 | Kubernetes | Quatro Deployments: `stega-api`, `stega-minion-worker`, `stega-notification-worker`, `stega-pgque-ticker`; InitContainer para migration + InitContainer para bootstrap do PgQue |
| ADR-011 | Test::Mojo + prove + Devel::Cover | Suite de testes cobrindo todas as rotas da API; testes de autenticação com JWT falso |
| ADR-012 | Estrutura mínima | `.gitignore`, `.gitattributes`, `DEVELOPMENT.md` com variáveis de ambiente explícitas |
| ADR-013 | Scripts de engenharia/execução | `eng/migrate.pl`, `eng/seed.pl`, `eng/setup.pl`, `eng/bootstrap_pgque.pl` (apoio ao dev); `script/worker`, `script/pgque_ticker` (processos da app, revisão 2026-07-07) |
| ADR-014 | Ambiente de desenvolvimento | `compose.yml` com quatro instâncias PostgreSQL, Keycloak, Minion worker, Notification worker e ticker do PgQue |
| ADR-015 | OpenAPI v3 | `api/stega.yaml` — contrato completo de todas as rotas `/api/v1/...` |
| ADR-016 | Mojo::Pg + migrations | Toda persistência relacional; migrations em `migrations/N/{up,down}.sql` via `from_dir`; dois usuários PostgreSQL em produção |
| ADR-017 | PostgreSQL JSONB | `tickets.custom_fields`, `comments.metadata`, `events.payload`, `products.settings` — quatro usos distintos de JSONB |
| ADR-022 | PgQue | Fila `stega.notifications`; `NotificationWorker` consome com `pgque.receive()`/`ack()`/`nack()`; jobs Minion publicam via `Stega::Notification::publish()` (`pgque.send()`); processo `script/pgque_ticker` dedicado |
| ADR-023 | Topologia de instâncias PostgreSQL | `db-app`/`db-jobs`/`db-events`/`postgres-keycloak` — três instâncias `Mojo::Pg` distintas no mesmo processo Stega (`$app->pg`, backend do Minion, `$app->pg_events`) |

### Estrutura de arquivos do repositório da Stega

```
crystallized-perl-stega/
├── README.md
├── LICENSE
├── DEVELOPMENT.md
├── cpanfile
├── cpanfile.snapshot
├── .env.example
├── .gitignore
├── .gitattributes
├── compose.yml                 ← 4 instâncias PostgreSQL + Keycloak (ADR-014, ADR-023)
├── Dockerfile                  ← multi-stage build: deps → test → production
│
├── api/
│   └── stega.yaml              ← contrato OpenAPI v3 (ADR-015, documentação)
│
├── migrations/                  ← from_dir: uma pasta por versão (ADR-016)
│   ├── 1/ { up.sql, down.sql }  ← create_users
│   ├── 2/ { up.sql, down.sql }  ← create_products
│   ├── 3/ { up.sql, down.sql }  ← create_tickets
│   ├── 4/ { up.sql, down.sql }  ← add_ticket_search
│   ├── 5/ { up.sql, down.sql }  ← create_comments
│   ├── 6/ { up.sql, down.sql }  ← create_events
│   ├── 7/ { up.sql, down.sql }  ← create_tags
│   ├── 8/ { up.sql, down.sql }  ← relax_user_email_unique
│   └── 9/ { up.sql, down.sql }  ← ticket_assignment_index
│
├── lib/
│   ├── Stega.pm
│   └── Stega/
│       ├── Controller/
│       │   ├── Auth.pm
│       │   ├── Comment.pm
│       │   ├── Dashboard.pm
│       │   ├── Health.pm
│       │   ├── Product.pm
│       │   ├── Ticket.pm
│       │   ├── User.pm
│       │   └── Webhook.pm
│       ├── Model/
│       │   ├── Comment.pm
│       │   ├── Product.pm
│       │   ├── Ticket.pm
│       │   └── User.pm
│       ├── Domain/
│       │   └── TicketPolicy.pm
│       ├── Job/
│       │   ├── CheckSlaBreaches.pm
│       │   ├── GenerateActivityReport.pm
│       │   ├── ProcessWebhookPayload.pm
│       │   └── SendWelcomeNotification.pm
│       ├── Notification.pm         ← publish() via pgque.send() (ADR-022)
│       └── Worker/
│           └── NotificationWorker.pm
│
├── templates/                  ← templates Mojolicious (frontend server-rendered)
│   ├── layouts/
│   │   └── default.html.ep
│   ├── auth/
│   ├── dashboard/
│   ├── products/
│   ├── tickets/
│   └── users/
│
├── public/                     ← assets estáticos
│   └── logo.svg
│
├── assets/
│   └── images/
│       └── banner.png
│
├── t/
│   ├── lib/
│   │   └── Stega/Test/
│   │       └── Helper.pm       ← make_jwt() e bearer_header() para testes
│   ├── unit/
│   │   └── domain/
│   │       └── ticket_policy.t ← Stega::Domain::TicketPolicy, sem banco (ADR-011)
│   ├── 001_health.t
│   ├── 010_tickets_api.t
│   ├── 011_comments_api.t
│   ├── 020_products_api.t
│   ├── 030_webhooks.t
│   ├── 040_auth.t
│   ├── 050_ticket_assignment.t
│   └── 060_business_rules.t
│
├── eng/                        ← ferramentas de apoio ao dev/implantação (ADR-013)
│   ├── migrate.pl              ← executa migrations em db-app (ADR-016)
│   ├── seed.pl                 ← popula banco com dados de exemplo
│   ├── setup.pl                ← verifica dependências do ambiente
│   ├── keycloak_test_users.pl  ← cria usuários de teste via API admin do Keycloak
│   └── bootstrap_pgque.pl      ← instala pgque.sql em db-events (ADR-022)
│
├── script/                     ← processos de execução da aplicação (ADR-013, rev. 2026-07-07)
│   ├── stega                   ← script principal Mojolicious
│   ├── worker                  ← inicia NotificationWorker (consumidor PgQue)
│   └── pgque_ticker            ← tick de rotação do PgQue (ADR-022)
│
└── vendor/
    └── pgque/
        ├── pgque.sql           ← vendorizado, v0.2.0 (ADR-022)
        └── LICENSE             ← Apache-2.0
```

### Quatro processos em produção

```
┌──────────────────────────────────────────────────────────────────┐
│ stega-api (Deployment Kubernetes)                                 │
│  └─ Hypnotoad (pre-fork) — serve web + API                       │
│     InitContainer: carton exec perl eng/migrate.pl (db-app)      │
│     InitContainer: carton exec perl eng/bootstrap_pgque.pl       │
│                     (db-events)                                  │
├──────────────────────────────────────────────────────────────────┤
│ stega-minion-worker (Deployment Kubernetes)                       │
│  └─ carton exec perl -Ilib script/stega minion worker            │
│     Backend: db-jobs (Mojo::Pg próprio, não $app->pg)             │
│     Processa: send_welcome_notification, check_sla_breaches,     │
│               process_webhook_payload, generate_activity_report  │
├──────────────────────────────────────────────────────────────────┤
│ stega-notification-worker (Deployment Kubernetes)                 │
│  └─ carton exec perl script/worker                               │
│     Consome: stega.notifications (PgQue, db-events)               │
│     Envia: e-mail, Slack, webhooks de saída                      │
├──────────────────────────────────────────────────────────────────┤
│ stega-pgque-ticker (Deployment Kubernetes, replicas: 1 obrigatório)│
│  └─ carton exec perl script/pgque_ticker                         │
│     pgque.ticker() em loop apertado (~250ms) + maint()/           │
│     maint_retry_events() (~30s) + maint_rotate_tables_step2()     │
│     (~10s) — ver ADR-022, "Tick de rotação"                      │
└──────────────────────────────────────────────────────────────────┘
```

### Escopo dos exemplos de código nos guias

| Granularidade | Descrição | Exemplo de uso |
|---------------|-----------|----------------|
| **Trecho** | Fragmento de código isolado | Demonstrar um operador JSONB, uma query com `tsvector` |
| **Componente** | Um módulo ou rota completa | Tutorial de `Stega::Controller::Ticket` com busca indexada |
| **Aplicação** | A Stega inteira, clonável | Guia de configuração completo do ambiente de desenvolvimento |

Os guias **não** precisam implementar a Stega do zero — podem referenciar o
repositório `crystallized-perl-stega` e focar no ponto específico sendo ensinado.

Referências: [Mojolicious](../references/mojolicious.md),
[PostgreSQL](../references/postgresql.md),
[PgQue](../references/pgque.md),
[Keycloak](../references/keycloak.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Manter a Pluma** (app de publicação de artigos) | Domínio simples demais: não exercita frontend com múltiplos papéis, busca indexada, Minion, integrações externas — faltariam exemplos reais para mais da metade das ADRs |
| **Aplicação de e-commerce** | Domínio familiar, porém exige regras de negócio complexas (cálculo de frete, pagamento) que desviam o foco para problemas do domínio em vez de problemas do stack |
| **Aplicação de blog/CMS** | Similar à Pluma — não justifica a profundidade de JSONB, filas e integrações que o stack exige demonstrar |
| **Múltiplas aplicações menores** | Aumenta a superfície de manutenção sem benefício proporcional; um único domínio bem exercitado é mais eficaz que vários domínios parciais |
| **Exemplos ad hoc por guia** | Fragmentação: leitor reaprenderia o domínio a cada guia; inconsistências acumulam ao longo do projeto |
| **Demo no mesmo repositório** | Mistura documentação com código executável; PRs de documentação precisam passar nos testes da aplicação |

## Consequências

**Positivo**:
- Um único domínio (`Ticket`, `Comment`, `Product`, `User`) em todos os guias — leitores acumulam contexto em vez de reaprender
- Todos os 14 componentes do stack são exercitados com casos de uso reais, não artificiais
- A separação Minion (jobs internos) × PgQue (eventos multi-consumidor) demonstra concretamente o critério de escolha entre os dois — o guia da ADR-022 ganha um exemplo de uso complementar ao invés de alternativo
- A busca por `tsvector` demonstra que PostgreSQL resolve esse requisito sem Elasticsearch
- Repositório separado permite executar e explorar a aplicação independentemente
- Quatro processos distintos em produção demonstram o padrão real de implantação cloud-native, incluindo um processo de manutenção de infraestrutura (ticker) que não serve tráfego nem consome fila de jobs

**Negativo**:
- Manutenção do repositório `crystallized-perl-stega` é trabalho adicional permanente
- Quando uma ADR muda (versão de módulo, convenção), a Stega precisa ser atualizada
- O domínio de tickets é mais complexo que uma simples API; o leitor iniciante precisa de um guia de introdução ao domínio antes dos guias técnicos

**Ações realizadas** *(todas concluídas — repositório em produção)*:
- Repositório `hibex-solutions/crystallized-perl-stega` criado com a estrutura definida nesta ADR
- Migrations implementadas (ver `migrations/` no repositório da Stega para a lista completa e atual)
- `api/stega.yaml` criado com o contrato OpenAPI v3 completo das rotas `/api/v1/...`
- `compose.yml` criado com quatro instâncias PostgreSQL 17 (`postgres-app`,
  `postgres-jobs`, `postgres-events`, `postgres-keycloak`), Keycloak 26.6 e
  perfil `full` para a aplicação (2026-07-07, ADR-022/ADR-023)
- Arquivo de referência `docs/references/minion.md` criado e referenciando esta ADR e ADR-008 (histórico); `docs/references/pgque.md` referenciando ADR-022

**Ações em andamento**:
- Guias de usuário em `docs/guides/` usando a Stega como contexto (próxima fase)
