---
sidebar_position: 6
title: Mojo::Pg + Migrations
---

# Mojo::Pg + Migrations

> **Decisão**: Mojo::Pg como camada de acesso a dados relacional; sistema de
> migrations multi-arquivo com marcadores `-- N up/down`.
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

sub startup {
    my $self = shift;

    # Instância única de Mojo::Pg compartilhada por toda a aplicação
    my $pg = Mojo::Pg->new($ENV{POSTGRESQL_URL});
    $self->helper(pg => sub { $pg });

    # ... resto do startup
}
```

```bash
# .env
POSTGRESQL_URL=postgresql://stega_app:senha@localhost:5432/stega
POSTGRESQL_MIGRATION_URL=postgresql://stega_migrate:senha@localhost:5432/stega
```

---

## Queries básicas

```perl
# lib/Stega/Controller/Ticket.pm
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';

# SELECT — retorna hashref único
sub show {
    my $self = shift;

    my $ticket = $self->pg->db->query(
        'SELECT id, title, status, priority FROM tickets WHERE id = ?',
        $self->param('id')
    )->hash;

    return $self->render(json => { error => 'not_found' }, status => 404)
        unless $ticket;

    $self->render(json => $ticket);
}

# SELECT — retorna array de hashrefs
sub list {
    my $self = shift;
    my $status = $self->param('status') // 'open';

    my $tickets = $self->pg->db->query(
        'SELECT id, title, status, priority FROM tickets WHERE status = ? ORDER BY created_at DESC',
        $status
    )->hashes->to_array;

    $self->render(json => $tickets);
}

# INSERT com RETURNING
sub create {
    my $self = shift;
    my $body = $self->req->json;

    my $id = $self->pg->db->insert(
        'tickets',
        {
            product_id => $body->{product_id},
            author_id  => $self->stash('jwt_claims')->{sub},
            title      => $body->{title},
            body       => $body->{body},
        },
        { returning => 'id' }
    )->hash->{id};

    $self->render(json => { id => $id }, status => 201);
}

# UPDATE
sub update_status {
    my ($self, $ticket_id, $new_status) = @_;

    $self->pg->db->update(
        'tickets',
        { status => $new_status, updated_at => \'now()' },
        { id     => $ticket_id }
    );
}

# DELETE
sub archive {
    my $self = shift;
    $self->pg->db->delete('tickets', { id => $self->param('id') });
    $self->render(json => { ok => 1 });
}

1;
```

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
        payload   => { author_id => $author_id },  # Mojo::Pg serializa hashref para JSONB
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
use strict;
use warnings;
use Mojo::Pg;

my $pg = Mojo::Pg->new($ENV{POSTGRESQL_MIGRATION_URL});

$pg->migrations
   ->name('stega')
   ->from_dir('migrations')   # lê arquivos NNN_descricao.sql em ordem
   ->migrate;                  # aplica versões pendentes

print "Migrations aplicadas com sucesso.\n";
```

```sql
-- migrations/001_create_users.sql
-- 1 up
CREATE TABLE users (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_id  TEXT         NOT NULL UNIQUE,
    email        TEXT         NOT NULL UNIQUE,
    display_name TEXT         NOT NULL,
    role         TEXT         NOT NULL DEFAULT 'customer',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 1 down
DROP TABLE users;
```

**Convenção de nomenclatura**: `NNN_descricao.sql` onde `NNN` é um inteiro
sequencial. O Mojo::Pg usa os marcadores `-- N up` e `-- N down` para identificar
as versões, não o nome do arquivo — mas o nome facilita a leitura do histórico Git.

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
| JSONB como string | Passar string `'{"key":"val"}'` funciona, mas passar hashref é mais seguro | `{ key => 'val' }` — Mojo::Pg serializa automaticamente para JSONB |
| `begin` sem `commit` | Transação fica aberta até o `$tx` sair de escopo (rollback automático) | Sempre `eval { ... $tx->commit }` com tratamento de erro |
| Helper `pg` fora do controller | `$self->pg` só funciona em contexto Mojolicious | Passe a instância `$pg` explicitamente para serviços e scripts |
