# ADR-017: Acesso a Dados de Documentos — PostgreSQL JSONB

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

O stack precisa suportar dados semi-estruturados ou com schema flexível: payloads de
eventos heterogêneos, configurações dinâmicas por tenant, metadados extensíveis em
entidades relacionais. A abordagem tradicional seria introduzir um banco de documentos
(MongoDB, CouchDB) como segundo serviço de backing. Essa decisão avalia se o
PostgreSQL — já presente no stack (ADR-007) — pode cobrir esse caso de uso com
qualidade suficiente.

## Decisão

**PostgreSQL JSONB via Mojo::Pg** para todos os casos de uso de dados de documento.
Nenhum banco de documentos separado é introduzido no stack.

## Justificativa

O tipo `JSONB` do PostgreSQL armazena documentos JSON em formato binário indexável. Com
índices `GIN` é possível executar queries eficientes sobre campos internos de documentos
heterogêneos usando operadores nativos como `@>` (containment), `#>` (path), `?`
(key existence) e funções como `jsonb_array_elements`. A performance de queries JSONB
com GIN indexes é comparável à de bancos de documentos dedicados para os padrões de
acesso típicos de APIs web.

A decisão por JSONB elimina a necessidade de um segundo serviço de banco de dados no
stack, com os seguintes benefícios diretos para a infraestrutura:

- **Um único container de banco** no Docker Compose e no Kubernetes
- **Backup e restore unificados**: um `pg_dump` cobre dados relacionais e documentais
- **Transactions ACID entre dados relacionais e documentais**: é possível, em uma
  única transação, atualizar uma linha SQL e um documento JSONB na mesma operação
- **Sem driver adicional**: Mojo::Pg (ADR-016) já lida com JSONB nativamente

Referências: [PostgreSQL](../references/postgresql.md),
[Mojo::Pg](../references/mojo-pg.md),
[Mango (alternativa rejeitada)](../references/mango.md),
[DocumentDB (alternativa rejeitada)](../references/documentdb.md)

### Schema: coluna JSONB em tabela existente

```sql
-- migrations/004_create_events.sql
-- (arquivo separado — ver ADR-016 sobre a convenção de múltiplos arquivos)

-- 4 up
-- Tabela de eventos com schema 100% flexível
CREATE TABLE events (
    id         BIGSERIAL    PRIMARY KEY,
    type       TEXT         NOT NULL,
    payload    JSONB        NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ON events (type);
CREATE INDEX ON events USING GIN (payload);

-- 4 down
DROP TABLE events;
```

### Escrita de documentos

```perl
# Inserir evento com payload heterogêneo
$self->pg->db->query(
    'INSERT INTO events (type, payload) VALUES (?, ?)',
    'user.created',
    { json => { user_id => 42, plan => 'pro', source => 'signup_form' } }
);

# Atualizar campo JSONB (merge parcial)
$self->pg->db->query(
    q{UPDATE posts SET metadata = metadata || ? WHERE id = ?},
    { json => { featured => \1, views => 0 } },
    $post_id
);
```

O Mojo::Pg usa `{ json => ... }` para serializar automaticamente estruturas Perl para
JSONB, sem necessidade de `encode_json` manual.

### Queries sobre documentos

```perl
# @> : containment — eventos do tipo user.created com plano 'pro'
my $events = $self->pg->db->query(
    q{SELECT id, payload, created_at
      FROM events
      WHERE type = ? AND payload @> ?
      ORDER BY created_at DESC
      LIMIT 50},
    'user.created',
    { json => { plan => 'pro' } }
)->expand->hashes;

# #> : path query — extrair campo aninhado
my $plans = $self->pg->db->query(
    q{SELECT payload #>> '{subscription,plan}' AS plan, COUNT(*) AS total
      FROM events
      WHERE type = 'user.created'
      GROUP BY plan}
)->hashes;

# ? : verificar existência de chave
my $featured = $self->pg->db->query(
    q{SELECT id, title FROM posts WHERE metadata ? 'featured'}
)->hashes;
```

O método `->expand` instrui o Mojo::Pg a deserializar automaticamente colunas JSONB
para estruturas Perl (hashrefs e arrayrefs), sem `decode_json` manual.

### Atualização atômica de campos

```perl
# jsonb_set: atualizar um campo sem sobrescrever o documento inteiro
$self->pg->db->query(
    q{UPDATE events
      SET payload = jsonb_set(payload, '{processed}', 'true')
      WHERE id = ?},
    $event_id
);
```

### Quando usar JSONB vs. colunas SQL normais

| Situação | Abordagem |
|---------|-----------|
| Dados com schema fixo e conhecido | Colunas SQL tipadas |
| Dados semi-estruturados com campos variáveis | Coluna JSONB com índice GIN |
| Payload de eventos (schema por tipo) | Tabela de eventos com coluna JSONB |
| Configurações por tenant/usuário | Coluna JSONB em tabela de configurações |
| Dados que precisam de JOIN relacional | Colunas SQL normais (JSONB não faz JOIN eficiente) |

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **MongoDB** (driver oficial Perl) | Segundo serviço de backing a operar; licença SSPL restritiva; driver oficial Perl é síncrono (bloqueia o event loop do Mojo) |
| **DocumentDB + Mango** | DocumentDB é extensão nova (maturidade a verificar); Mango está abandonado (incompatível com Perl 5.38+); adiciona complexidade sem benefício sobre JSONB nativo |
| **Colunas TEXT com JSON serializado manualmente** | Sem indexação, sem operadores nativos, sem validação de tipo — essencialmente o que o JSONB resolve, mas pior |
| **CouchDB** | Serviço separado; ecossistema Perl muito limitado; sem transações ACID |

## Consequências

**Positivo**:
- Zero serviços adicionais: dados documentais no mesmo PostgreSQL dos dados relacionais
- Transações ACID entre dados relacionais e documentais na mesma operação
- Backup unificado: `pg_dump` cobre tudo
- `{ json => ... }` serializa Perl → JSONB na escrita; `->expand` deserializa JSONB → Perl na leitura

**Negativo**:
- JSONB não é otimizado para queries que percorrem arrays muito grandes de documentos
  sem discriminação por tipo/índice (caso de uso de analytics — fora do escopo)
- Schema flexível requer disciplina da aplicação: o banco não rejeita documentos
  malformados (recomendado usar validação via `JSON Schema` ou `CHECK CONSTRAINT`)

**Ações necessárias**:
- Criar índices GIN em todas as colunas JSONB que receberão queries por campos internos
- Usar `{ json => ... }` para escrita e `->expand` para leitura com Mojo::Pg
- Documentar as convenções de schema de cada tipo de evento em `docs/references/` ou
  como JSON Schema inline nos guias
