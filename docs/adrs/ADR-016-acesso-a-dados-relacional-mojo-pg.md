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

O sistema de migrations do Mojo::Pg (`Mojo::Pg::Migrations`) usa SQL puro com
delimitadores de versão (`-- N up` / `-- N down`). Nativamente, o módulo carrega
um único arquivo via `from_file()`. Para projetos com histórico longo, um único
arquivo acumula centenas de linhas — o que torna revisão de código e git blame
mais difíceis. Por isso adota-se múltiplos arquivos numerados (um por migration),
carregados e concatenados programaticamente via `from_string()`. O histórico de
migrations aplicadas é armazenado na própria base (tabela `mojo_migrations`).

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

As migrations residem em `migrations/`, um arquivo por versão, nomeados com prefixo
numérico de três dígitos para garantir ordenação lexicográfica correta:

```
migrations/
├── 001_create_users.sql
├── 002_add_user_role.sql
├── 003_create_posts.sql
└── 004_create_events.sql    ← ver ADR-017
```

Cada arquivo contém exatamente uma versão (up + down):

```sql
-- migrations/001_create_users.sql
-- 1 up
CREATE TABLE users (
    id         BIGSERIAL    PRIMARY KEY,
    email      TEXT         NOT NULL UNIQUE,
    name       TEXT         NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 1 down
DROP TABLE users;
```

```sql
-- migrations/002_add_user_role.sql
-- 2 up
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX ON users (role);

-- 2 down
ALTER TABLE users DROP COLUMN role;
```

```sql
-- migrations/003_create_posts.sql
-- 3 up
CREATE TABLE posts (
    id         BIGSERIAL    PRIMARY KEY,
    user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT         NOT NULL,
    body       TEXT         NOT NULL,
    metadata   JSONB,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ON posts USING GIN (metadata);

-- 3 down
DROP TABLE posts;
```

**Convenções de nomenclatura:**
- Prefixo de 3 dígitos: `001`, `002`, ..., `999` (suficiente para qualquer projeto)
- Separador underscore duplo: `001_create_users.sql` (o nome após o número é livre,
  mas deve descrever a alteração de forma legível)
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

O script usa `POSTGRESQL_MIGRATION_URL` (credencial DDL) e carrega todos os arquivos
de `migrations/` em ordem, concatenando-os antes de passar ao `from_string()`:

```perl
#!/usr/bin/env perl
# eng/migrate.pl — aplica migrations pendentes ao banco

use v5.38;
use lib 'lib';
use Mojo::File qw(path);
use Mojo::Pg;

my $pg = Mojo::Pg->new(
    $ENV{POSTGRESQL_MIGRATION_URL}
        // 'postgresql://myapp_migrate:dev_password@localhost/myapp'
);

# Carrega e concatena todos os arquivos .sql em ordem lexicográfica
my $sql = path('migrations')->list
    ->grep(sub { /\.sql$/ })
    ->sort
    ->map(sub  { $_->slurp })
    ->join("\n");

$pg->migrations->name('myapp')->from_string($sql)->migrate;

say 'Migrations aplicadas. Versão atual: ' . $pg->migrations->version;
```

```powershell
# eng/migrate.ps1
perl "$PSScriptRoot\migrate.pl" @args
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

## Consequências

**Positivo**:
- Múltiplos arquivos de migration: cada alteração é um arquivo isolado, com diff
  limpo no Git e histórico legível por `git log -- migrations/`
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
- Múltiplos arquivos requerem carregador customizado (a lógica em `eng/migrate.pl`
  é simples, mas é código extra que não existe com o `from_file()` nativo)
- Dois usuários de banco precisam ser provisionados no setup inicial de cada ambiente

**Ações necessárias**:
- Criar diretório `migrations/` na raiz do projeto com arquivos numerados
- Criar `eng/migrate.pl` e `eng/migrate.ps1` (ver ADR-013)
- Declarar `Mojo::Pg` no `cpanfile`
- Expor `POSTGRESQL_URL` (DML) e `POSTGRESQL_MIGRATION_URL` (DDL) como variáveis
  de ambiente separadas em todos os ambientes
- Provisionar dois usuários PostgreSQL com privilégios distintos
- Configurar InitContainer no Deployment do Kubernetes (ver ADR-010)
