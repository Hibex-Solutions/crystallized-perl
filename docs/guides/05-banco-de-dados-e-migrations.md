---
sidebar_position: 5
title: "Guia 5 — Banco de Dados e Migrations"
---

# Guia 5 — Banco de Dados com Mojo::Pg e Migrations com `from_dir`

> **Referências arquiteturais**:
> [ADR-007 — Banco de Dados Relacional PostgreSQL](/adrs/ADR-007-banco-de-dados-relacional-postgresql) ·
> [ADR-016 — Acesso a Dados Relacional Mojo::Pg](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg)

---

## O que você vai construir

Ao final deste guia você terá:

- `lib/Stega.pm` conectado ao PostgreSQL via `Mojo::Pg`, exposto como helper `pg` nos
  Controllers
- `migrations/` estruturado em pastas por versão (`migrations/N/up.sql`,
  `migrations/N/down.sql`), carregadas por `Mojo::Pg::Migrations->from_dir` — sem
  loader customizado
- `eng/migrate.pl` aplicando o schema de forma determinística, como processo separado
  do boot da aplicação
- Queries síncronas em um Repository real (`Stega::Repository::Pg::Ticket`), consumido
  por um Controller que nunca chama `$c->pg->db` diretamente (ver ADR-020)

---

## Pré-requisitos

- [Guia 4](/guides/modelos-de-dominio-e-regras-de-negocio) concluído
- PostgreSQL **17** rodando (`docker compose up -d postgres` — ver Guia 1)
- `Mojo::Pg` **4.22+** no `cpanfile` — é a versão mínima que introduziu
  `Migrations->from_dir` (ver "Alternativas Consideradas" na ADR-016)

---

## Por que PostgreSQL único, sem ORM

A ADR-007 decide PostgreSQL como o único banco do stack — inclusive para dados
semi-estruturados, via `JSONB` (ver Guia de JSONB, ADR-017). A ADR-016 decide
`Mojo::Pg` sem ORM: SQL explícito, auditável e otimizável com `EXPLAIN ANALYZE`, em vez
de gerado por uma camada de abstração. "Explícito" não significa "no Controller" — para
`Ticket`, `Comment` e `Product`, esse SQL vive dentro de uma classe
`Stega::Repository::Pg::<Entidade>` (ver ADR-020, Passo 4 abaixo); o ponto da ADR-016
é o SQL em si ser explícito e legível, não a camada onde ele mora.

---

## Passo 1 — Conectar ao PostgreSQL: `lib/Stega.pm`

```perl
package Stega;
use Mojo::Base 'Mojolicious', -strict;

use Mojo::Pg;

sub startup {
    my $self = shift;
    $self->_setup_database;
    # ... plugins, helpers, rotas (Guias 6 e 7)
}

sub _setup_database {
    my $self = shift;

    my $dsn = $ENV{POSTGRESQL_URL}
        // 'postgresql://postgres:postgres_dev@localhost:5432/stega';

    my $pg = Mojo::Pg->new($dsn);
    $pg->options->{pg_enable_utf8} = -1;    # auto: usa o encoding do servidor (UTF-8)
    $self->helper(pg => sub { $pg });
}

1;
```

`pg_enable_utf8 => -1` deixa o `DBD::Pg` decidir a codificação automaticamente com
base no encoding do servidor — evita problemas de acentuação em dados vindos do
banco, complementar ao padrão de cabeçalho da ADR-019 (que cobre literais de
código-fonte e saída de terminal, não dados de banco).

O helper `pg` fica disponível em qualquer Controller como `$c->pg`.

---

## Passo 2 — Migrations em diretórios: `migrations/`

Cada versão do schema é uma pasta nomeada com um inteiro puro — sem zeros à esquerda,
porque `from_dir()` compara os nomes como números, não como strings:

```
migrations/
├── 1/
│   ├── up.sql
│   └── down.sql
├── 2/
│   ├── up.sql
│   └── down.sql
└── ...
```

```sql
-- migrations/1/up.sql
-- create_users: tabela de usuários sincronizados a partir do Keycloak
CREATE TABLE users (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_id  TEXT         NOT NULL UNIQUE,
    email        TEXT         NOT NULL UNIQUE,
    display_name TEXT         NOT NULL,
    avatar_url   TEXT,
    role         TEXT         NOT NULL DEFAULT 'customer',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

```sql
-- migrations/1/down.sql
-- create_users (down)
DROP TABLE users;
```

O comentário na primeira linha (`-- create_users`) não é lido pelo Mojo::Pg — é
convenção do stack para manter o propósito de cada migration legível no `git log`,
já que o nome do diretório não pode carregar essa informação (`from_dir()` exige
puramente dígitos).

**Por que `from_dir()` e não um loader customizado?** A decisão original deste
projeto usava arquivos únicos por versão (`001_create_users.sql`) concatenados por
um pequeno script em `eng/migrate.pl`. Revisado depois: preferir o mecanismo que a
própria biblioteca oferece a um utilitário próprio equivalente é mais seguro — menos
código para manter, menos superfície para bugs de ordenação. Ver a seção
"Alternativas Consideradas" da ADR-016 para os dois lados dessa troca.

---

## Passo 3 — Aplicar migrations: `eng/migrate.pl`

```perl
#!/usr/bin/env perl
# eng/migrate.pl — aplica migrations pendentes ao banco
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Mojo::Pg;

my $pg = Mojo::Pg->new(
    $ENV{POSTGRESQL_MIGRATION_URL}
        // 'postgresql://myapp_migrate:dev_password@localhost/myapp'
);

my $migrations = $pg->migrations->name('stega')
    ->from_dir("$FindBin::Bin/../migrations");
$migrations->migrate;

say 'Migrations aplicadas com sucesso.';
say 'Versão atual: ' . $migrations->active;
```

Rode (mesmo comando em qualquer sistema operacional — ver ADR-013):

```bash
carton exec perl eng/migrate.pl
```

No Windows, encadeie `| Out-Host` — ver a nota sobre `carton exec` no `TESTING.md`
da Stega se a saída parecer atrasada ou fora de ordem.

O histórico de versões aplicadas fica na própria base, em uma tabela `mojo_migrations`
criada automaticamente pelo Mojo::Pg. Rodar `eng/migrate.pl` de novo, sem migrations
novas, não faz nada — é idempotente.

**Migrations nunca rodam no boot da aplicação.** `eng/migrate.pl` é sempre um
processo separado: localmente antes de `script/stega daemon`, e em produção via
InitContainer do Kubernetes (Guia 9) — garantindo que o schema esteja correto antes
do primeiro request, sem acoplar a inicialização da app à disponibilidade de um
usuário com privilégios DDL.

### Dois usuários: DDL e DML

Em produção, `POSTGRESQL_MIGRATION_URL` (usuário com `CREATE`/`ALTER`/`DROP`) e
`POSTGRESQL_URL` (usuário restrito a `SELECT`/`INSERT`/`UPDATE`/`DELETE`) são
credenciais **distintas** — a aplicação em si nunca tem privilégio para alterar o
schema. Em desenvolvimento local, as duas variáveis apontam para o mesmo usuário por
simplicidade. Os comandos `GRANT` completos estão na ADR-016.

---

## Passo 4 — Queries em um Repository real, não no Controller

Consultas síncronas — adequado ao modelo pre-fork do Hypnotoad, onde cada worker atende
uma requisição por vez. A diferença em relação a um tutorial genérico de Mojo::Pg é
**onde** essa consulta vive: para `Ticket` (e `Comment`, e parcialmente `Product`), todo
o SQL está em uma classe `Stega::Repository::Pg::<Entidade>` (ver
[ADR-020](/adrs/ADR-020-dominio-e-repository)) — o Controller nunca chama `$c->pg->db`
diretamente:

```perl
# lib/Stega/Repository/Pg/Ticket.pm (trecho)
package Stega::Repository::Pg::Ticket;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

with 'Stega::Repository::Ticket';

has db => (is => 'ro', required => 1);   # $c->pg->db

sub find {
    my ($self, $id) = @_;
    return $self->db->query('SELECT * FROM tickets WHERE id = $1', $id)->hash;
}

1;
```

```perl
# lib/Stega/Controller/Ticket.pm (trecho)
sub api_show {
    my $c  = shift;
    $c->openapi->valid_input or return;
    my $id = $c->param('id');

    my $ticket = Stega::Repository::Pg::Ticket->new(db => $c->pg->db)->find($id);
    return $c->render(json => { error => 'Não encontrado' }, status => 404) unless $ticket;

    $c->render(json => { data => $ticket });
}
```

`->hash` retorna uma linha como hashref; `->hashes` (plural) retorna um arrayref de
hashrefs — ambos prontos para `$c->render(json => ...)`, sem conversão manual. O
Controller só monta o Repository (injetando `$c->pg->db`) e chama o método — nunca
escreve SQL. Isso vale tanto para leituras quanto para escritas: `Stega::Domain::Ticket`
(ADR-020) também recebe esse mesmo Repository injetado quando a escrita tem uma regra de
negócio a validar (ex.: `assign`, que checa se o responsável é um agente antes de
gravar).

### Query não-bloqueante, quando importa

Para múltiplas queries independentes que podem rodar em paralelo, `query_p` devolve
uma Promise:

```perl
sub show_with_comments {
    my $c  = shift;
    my $id = $c->param('id');

    my $ticket_p   = $c->pg->db->query_p('SELECT * FROM tickets WHERE id = $1', $id);
    my $comments_p = $c->pg->db->query_p('SELECT * FROM comments WHERE ticket_id = $1', $id);

    Mojo::Promise->all($ticket_p, $comments_p)->then(sub {
        my ($ticket_result, $comments_result) = @_;
        $c->render(json => {
            ticket   => $ticket_result->hash,
            comments => $comments_result->hashes,
        });
    })->catch(sub {
        $c->render(json => { error => 'Erro no banco' }, status => 500);
    })->wait;
}
```

Na prática, a maioria das rotas da Stega usa consultas síncronas — o ganho do
não-bloqueio só compensa quando há queries genuinamente independentes a paralelizar.

### Transações

```perl
sub assign {
    my $c = shift;
    my $db = $c->pg->db;
    my $tx = $db->begin;

    eval {
        $db->query('UPDATE tickets SET assignee_id = $1 WHERE id = $2', $assignee_id, $id);
        $db->query(
            'INSERT INTO events (ticket_id, actor_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)',
            $id, $c->stash('current_user')->{id}, 'assigned', $payload_json
        );
        $tx->commit;
    };
    if ($@) {
        # $tx sai de escopo sem commit — rollback automático no DESTROY
        return $c->render(json => { error => 'Falha na atribuição' }, status => 500);
    }

    $c->render(json => { data => { assigned => 1 } });
}
```

Este é o recurso do Mojo::Pg para operações que precisam ser atômicas. Vale registrar,
com honestidade, que `Stega::Repository::Pg::Ticket::update_assignee` e
`record_event` — os dois passos equivalentes na Stega real — **não** usam `$db->begin`
hoje: são duas chamadas `query` sequenciais, sem transação explícita envolvendo as duas.
Na escala da Stega isso é uma simplificação aceita, não uma recomendação geral — se
`record_event` falhar depois de `update_assignee` ter sido persistido, o ticket fica
reatribuído sem o evento de auditoria correspondente. Um passo futuro razoável seria
envolver os dois em uma transação como a deste exemplo; até lá, use `$db->begin` sempre
que a operação que você estiver escrevendo não tolerar esse tipo de inconsistência
parcial.

---

## Criando uma migration nova

```bash
mkdir migrations/10
```

```sql
-- migrations/10/up.sql
-- add_ticket_priority_index
CREATE INDEX ON tickets (priority);
```

```sql
-- migrations/10/down.sql
-- add_ticket_priority_index (down)
DROP INDEX tickets_priority_idx;
```

```bash
carton exec perl eng/migrate.pl
# Versão atual: 10
```

Nunca reutilize um número de versão — se uma migration aplicada tiver um erro, crie
uma nova versão com a correção em vez de editar a existente.

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| `from_dir` não encontra nenhuma migration | Nome do diretório não é puramente numérico | Renomeie `migrations/01_users/` para `migrations/1/` |
| `Connection refused` | PostgreSQL ainda subindo | Aguarde `docker compose ps` mostrar `(healthy)` |
| Migration aplicada, mas versão não muda | `up.sql` vazio ou só com comentários | Confirme que há pelo menos uma instrução SQL válida no arquivo |
| Acentos corrompidos na saída de `eng/migrate.pl` no Windows | Console do PowerShell não está em UTF-8 | `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` — ver `TESTING.md` |

---

## Próximos passos

Com a camada de dados funcionando, o próximo guia adiciona autenticação:

- **Guia 6 — Autenticação Keycloak**: JWT via JWKS, sincronização de usuário no
  banco no primeiro login (ADR-009)

Explore agora:
- [**ADR-007**](/adrs/ADR-007-banco-de-dados-relacional-postgresql): por que
  PostgreSQL único, sem MongoDB separado para documentos
- [**ADR-016**](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg): a decisão completa
  de `from_dir`, os dois usuários de banco, e as alternativas rejeitadas (DBIx::Class,
  sqitch, o loader customizado original)
