---
sidebar_position: 6
title: Mojo::Pg + Migrations
---

# Mojo::Pg + Migrations

> **Decisão**: Mojo::Pg como camada de acesso a dados relacional; migrations em
> diretórios por versão (`migrations/N/up.sql`, `migrations/N/down.sql`) via
> `Mojo::Pg::Migrations->from_dir`.
> [ADR-016 — Acesso a Dados Relacional Mojo::Pg](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg)

---

## Por que Mojo::Pg

O Mojo::Pg é um wrapper não-bloqueante sobre `DBD::Pg` integrado ao event loop
do Mojolicious. Queries assíncronas não bloqueiam os workers do Hypnotoad durante
operações de banco — crítico para aplicações com latência variável de I/O.

A classe `Mojo::Pg::Migrations` gerencia migrations como arquivos SQL com
marcadores de versão, sem framework externo e sem dependências adicionais.

---

## Configuração no startup da aplicação

```perl
# lib/Stega.pm
package Stega;
use Mojo::Base 'Mojolicious';
use Mojo::Pg;
use Mojo::URL;

sub startup {
    my $self = shift;

    # POSTGRESQL_APP_URL nunca carrega credencial (Revisão 2026-07-04 da ADR-016)
    my $conn = Mojo::URL->new($ENV{POSTGRESQL_APP_URL});
    $conn->userinfo("$ENV{POSTGRESQL_APP_USERNAME}:$ENV{POSTGRESQL_APP_PASSWORD}");

    # Instância única de Mojo::Pg compartilhada por toda a aplicação
    my $pg = Mojo::Pg->new($conn);
    $self->helper(pg => sub { $pg });

    # ... resto do startup
}
```

```bash
# .env
POSTGRESQL_APP_URL=postgresql://localhost:5432/stega
POSTGRESQL_APP_USERNAME=stega_app
POSTGRESQL_APP_PASSWORD=senha
POSTGRESQL_APP_MIGRATION_USERNAME=stega_migrate
POSTGRESQL_APP_MIGRATION_PASSWORD=senha
```

---

## Queries básicas — no Repository, não no Controller

Os métodos `insert`/`update`/`delete` "açucarados" do `Mojo::Pg::Database` (usados em
alguns exemplos genéricos de Mojo::Pg por aí) não são usados na Stega — todo acesso
usa `query` com SQL explícito e placeholders posicionais (`$1`, `$2`, ...), a mesma
sintaxe que o driver `DBD::Pg` espera. E, desde a extensão do padrão **Domain +
Repository** para `Ticket` e `Comment` (ver [ADR-020](/adrs/ADR-020-dominio-e-repository)),
esse SQL não fica mais no Controller — vive em uma classe
`Stega::Repository::Pg::<Entidade>`, que o Controller injeta e chama:

```perl
# lib/Stega/Repository/Pg/Ticket.pm (trecho)
package Stega::Repository::Pg::Ticket;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

with 'Stega::Repository::Ticket';

has db => (is => 'ro', required => 1);   # $c->pg->db

# SELECT — retorna hashref único
sub find {
    my ($self, $id) = @_;
    return $self->db->query('SELECT * FROM tickets WHERE id = $1', $id)->hash;
}

# INSERT com RETURNING
sub insert_ticket {
    my ($self, %attrs) = @_;
    return $self->db->query(
        'INSERT INTO tickets (product_id, author_id, title, body, priority)
         VALUES ($1, $2, $3, $4, $5) RETURNING *',
        $attrs{product_id}, $attrs{author_id}, $attrs{title}, $attrs{body},
        $attrs{priority} // 'medium'
    )->hash;
}

# UPDATE
sub archive {
    my ($self, $id) = @_;
    return $self->db->query(
        "UPDATE tickets SET status = 'closed', updated_at = NOW() WHERE id = \$1 RETURNING *", $id
    )->hash;
}

1;
```

```perl
# lib/Stega/Controller/Ticket.pm (trecho) — só orquestra, nunca chama $c->pg->db
sub api_show {
    my $c  = shift;
    $c->openapi->valid_input or return;

    my $ticket = Stega::Repository::Pg::Ticket->new(db => $c->pg->db)->find($c->param('id'));
    return $c->render(json => { error => 'Não encontrado' }, status => 404) unless $ticket;

    $c->render(json => { data => $ticket });
}
```

`Product` também passou por esse retrofit (mesmo dia, 2026-07-03) — `Stega::Controller::Product`
não chama `$c->pg->db` diretamente em nenhuma ação. As três entidades (`Product`,
`Ticket`, `Comment`) seguem o mesmo padrão: Repository cobre leituras e escritas; ver a
"Revisão 2026-07-03" da ADR-020 para o histórico completo, incluindo o período em que
`Product` ficou temporariamente para trás.

---

## Queries complexas com SQL literal

```perl
# Busca full-text com ranking
my $results = $self->pg->db->query(
    q{
        SELECT id, title, status,
               ts_rank(search_vector, plainto_tsquery('portuguese', $1)) AS rank
        FROM tickets
        WHERE search_vector @@ plainto_tsquery('portuguese', $1)
          AND status = $2
        ORDER BY rank DESC
        LIMIT 20
    },
    $query_string, $status
)->hashes->to_array;

# JOIN com múltiplas tabelas
my $tickets_with_authors = $self->pg->db->query(
    q{
        SELECT t.id, t.title, t.status,
               u.display_name AS author_name, u.email AS author_email
        FROM tickets t
        JOIN users u ON u.id = t.author_id
        WHERE t.product_id = ?
        ORDER BY t.created_at DESC
    },
    $product_id
)->hashes->to_array;

# JSONB — consulta de containment
my $win_tickets = $self->pg->db->query(
    q{
        SELECT id, title, custom_fields->>'version' AS version
        FROM tickets
        WHERE custom_fields @> $1::jsonb
    },
    '{"os": "Windows 11"}'
)->hashes->to_array;
```

---

## Transações

```perl
# Operação atômica: criar ticket + registrar evento
my $db = $self->pg->db;
my $tx = $db->begin;    # inicia transação

eval {
    my $ticket_id = $db->insert('tickets',
        { title => $body->{title}, body => $body->{body} },
        { returning => 'id' }
    )->hash->{id};

    $db->insert('events', {
        ticket_id => $ticket_id,
        type      => 'ticket.created',
        # { json => ... } é o marcador que o Mojo::Pg serializa (via to_json)
        # para JSONB — um hashref "cru" no bind NÃO é serializado, e
        # encode_json manual corrompe texto acentuado (dupla codificação);
        # ver a seção Mojo::JSON em /stack/mojolicious
        payload   => { json => { author_id => $author_id } },
    });

    $tx->commit;
    $self->render(json => { id => $ticket_id }, status => 201);
};
if (my $err = $@) {
    # $tx->rollback é chamado automaticamente no DESTROY se commit não ocorreu
    $self->app->log->error("Falha ao criar ticket: $err");
    $self->render(json => { error => 'internal' }, status => 500);
}
```

---

## Sistema de migrations

O `eng/migrate.pl` aplica migrations usando dois usuários:
`stega_migrate` (DDL) para criar/alterar tabelas e `stega_app` (DML) para
operações da aplicação — veja [PostgreSQL](/stack/postgresql).

```perl
# eng/migrate.pl
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
use Mojo::Pg;
use Mojo::URL;

my $conn = Mojo::URL->new($ENV{POSTGRESQL_APP_URL});
$conn->userinfo("$ENV{POSTGRESQL_APP_MIGRATION_USERNAME}:$ENV{POSTGRESQL_APP_MIGRATION_PASSWORD}");

my $pg = Mojo::Pg->new($conn);

my $migrations = $pg->migrations
   ->name('stega')
   ->from_dir('migrations');   # lê migrations/N/up.sql e migrations/N/down.sql
$migrations->migrate;          # aplica versões pendentes

say 'Migrations aplicadas com sucesso.';
```

```sql
-- migrations/1/up.sql
-- create_users
CREATE TABLE users (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_id  TEXT         NOT NULL UNIQUE,
    email        TEXT         NOT NULL UNIQUE,
    display_name TEXT         NOT NULL,
    role         TEXT         NOT NULL DEFAULT 'customer',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

```sql
-- migrations/1/down.sql
-- create_users (down)
DROP TABLE users;
```

**Convenção**: cada versão é uma pasta nomeada com um inteiro puro (`1`, `2`, ...) —
`from_dir` identifica a versão pelo nome do diretório, não por marcadores dentro do
arquivo. O comentário na primeira linha de cada `up.sql`/`down.sql` é convenção do
stack para manter o histórico legível, não é lido pelo Mojo::Pg. Ver
[ADR-016](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg).

---

## Consultas assíncronas (não-bloqueantes)

Para queries longas em contexto assíncrono, use `query_p` (retorna Promise):

```perl
# Controller assíncrono
sub list_async {
    my $self = shift;

    $self->pg->db->query_p(
        'SELECT * FROM tickets WHERE status = ?', 'open'
    )->then(sub {
        my $results = shift;
        $self->render(json => $results->hashes->to_array);
    })->catch(sub {
        my $err = shift;
        $self->render(json => { error => "$err" }, status => 500);
    });
}
```

Para a maioria das rotas da Stega, a forma síncrona (`query`) é suficiente —
o Hypnotoad pre-fork lida com concorrência via processos, não via event loop.
Use `query_p` quando um único worker precisar iniciar múltiplas queries em paralelo.

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `->hash` em zero resultados | Retorna `undef` — não é um erro | Cheque `unless $row` antes de usar |
| `->hashes` vs `->hashes->to_array` | `->hashes` retorna um objeto Mojo::Collection | Use `->to_array` para obter arrayref serializável em JSON |
| Interpolação SQL | `"SELECT * FROM tickets WHERE id = $id"` — injeção SQL | Sempre use placeholders `?` ou `$1` |
| JSONB no bind | Um hashref "cru" **não** é serializado — só o marcador `{ json => ... }` é; e `encode_json` manual no bind gera dupla codificação (corrompe acentuação) | Gravar com `{ json => $ref }`; ler com `->expand` (ou `from_json` para JSON em `text`/`->>`) — ver a [seção Mojo::JSON](/stack/mojolicious#mojojson--to_jsonfrom_json-vs-encode_jsondecode_json) |
| `begin` sem `commit` | Transação fica aberta até o `$tx` sair de escopo (rollback automático) | Sempre `eval { ... $tx->commit }` com tratamento de erro |
| Helper `pg` fora do controller | `$self->pg` só funciona em contexto Mojolicious | Passe a instância `$pg` explicitamente para serviços e scripts |
