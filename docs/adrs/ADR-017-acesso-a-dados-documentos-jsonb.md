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

## Revisão 2026-07-04 — `->expand` era aspiracional; escrita real não usa `{ json => ... }`

Ao investigar um bug relatado na Stega (colunas JSONB — `products.settings`,
`tickets.custom_fields`, `comments.metadata`, `events.payload` — voltando como string
JSON crua nas respostas da API em vez de objeto aninhado), confirmei que esta ADR
descrevia `->expand` como prática já adotada, mas a implementação real nunca chamava
esse método: todo `Stega::Repository::Pg::{Product,Comment,Ticket}` usava `->hash`/
`->hashes` puro. O único ponto que precisava do dado desserializado
(`Ticket::list_events`, para expor `payload` de eventos) contornava a lacuna com um
`decode_json` manual linha a linha em vez de usar o recurso nativo do Mojo::Pg — o
próprio comentário no código antigo já registrava não saber da alternativa.

**Corrigido**: `->expand->hash` / `->expand->hashes` em toda leitura das três classes
(inclusive nas que não tocam coluna JSONB — `expand` é no-op nesse caso, e aplicar de
forma uniforme evita ter que auditar query por query e esquecer alguma no futuro). O
`decode_json` manual em `list_events` foi removido. Validado via suíte automatizada
(`t/020_products_api.t` — o teste antes documentava o bug com `like`/regex esperando
string crua, agora afirma `/data/settings/sla_hours/critical` como valor numérico
aninhado) e via Docker Compose completo.

**Escrita real diverge do exemplo `{ json => ... }` desta ADR**: nenhum
`Stega::Repository::Pg::*` usa esse açúcar. O padrão real é `encode_json()` explícito
do Perl antes do bind, com cast `::jsonb` explícito na própria query:

```perl
# lib/Stega/Repository/Pg/Product.pm — padrão real, não { json => ... }
my $settings_json = $attrs{settings} ? encode_json($attrs{settings}) : undef;

$self->db->query(
    'INSERT INTO products (name, slug, description, settings)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
    $attrs{name}, $attrs{slug}, $attrs{description}, $settings_json
)->expand->hash;
```

Motivo observado no código real: colunas JSONB nesta aplicação são opcionais, e o
padrão condicional (`$attrs{settings} ? encode_json(...) : undef`) para decidir entre
serializar e `NULL` é mais direto de auditar ao lado do resto dos binds do que embutir
a mesma condicional dentro de um valor `{ json => ... }`.

O exemplo de schema também foi corrigido para refletir a convenção real de migração
(ADR-016, revisão 2026-07-02 — `from_dir`, um diretório numerado por migração, não um
arquivo único `NNN_descricao.sql`):

```sql
-- migrations/6/up.sql (evento real da Stega — Mojo::Pg::Migrations, from_dir)
CREATE TABLE events (
    id          BIGSERIAL    PRIMARY KEY,
    ticket_id   BIGINT       NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id    UUID         REFERENCES users(id),
    type        TEXT         NOT NULL,
    payload     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ON events (ticket_id);
CREATE INDEX ON events (type);
CREATE INDEX ON events USING GIN (payload);
```

Os demais exemplos desta ADR (`?` como placeholder, `jsonb_set`, operadores `@>`/`#>`/
`?`) permanecem ilustrativos e genéricos, no mesmo estilo já usado pela ADR-016 — a
Stega usa `$1, $2, ...` (bind posicional do Postgres) em vez de `?`, mas isso não é uma
divergência de decisão, só de estilo de exemplo entre ADR e código real.

## Revisão 2026-07-04 (continuação) — a divergência acima era um bug, não um padrão

**A seção "Escrita real diverge do exemplo `{ json => ... }`" acima estava errada** —
não descrevia uma escolha deliberada da Stega, descrevia um **bug real de dupla
codificação UTF-8**, achado pelo usuário navegando na aplicação (badge "via Webhook" no
histórico de um ticket mostrando `GenÃ©rico Teste 030` em vez de `Genérico Teste 030`;
confirmado via `octet_length`/`length` no Postgres que o dado já saía corrompido na
escrita, não era exibição).

**Causa raiz**: `encode_json()` do `Mojo::JSON` devolve uma string de bytes já
codificados em UTF-8 (sem a flag `utf8` do Perl). Passar essa string como bind
parameter para um placeholder com cast `::jsonb` explícito, com `pg_enable_utf8` ativo
(padrão do Mojo::Pg), faz o DBD::Pg tratá-la como uma string "wide char" ainda não
codificada e codificá-la **de novo** — cada caractere acentuado (2 bytes em UTF-8) vira
4 bytes. Confirmado isolando as duas formas lado a lado no mesmo banco: `encode_json(...)`
+ `::jsonb` → corrompido; `{ json => ... }` (o exemplo *original* desta ADR, antes da
revisão anterior) → correto.

**Ou seja: o exemplo original desta ADR sempre esteve certo.** O padrão real da Stega
divergia dele por um bug, não por uma decisão melhor. Corrigido em todos os pontos
afetados (`Stega::Repository::Pg::Product`, `::Comment`, `::Ticket`, e
`Stega::Job::CheckSlaBreaches`) para usar `{ json => ... }`, exatamente como esta ADR
já recomendava:

```perl
# lib/Stega/Repository/Pg/Product.pm — corrigido, agora bate com o exemplo desta ADR
my $settings = $attrs{settings} ? { json => $attrs{settings} } : undef;

$self->db->query(
    'INSERT INTO products (name, slug, description, settings)
     VALUES ($1, $2, $3, $4) RETURNING *',
    $attrs{name}, $attrs{slug}, $attrs{description}, $settings
)->expand->hash;
```

Note que o cast `::jsonb` explícito também saiu — desnecessário com `{ json => ... }`,
que já informa ao driver o tipo do parâmetro.

Regressão coberta por testes novos que criam registros com acentuação em campo JSONB e
conferem o valor exato via API (`t/020_products_api.t`, `t/010_tickets_api.t`) — antes
desta correção, teriam falhado. Validado contra a aplicação real em Docker nos quatro
pontos corrigidos, comparando `octet_length`/`length` diretamente no Postgres antes e
depois. Suíte completa da Stega revalidada (89 testes, `Result: PASS`).

Não afetado por este bug (nenhuma mudança necessária): `eng/seed.pl` usa
`'{...}'::jsonb` como **literal embutido na própria string SQL**, não como bind
parameter — mecanismo diferente, sem o mesmo risco (confirmado: a `description` do
produto do seed, com "ç"/"ã", já batia `octet_length` correto antes desta correção).
`Stega::Notification::publish` serializa o payload via `{json => ...}` do próprio
`Mojo::Pg` para `pgque.send()` (ADR-022), não via `JSON::PP::encode_json` manual —
contexto diferente do bug de bind de banco descrito acima.
