# ADR-016: Acesso a Dados Relacional — Mojo::Pg e Migrations

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Com PostgreSQL definido como banco de dados do stack (ADR-007) e Mojolicious como
framework (ADR-004), é necessário definir como a aplicação acessa o banco de dados e
como o schema evolui ao longo do tempo. A solução deve ser:

- Não-bloqueante: compatível com o event loop assíncrono do Mojolicious
- Com gerenciamento de migrations embutido: o schema deve evoluir junto com o código,
  de forma declarativa e rastreável no Git
- Sem ORM pesado: SQL explícito é preferível para auditabilidade e rastreabilidade
  arquitetural

## Decisão

**Mojo::Pg** como camada de acesso ao PostgreSQL, com **Mojo::Pg::Migrations** para
versionamento e aplicação do schema — executada como processo separado, não no
startup da aplicação.

## Justificativa

O Mojo::Pg é parte do ecossistema Mojolicious (mesmo autor, mesma filosofia) e oferece
integração nativa com o event loop do Mojo. Queries são executadas de forma
não-bloqueante usando callbacks ou a sintaxe `async/await` do Mojo, sem bloquear o
processo Hypnotoad durante operações de banco.

O sistema de migrations do Mojo::Pg (`Mojo::Pg::Migrations`) suporta três formas de
carregar migrations: um único arquivo via `from_file()`, uma string concatenada via
`from_string()`, ou uma árvore de diretórios via `from_dir()` (nativo desde a versão
4.22). A decisão do stack é **`from_dir()`**: cada versão é uma pasta
(`migrations/N/`) com `up.sql` e/ou `down.sql`. O histórico de migrations aplicadas
é armazenado na própria base (tabela `mojo_migrations`).

**Revisão 2026-07-02** — a decisão original desta ADR usava `from_string()` com
arquivos únicos nomeados `NNN_descricao.sql`, concatenados por um loader customizado
em `eng/migrate.pl` (~10 linhas). Essa abordagem foi revertida em favor de
`from_dir()`: o princípio geral do stack é preferir o mecanismo que a própria
biblioteca oferece a um utilitário próprio equivalente — um loader escrito à mão é
uma superfície a mais para bugs (ordenação, encoding, arquivos ignorados por engano)
que o código já testado do Mojo::Pg elimina. O nome de cada migration deixa de estar
no nome do diretório (`from_dir()` exige que seja puramente numérico — regex interna
`/^(\d+)$/`) e passa a estar na primeira linha de comentário dentro de `up.sql`/
`down.sql`, preservando a legibilidade no `git log -p -- migrations/` ainda que não
na listagem do diretório.

As migrations são executadas como **processo separado**, antes da inicialização da
aplicação — via script de engenharia (`eng/migrate.pl`) no desenvolvimento local
e via Kubernetes InitContainer em produção. Isso permite separação de credenciais:
o usuário de migration tem privilégios DDL; a aplicação opera com um usuário
restrito a DML.

A ausência de um ORM pesado (como DBIx::Class) é intencional: SQL explícito é mais
fácil de auditar, de otimizar com `EXPLAIN ANALYZE` e de rastrear no histórico do Git.

Referências: [Mojo::Pg](../references/mojo-pg.md),
[PostgreSQL](../references/postgresql.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

### Arquivos de migrations

As migrations residem em `migrations/`, uma pasta por versão, nomeada com um inteiro
puro (sem preenchimento com zeros — `from_dir()` compara os nomes como números, não
como strings, então `2` e `10` ordenam corretamente sem prefixo `002`/`010`):

```
migrations/
├── 1/
│   ├── up.sql
│   └── down.sql
├── 2/
│   ├── up.sql
│   └── down.sql
└── 3/                        ← ver ADR-017
    ├── up.sql
    └── down.sql
```

Cada `up.sql`/`down.sql` começa com um comentário descrevendo a alteração — é o que
resta do nome legível que um arquivo único como `001_create_users.sql` carregava,
agora movido para dentro do arquivo:

```sql
-- migrations/1/up.sql
-- create_users
CREATE TABLE users (
    id         BIGSERIAL    PRIMARY KEY,
    email      TEXT         NOT NULL UNIQUE,
    name       TEXT         NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

```sql
-- migrations/1/down.sql
-- create_users (down)
DROP TABLE users;
```

```sql
-- migrations/2/up.sql
-- add_user_role
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX ON users (role);
```

```sql
-- migrations/2/down.sql
-- add_user_role (down)
ALTER TABLE users DROP COLUMN role;
```

**Convenções:**
- Nome do diretório: inteiro puro, sem zeros à esquerda (`1`, `2`, ..., `42`) — é
  a única forma que `from_dir()` reconhece como versão
- `up.sql` e/ou `down.sql`: pelo menos um dos dois deve existir; a maioria das
  migrations tem os dois
- Primeira linha de cada arquivo: comentário `-- nome_descritivo` — não é lido pelo
  Mojo::Pg, é convenção do stack para manter o propósito legível no `git log -p`
- Nunca reutilizar um número; ao corrigir uma migration com erro, criar uma nova versão

### Startup da aplicação (sem migration)

A aplicação apenas abre a conexão com o banco e registra o helper. Migrations
**não são executadas no startup** — o banco já está no schema correto quando a
aplicação inicia (garantido pelo InitContainer em produção ou pelo `eng/migrate.pl`
no desenvolvimento local).

```perl
# lib/MyApp.pm
package MyApp;
use Mojo::Base 'Mojolicious';

use Mojo::Pg;

sub startup {
    my $self = shift;

    # Usuário DML: SELECT, INSERT, UPDATE, DELETE apenas (ver seção de permissões)
    my $pg = Mojo::Pg->new($ENV{POSTGRESQL_URL}
        // 'postgresql://myapp_app:dev_password@localhost/myapp');

    # Disponibilizar via helper nos controladores
    $self->helper(pg => sub { $pg });

    my $r = $self->routes;
    $r->get('/healthz')->to('health#check');
    $r->get('/api/v1/users')->to('user#list');
}

1;
```

### Execução de migrations como processo separado

**Desenvolvimento local — `eng/migrate.pl`:**

O script usa `POSTGRESQL_MIGRATION_URL` (credencial DDL) e delega inteiramente ao
`from_dir()` do Mojo::Pg — nenhum loader customizado:

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

my $migrations = $pg->migrations->name('myapp')
    ->from_dir("$FindBin::Bin/../migrations");
$migrations->migrate;

say 'Migrations aplicadas. Versão atual: ' . $migrations->active;
```

Invocação idêntica em qualquer plataforma (ver ADR-013):

```bash
carton exec perl eng/migrate.pl
```

**Produção — Kubernetes InitContainer:**

O InitContainer é executado antes dos containers principais do Pod. Se falhar, o
Pod não avança — garantindo que a aplicação nunca suba com schema desatualizado
(ver ADR-010):

```yaml
initContainers:
  - name: migrate
    image: registry.example.com/myapp:latest
    command: ["carton", "exec", "perl", "eng/migrate.pl"]
    env:
      - name: POSTGRESQL_MIGRATION_URL
        valueFrom:
          secretKeyRef:
            name: myapp-secrets
            key: POSTGRESQL_MIGRATION_URL
```

### Dois usuários de banco de dados

Cada ambiente deve provisionar dois usuários PostgreSQL com privilégios distintos:

```sql
-- Executar uma vez como superusuário durante o provisionamento
-- (não incluir no arquivo de migrations — é configuração de infraestrutura)

-- Usuário de migration: pode criar/alterar/remover objetos
CREATE USER myapp_migrate WITH PASSWORD 'senha_migrate';
GRANT ALL PRIVILEGES ON DATABASE myapp TO myapp_migrate;

-- Usuário da aplicação: apenas operações de dados
CREATE USER myapp_app WITH PASSWORD 'senha_app';
GRANT CONNECT ON DATABASE myapp TO myapp_app;
GRANT USAGE ON SCHEMA public TO myapp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO myapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO myapp_app;

-- Estender privilégios para tabelas criadas por migrations futuras
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO myapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO myapp_app;
```

| Variável de ambiente | Usuário | Privilégios |
|---------------------|---------|-------------|
| `POSTGRESQL_MIGRATION_URL` | `myapp_migrate` | DDL: CREATE, ALTER, DROP, GRANT + DML |
| `POSTGRESQL_URL` | `myapp_app` | DML: SELECT, INSERT, UPDATE, DELETE |

### Queries em controladores

**Nota de coerência (ver ADR-020)**: os exemplos abaixo mostram o Controller chamando
`$self->pg->db->query(...)` diretamente — é o padrão geral desta ADR e continua válido
para entidades sem regras de validação de estado. Para entidades que adotam o padrão
**Domain + Repository** (`Product`, `Ticket` e `Comment` na Stega — ver ADR-020), esse
mesmo SQL vive dentro de uma classe `Stega::Repository::Pg::<Entidade>`, não no
Controller: o Controller injeta o Repository e delega, nunca chama `$c->pg->db`
diretamente. A decisão desta ADR (Mojo::Pg, SQL explícito, sem ORM) não muda — só o
arquivo onde esse SQL explícito é escrito.

```perl
# lib/MyApp/Controller/User.pm
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller';

sub list {
    my $self = shift;

    # Query síncrona (adequada para Hypnotoad pre-fork)
    my $users = $self->pg->db->query(
        'SELECT id, email, name, role FROM users ORDER BY created_at DESC'
    )->hashes;

    $self->render(json => $users);
}

sub create {
    my $self = shift;
    my $data = $self->req->json;

    my $user = $self->pg->db->query(
        'INSERT INTO users (email, name) VALUES (?, ?) RETURNING id, email, name',
        $data->{email}, $data->{name}
    )->hash;

    $self->render(json => $user, status => 201);
}

sub show {
    my $self = shift;
    my $id   = $self->param('id');

    my $user = $self->pg->db->query(
        'SELECT id, email, name, role FROM users WHERE id = ?', $id
    )->hash;

    return $self->render(json => { error => 'Not found' }, status => 404)
        unless $user;

    $self->render(json => $user);
}

1;
```

### Query não-bloqueante (com Promises)

Para operações onde o não-bloqueio é crítico (múltiplas queries paralelas):

```perl
sub show_with_posts {
    my $self = shift;
    my $id   = $self->param('id');

    # Duas queries em paralelo, não-bloqueantes
    my $user_p = $self->pg->db->query_p(
        'SELECT id, email, name FROM users WHERE id = ?', $id
    );
    my $posts_p = $self->pg->db->query_p(
        'SELECT id, title FROM posts WHERE user_id = ?', $id
    );

    Mojo::Promise->all($user_p, $posts_p)->then(sub {
        # all() resolve com os valores diretamente em @_, não em arrays intermediários
        my ($user_result, $posts_result) = @_;
        $self->render(json => {
            user  => $user_result->hash,
            posts => $posts_result->hashes,
        });
    })->catch(sub {
        $self->render(json => { error => 'Database error' }, status => 500);
    })->wait;
}
```

### Transações

```perl
sub transfer {
    my $self = shift;
    my $data = $self->req->json;

    my $db = $self->pg->db;
    my $tx = $db->begin;

    eval {
        $db->query('UPDATE accounts SET balance = balance - ? WHERE id = ?',
            $data->{amount}, $data->{from});
        $db->query('UPDATE accounts SET balance = balance + ? WHERE id = ?',
            $data->{amount}, $data->{to});
        $tx->commit;
    };
    if ($@) {
        # $tx vai a DESTROY sem commit, fazendo rollback automaticamente
        return $self->render(json => { error => 'Transaction failed' }, status => 500);
    }

    $self->render(json => { status => 'ok' });
}
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **DBIx::Class** | ORM completo com curva de aprendizado acentuada, geração de schema a partir de classes, sem sistema de migrations embutido integrado ao startup — adiciona complexidade para o ganho de abstração que SQL explícito já oferece |
| **DBI direto (sem Mojo::Pg)** | Sem pool de conexões, sem integração com event loop do Mojo, sem sistema de migrations; exigiria composição manual de ferramentas separadas |
| **Migrations com Flyway / Liquibase** | Ferramentas JVM/externas que exigem Java no container; não há ganho sobre o `Mojo::Pg::Migrations` + `eng/migrate.pl` para o caso de uso do stack |
| **sqitch** | Ferramenta Perl-nativa de migrations com suporte nativo a um arquivo por mudança e dependency graph (sem numeração sequencial). Alternativa válida e mais sofisticada; rejeitada por adicionar uma ferramenta externa ao stack quando a abordagem com múltiplos arquivos + Mojo::Pg cobre as necessidades sem dependência adicional |
| **Rose::DB** | Menos popular, documentação mais escassa, sem integração natural com Mojolicious |
| **Loader customizado com `from_string`** (decisão original desta ADR, revertida em 2026-07-02) | Múltiplos arquivos `NNN_descricao.sql` concatenados por ~10 linhas de código próprio em `eng/migrate.pl`. Funcionava, mas é uma peça de infraestrutura que o projeto mantém e testa por conta própria para resolver um problema (múltiplos arquivos versionados) que o `from_dir()` nativo já resolve com código do próprio Mojo::Pg — testado e mantido pelo autor do framework. Preferir o mecanismo nativo reduz superfície de bugs próprios (ordenação, encoding, arquivo esquecido no `grep`) em favor de um comportamento já coberto pelos testes do CPAN. O custo é perder o nome descritivo na listagem do diretório — mitigado com um comentário na primeira linha de cada `up.sql`/`down.sql` |
| **`from_file()`** (arquivo único) | Concentra todo o histórico de schema em um arquivo — para um projeto com dezenas de migrations, revisão de código e `git blame` ficam difíceis; sem ganho sobre `from_dir()`, que já resolve isso com um arquivo por versão |

## Consequências

**Positivo**:
- Cada migration é uma pasta isolada, com diff limpo no Git e histórico legível por
  `git log -p -- migrations/`
- Carregamento delegado inteiramente ao `Mojo::Pg::Migrations->from_dir` — zero
  código próprio para ordenar, ler ou concatenar arquivos
- Separação de credenciais: a aplicação nunca tem privilégios DDL — um bug na
  aplicação não pode dropar tabelas inadvertidamente
- InitContainer garante ordem determinística: schema está correto antes do primeiro
  request; falha na migration bloqueia o Pod antes de servir tráfego
- SQL explícito e auditável — rastreável no Git
- Pool de conexões async integrado ao event loop do Mojolicious
- `hashes`, `hash`, `arrays` retornam estruturas Perl nativas prontas para JSON

**Negativo**:
- Sem geração automática de queries (como DBIx::Class): SQL mais verboso para CRUDs
  simples
- O nome do diretório não pode carregar uma descrição (só o número da versão) —
  a legibilidade fica no comentário da primeira linha de `up.sql`/`down.sql`, não
  na listagem do diretório
- Dois usuários de banco precisam ser provisionados na configuração inicial de cada ambiente
- Exige `Mojo::Pg` >= 4.22 (versão mínima que introduziu `from_dir()`)

**Ações necessárias**:
- Criar diretório `migrations/` na raiz do projeto, uma pasta numerada por versão
  (`migrations/1/`, `migrations/2/`, ...) com `up.sql`/`down.sql`
- Criar `eng/migrate.pl` (ver ADR-013 — sem wrapper `.ps1`)
- Declarar `Mojo::Pg` >= 4.22 no `cpanfile`
- Expor `POSTGRESQL_URL` (DML) e `POSTGRESQL_MIGRATION_URL` (DDL) como variáveis
  de ambiente separadas em todos os ambientes
- Provisionar dois usuários PostgreSQL com privilégios distintos
- Configurar InitContainer no Deployment do Kubernetes (ver ADR-010)
