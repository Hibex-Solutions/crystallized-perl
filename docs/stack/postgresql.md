---
sidebar_position: 5
title: PostgreSQL 17
---

# PostgreSQL 17

> **Decisão**: PostgreSQL 17 como banco de dados único para dados relacionais
> e documentais (JSONB).
> [ADR-007 — Banco de Dados Relacional PostgreSQL](/adrs/ADR-007-banco-de-dados-relacional-postgresql) ·
> [ADR-017 — Dados Documentais JSONB](/adrs/ADR-017-acesso-a-dados-documentos-jsonb)

---

## Por que PostgreSQL

O PostgreSQL elimina a necessidade de um banco de documentos separado: `JSONB`
com índices GIN oferece consultas de estrutura arbitrária sem sacrificar a
integridade referencial das tabelas relacionais. A Stega usa os dois modos no
mesmo banco: tabelas normalizadas para dados com esquema fixo e JSONB para
campos personalizados, metadados e logs de eventos.

A busca em texto completo nativa (`tsvector` + índice GIN) substitui serviços
externos como Elasticsearch para os casos de uso da Stega: sem serviço adicional,
sem sincronização de índice, sem latência extra.

---

## Imagem Docker para desenvolvimento

```yaml
# compose.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB:       stega
      POSTGRES_USER:     stega_migrate   # usuário DDL (migrations)
      POSTGRES_PASSWORD: dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stega_migrate -d stega"]
      interval: 5s
      retries: 5
```

---

## Dois usuários PostgreSQL (padrão do stack)

Em produção, a Stega usa dois usuários com permissões distintas para seguir o
princípio do mínimo privilégio:

```sql
-- Usuário DDL — usado pelo eng/migrate.pl (cria/altera tabelas)
CREATE USER stega_migrate WITH PASSWORD 'senha_migrate';
GRANT ALL PRIVILEGES ON DATABASE stega TO stega_migrate;

-- Usuário DML — usado pela aplicação em runtime (SELECT, INSERT, UPDATE, DELETE)
CREATE USER stega_app WITH PASSWORD 'senha_app';
GRANT CONNECT ON DATABASE stega TO stega_app;
GRANT USAGE ON SCHEMA public TO stega_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stega_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stega_app;
```

Em desenvolvimento local, um único usuário com privilégios completos serve para ambos.

```bash
# .env
POSTGRESQL_URL=postgresql://stega_app:senha_app@localhost:5432/stega
POSTGRESQL_MIGRATION_URL=postgresql://stega_migrate:senha_migrate@localhost:5432/stega
```

---

## Schema da Stega — migrations

Cada migration é um arquivo SQL em `migrations/` seguindo a convenção
`NNN_descricao.sql` com marcadores `-- N up` e `-- N down`:

```sql
-- migrations/003_create_tickets.sql
-- 3 up
CREATE TABLE tickets (
    id              BIGSERIAL    PRIMARY KEY,
    product_id      BIGINT       NOT NULL REFERENCES products(id),
    author_id       UUID         NOT NULL REFERENCES users(id),
    assignee_id     UUID         REFERENCES users(id),
    title           TEXT         NOT NULL,
    body            TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'open',
    priority        TEXT         NOT NULL DEFAULT 'medium',
    custom_fields   JSONB,                    -- campos livres por produto
    search_vector   TSVECTOR,                 -- mantido por trigger
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX ON tickets (status);
CREATE INDEX ON tickets (product_id, status);

-- 3 down
DROP TABLE tickets;
```

---

## Busca em texto completo

```sql
-- Migration 004: índice e trigger para busca
-- 4 up
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
-- Busca em Perl/Mojo::Pg:
-- GET /api/v1/tickets?q=erro+login
SELECT id, title, status
FROM tickets
WHERE search_vector @@ plainto_tsquery('portuguese', $1)
ORDER BY ts_rank(search_vector, plainto_tsquery('portuguese', $1)) DESC;
```

---

## JSONB — quatro usos na Stega

```sql
-- 1. products.settings: configuração livre por produto
-- {"sla_hours": {"critical": 4}, "slack_channel": "#suporte"}
SELECT settings->>'slack_channel' FROM products WHERE id = $1;
SELECT settings->'sla_hours'->>'critical' FROM products WHERE id = $1;

-- 2. tickets.custom_fields: campos personalizados por produto
-- {"version": "2.3.1", "os": "Windows 11"}
SELECT custom_fields->>'version' FROM tickets WHERE id = $1;
SELECT * FROM tickets WHERE custom_fields @> '{"os": "Windows 11"}';

-- 3. comments.metadata: menções e anexos
-- {"mentions": ["uuid1"], "attachments": [{"name": "log.txt"}]}
SELECT metadata->'attachments' FROM comments WHERE id = $1;

-- 4. events.payload: log imutável de mudanças
-- {"old_status": "open", "new_status": "in_progress"}
SELECT payload->>'new_status' FROM events
WHERE ticket_id = $1 AND type = 'status.changed'
ORDER BY created_at DESC;

-- Índice GIN para consultas de containment (@>)
CREATE INDEX ON events USING GIN (payload);
```

---

## Comandos PostgreSQL úteis no dia a dia

```bash
# Conectar ao banco local (Docker)
docker compose exec postgres psql -U stega_migrate -d stega

# Listar tabelas
\dt

# Descrever uma tabela
\d tickets

# Sair
\q
```

```sql
-- Ver tamanho do banco e das tabelas
SELECT pg_size_pretty(pg_database_size('stega'));
SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::text))
FROM pg_tables WHERE schemaname = 'public';

-- Ver índices
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'tickets';

-- Verificar a última execução de uma query com EXPLAIN ANALYZE
EXPLAIN ANALYZE
SELECT * FROM tickets WHERE search_vector @@ plainto_tsquery('portuguese', 'erro login');
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `TEXT` vs `VARCHAR(n)` | PostgreSQL não tem diferença de performance entre eles | Use `TEXT` — sem limite arbitrário de comprimento |
| JSONB vs JSON | `JSON` armazena texto; `JSONB` é binário com índice e operadores | Sempre `JSONB` para dados consultáveis |
| `->` vs `->>` | `->` retorna JSONB; `->>` retorna TEXT | Use `->>'chave'` em comparações com texto |
| Migrations irreversíveis | `-- N down` com `DROP TABLE` perde dados | Mantenha downs para esquema; dados perdidos são esperados em rollback |
| Usuário único em produção | Um usuário com DDL+DML permite `DROP TABLE` acidental via app | Dois usuários: `stega_migrate` (DDL) e `stega_app` (DML apenas) |
| `now()` vs `CURRENT_TIMESTAMP` | Equivalentes, mas `now()` é mais idiomático no PostgreSQL | Use `DEFAULT now()` nas colunas de timestamp |
