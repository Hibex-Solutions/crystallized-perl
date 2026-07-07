# ADR-023: Topologia de Instâncias PostgreSQL por Finalidade

**Status**: Proposta
**Data**: 2026-07-04

> Esta ADR está em avaliação. É ortogonal à [ADR-022](ADR-022-filas-em-postgresql.md)
> (que decide o *mecanismo* de filas) — esta decide a *topologia*: quantas
> instâncias PostgreSQL o stack provisiona e para quê. A separação de `db-jobs` não
> depende da ADR-022 ser aceita; a existência de `db-events` depende. Enquanto o
> status permanecer `Proposta`, o stack continua com uma única instância PostgreSQL
> compartilhada, como descrito hoje na ADR-016 e na nota "Minion" da ADR-008.

## Contexto

Hoje o stack usa uma única instância PostgreSQL para tudo: dados relacionais
(ADR-007), documentos JSONB (ADR-017) e a fila interna de jobs do Minion (ADR-008,
nota "Minion como alternativa simples") — a própria ADR-008 descreve isso como
vantagem: "usa a mesma instância `Mojo::Pg` da aplicação — sem novo serviço de
backing". Se a ADR-022 (proposta) for aceita, a fila multi-consumidor (PgQue)
também entraria nessa mesma instância por padrão.

Compartilhar uma única instância para perfis de carga tão diferentes tem um custo
que o próprio estudo anexo à ADR-022 já identificou (seção 8, citando a PlanetScale):
consultas transacionais da aplicação, uma fila de jobs de alto *churn* (muitos
`INSERT`/`UPDATE`/`DELETE` por segundo) e, potencialmente, um log de eventos de
fan-out competem pelos mesmos recursos de vacuum, WAL e I/O. Um problema em
qualquer uma dessas cargas — bloat descontrolado, um pico de tráfego, uma
migration mal calculada, um `VACUUM FULL` que trava a tabela — afeta as outras
duas, mesmo que sejam funcionalmente independentes.

## Decisão

Provisionar **uma instância PostgreSQL dedicada por finalidade**, em vez de uma
instância única compartilhada:

| Instância | Nome do banco (genérico — ver mapeamento concreto abaixo) | Conteúdo | Depende de |
|-----------|--------------|----------|------------|
| Aplicação | **`db-app`** | Dados relacionais (ADR-007) + documentos JSONB (ADR-017) | — |
| Fila de jobs interna | **`db-jobs`** | Schema do Minion (`minion_jobs` etc., ADR-008 nota) | — |
| Fila multi-consumidor | **`db-events`** | Schema do PgQue (ADR-022) | ADR-022 ser aceita |
| Keycloak | **`keycloak`** (não segue o padrão `db-{finalidade}` — ver seção própria abaixo) | Schema do próprio Keycloak (ADR-009) | — |

Mesmo motor (PostgreSQL 17, ADR-007) e mesmo mecanismo de acesso (`Mojo::Pg`,
ADR-016) em todas — isolamento é de **processo e recursos**, não de tecnologia.
Cada instância pode ter parâmetros de `autovacuum`, recursos (CPU/memória) e
política de backup ajustados independentemente conforme o perfil de carga real.

**A separação vale em qualquer ambiente, inclusive desenvolvimento — não é uma
otimização só de produção.** `docker compose` provisiona quatro serviços Postgres
**separados** (quatro containers distintos: `postgres-app`, `postgres-jobs`,
`postgres-events` se a ADR-022 for aceita, e `postgres-keycloak`), não um único
serviço com vários bancos dentro. Isso é uma mudança real em relação ao arranjo
atual: hoje um único serviço `postgres` hospeda tanto o banco da aplicação
(`stega`) quanto o do Keycloak (`keycloak`), criado por
`docker/postgres-init/01-keycloak-db.sql` no primeiro boot (ADR-018). O motivo de
exigir isso também em desenvolvimento, e não só em produção, é paridade
dev/produção (Fator X do Twelve-Factor App, já citado como princípio na
ADR-014): se o isolamento de falha é o objetivo (ver Justificativa), ele precisa
ser observável e testável localmente, não só existir num ambiente que o time
raramente reproduz de perto.

Naming: `db-{finalidade}` neste documento é um **placeholder genérico**, no mesmo
espírito de `myapp` nas demais ADRs (ex.: `myapp_app`/`myapp_migrate` na ADR-016) —
não um prefixo literal fixo. Cada aplicação concreta substitui `db` pelo próprio
nome de projeto. Na Stega (ADR-018), os três bancos são:

| Genérico (esta ADR) | Concreto (Stega) |
|---------------------|-------------------|
| `db-app` | **`stega-app`** |
| `db-jobs` | **`stega-jobs`** |
| `db-events` | **`stega-events`** |

O nome é do **banco** dentro do container, não necessariamente do serviço Compose/
Kubernetes — um serviço chamado `postgres-app` pode hospedar um banco chamado
`stega-app`; o serviço descreve "o que é" (um Postgres), o banco descreve "de quem
é e para quê".

Nomeado pela função do dado, não pela ferramenta que a implementa hoje: se o Minion
for substituído por outra fila de jobs no futuro, ou o PgQue por outro mecanismo de
eventos, o nome do banco continua correto sem renomear nada — só o conteúdo interno
muda.

### Keycloak — instância própria e dedicada

O banco do Keycloak nunca esteve no escopo da ADR-022 nem da decisão original
desta ADR — mas precisava de um destino explícito, porque o container
`postgres` único de hoje (que hospeda `stega` e `keycloak` juntos) deixa de
existir como tal. **Decisão**: `postgres-keycloak`, uma instância própria e
dedicada — nenhum banco além de `keycloak` vive nela, e ela não compartilha
container com `postgres-app` nem com nenhuma outra instância. Isolamento total,
mesmo raciocínio de isolamento de falha que motiva o restante desta ADR,
aplicado também à autenticação: um problema em `postgres-app` (ou vice-versa)
não afeta a capacidade dos usuários de fazer login.

Diferente de `db-app`/`db-jobs`/`db-events`, o banco `keycloak` **não segue** a
convenção de nomenclatura `db-{finalidade}`/`stega-{finalidade}` desta ADR —
continua se chamando literalmente `keycloak`, porque não é um banco "nosso" (da
Stega), é do Keycloak. A credencial também não segue o padrão
`POSTGRESQL_{SUFIXO}_*` desta ADR: o Keycloak já tem suas próprias variáveis
(`KC_DB_URL`, `KC_DB_USERNAME`, `KC_DB_PASSWORD`, já existentes no `compose.yml`
de hoje) — só o host nelas muda, de `postgres` para `postgres-keycloak`.

### Portas de host no Docker Compose (desenvolvimento)

Com quatro instâncias Postgres separadas, cada uma expõe uma porta de host
**distinta**, para inspeção via `psql`/ferramenta gráfica local sem precisar de
`docker compose exec`:

| Instância | Porta no host |
|-----------|--------------|
| `postgres-app` | `55432` |
| `postgres-jobs` | `55433` |
| `postgres-events` (se ADR-022 aceita) | `55434` |
| `postgres-keycloak` | `55435` |

Nenhuma dessas portas é usada pela comunicação entre containers — isso
acontece pela rede interna do Docker, usando o nome do serviço como host (ex.:
`postgres-app:5432`, sempre na porta **interna** padrão 5432, independente da
porta de host mapeada). As portas de host são só conveniência para quem
desenvolve, não uma exigência técnica da aplicação.

### Credenciais por instância — um modelo por finalidade, não um modelo único

A ADR-016 estabelece um usuário DDL (`_migrate`) e um usuário DML (`_app`) por
banco, para proteger dados de negócio de alterações de schema acidentais vindas de
um bug na aplicação. Essa regra **continua valendo, sem alteração, só para
`db-app`** — é lá que vivem os dados relacionais e JSONB que essa proteção existe
para defender.

`db-jobs` e `db-events` são instâncias de propósito único: nenhuma delas guarda
dado de negócio, cada uma tem exatamente um "inquilino" (o schema do Minion, ou o
schema do PgQue) e nenhum outro sistema compartilha essas bases. O risco que a
separação DDL/DML mitiga em `db-app` — a aplicação alterar schema por acidente —
tem raio de explosão irrelevante ali: na pior hipótese, um bug corrompe o schema da
própria fila, não dados de negócio. Por isso, a decisão desta ADR é usar **uma
única credencial por instância**, com privilégios completos (dono do banco,
DDL+DML) **escopados àquele banco específico** — não um superusuário do cluster
PostgreSQL, que seguiria sendo privilégio desnecessário mesmo aqui:

| Instância | Credencial | Escopo |
|-----------|-----------|--------|
| `db-app` | **A** (migração) + **B** (execução) | Dois usuários, DDL/DML separados — ADR-016 inalterada |
| `db-jobs` | **C** (única) | Dono do banco `db-jobs`; `Minion::Backend::Pg` usa essa mesma credencial tanto para migrar seu próprio schema na primeira conexão quanto para operar em seguida — nenhum passo de migração separado é necessário |
| `db-events` | **D** (única) | Dono do banco `db-events`; usada tanto para instalar `pgque.sql`/conceder os papéis internos do PgQue (`pgque_reader`/`writer`/`admin`) quanto para `send`/`receive`/`ack` em tempo de execução |

Como só existe uma credencial em `db-jobs`/`db-events`, não há necessidade de
validar o comportamento de automigração do `Minion::Backend::Pg` contra um usuário
DML-only — a mesma credencial cobre os dois momentos, sem conflito.

**`db-events` ainda precisa de um passo de inicialização — idempotente, mas
explicitamente separado do de migration.** Diferente do Minion, o
PgQue **não** se autoinstala na primeira conexão: `pgque.sql` precisa ser executado
explicitamente antes do primeiro `send`/`receive`. A decisão é tratar essa
instalação como um passo idempotente no pipeline de implantação — **o mesmo
mecanismo** que `eng/migrate.pl`/InitContainer já usa para `db-app` (roda a cada
implantação, mas só tem efeito da primeira vez) — em vez de uma ação manual única
por ambiente. Reaproveitar o mecanismo não significa reaproveitar o script, o
InitContainer ou o serviço: são dois processos com nomes próprios e propósitos
diferentes, e cada um deve continuar sendo chamado exatamente pelo que faz —
"instalar o PgQue" não é "aplicar migrations do domínio", mesmo que ambos sejam
passos idempotentes de inicialização:

| | Migration do domínio (ADR-016, inalterada) | Bootstrap do PgQue (novo) |
|---|---|---|
| Script | `eng/migrate.pl` | `eng/bootstrap_pgque.pl` |
| Instância | `db-app` | `db-events` |
| InitContainer (Kubernetes) | `migrate` | `bootstrap-pgque` |
| Serviço (Docker Compose) | `migrate` | `bootstrap-pgque` |
| O que aplica | Schema de domínio (`migrations/N/up.sql`) | `pgque.sql` + papéis `pgque_reader`/`writer`/`admin` |

Consequência prática: `db-jobs` **não precisa** de um passo de inicialização
equivalente (o worker Minion migra a si mesmo ao conectar, sem coordenação externa
necessária) — só `db-events` tem esse passo extra, e ele nunca deve aparecer como
uma entrada dentro de `migrations/` nem reaproveitar o InitContainer/serviço
`migrate` existente.

### Conexões da aplicação — um `Mojo::Pg` por instância, nunca reaproveitado

Três instâncias com credenciais próprias implicam **três objetos `Mojo::Pg`
independentes** dentro do mesmo processo Stega — nunca uma conexão só,
reaproveitada para tudo:

| Uso | Instância | Credencial | Registrado onde |
|---|---|---|---|
| `$app->pg` (existente, ADR-016) | `db-app` | B (execução) | `Stega.pm::startup` |
| Backend do Minion (`$self->plugin('Minion', Pg => ...)`) | `db-jobs` | C | `Stega.pm::startup` — **não** `Pg => $self->pg` |
| `$app->pg_events` (novo, ADR-022) | `db-events` | D | `Stega.pm::startup`, só se ADR-022 for aceita |

Cada um é uma conexão Postgres comum — string de conexão + credencial — sem nenhum
vínculo entre si além do código da aplicação manter os três *handles* abertos ao
mesmo tempo. Isso confirma diretamente o cenário de infraestrutura heterogênea que
motiva esta ADR: `db-app` pode estar num RDS da AWS, `db-jobs` num Postgres dentro
do próprio cluster Kubernetes, e `db-events` num Cloud SQL da GCP — nenhuma das
três instâncias sabe da existência das outras, e a aplicação simplesmente abre três
conexões distintas, cada uma para seu próprio destino, com sua própria credencial.
Não há federação, proxy ou túnel entre instâncias — é justamente a ausência disso
que permite essa flexibilidade.

**Mudança concreta em relação ao código de hoje**: a
[ADR-008 (nota "Minion")](ADR-008-message-broker-rabbitmq.md) e o
[Guia 8](../guides/08-rabbitmq-e-minion.md) registram o Minion hoje com
`$self->plugin('Minion', Pg => $self->pg)` — reaproveitando a mesma instância
`Mojo::Pg` da aplicação, porque hoje só existe uma instância PostgreSQL para tudo.
Se esta ADR for aceita, isso deixa de ser correto: o Minion passa a exigir sua
própria instância `Mojo::Pg`, construída a partir de `POSTGRESQL_JOBS_URL` +
credencial C — nunca `$self->pg`. É uma mudança pequena no código, mas fácil de
esquecer, e do tipo que só aparece em produção: em desenvolvimento, se `db-app` e
`db-jobs` apontarem para o mesmo servidor por descuido de configuração, o bug fica
mascarado (tudo continua funcionando, só que sem o isolamento que esta ADR existe
para garantir).

### Variáveis de ambiente

Segue o formato explícito da Revisão 2026-07-04 da ADR-016: `POSTGRESQL_{SUFIXO}_URL`
carrega só servidor, porta e nome do banco (**nunca** credenciais — cada instância
pode estar em infraestrutura completamente diferente: RDS, on-premises, dentro do
próprio cluster), e `POSTGRESQL_{SUFIXO}_USERNAME`/`_PASSWORD` carregam a
credencial. `db-app` é só mais um sufixo (`APP`), não um caso especial sem prefixo:

| Instância | Sufixo | Variáveis | Credencial |
|-----------|--------|-----------|-----------|
| `db-app` | `APP` | `POSTGRESQL_APP_URL`, `POSTGRESQL_APP_USERNAME`/`_PASSWORD` (execução, B) + `POSTGRESQL_APP_MIGRATION_USERNAME`/`_PASSWORD` (migração, A) | B / A |
| `db-jobs` | `JOBS` | `POSTGRESQL_JOBS_URL`, `POSTGRESQL_JOBS_USERNAME`/`_PASSWORD` | C |
| `db-events` (se ADR-022 aceita) | `EVENTS` | `POSTGRESQL_EVENTS_URL`, `POSTGRESQL_EVENTS_USERNAME`/`_PASSWORD` | D |

`db-jobs`/`db-events` têm só um par usuário/senha cada (sem variante `_MIGRATION_*`)
porque usam credencial única (ver seção "Credenciais por instância"). Total: 5
variáveis para `db-app` + 3 para `db-jobs` + 3 para `db-events` = 11 (ou 8 se a
ADR-022 não for aceita).

Nota prática: `db-app`, `db-jobs` e `db-events` contêm hífen — identificadores
Postgres com hífen exigem aspas duplas em SQL literal (`CREATE DATABASE "db-app";`).
Isso não afeta a *connection URL* (o nome do banco é só um segmento de caminho ali),
só os comandos de criação/administração executados diretamente em SQL.

## Justificativa

Referências: [PostgreSQL](../references/postgresql.md), [Mojo::Pg](../references/mojo-pg.md),
[Minion](../references/minion.md), [Kubernetes](../references/kubernetes.md).

O achado central do estudo anexo à ADR-022 (seção 8, PlanetScale — "In a 'just use
Postgres' world where queues, analytics, and application logic share a single
database, this is not a theoretical risk" — tradução: "Num mundo de 'apenas use o
Postgres', onde filas, analytics e lógica de aplicação compartilham um único banco
de dados, isso não é um risco teórico") já apontava para isolamento de carga
como mitigação. Esta ADR formaliza essa mitigação como topologia padrão do stack,
em vez de deixá-la como uma otimização a considerar só se/quando o volume crescer.

Isolar por **processo** (instância dedicada), não só por **schema** dentro do mesmo
processo, é a diferença que garante que um evento de falha real — um `VACUUM FULL`
que bloqueia a tabela, um pico de tráfego na fila, uma conexão presa numa
transação longa — não se propague para os outros dois domínios de dado. Separar
só por schema reduziria conflito de nomenclatura e permissões, mas não isolaria
recursos de processo (CPU, memória, WAL, checkpoint), que é exatamente o problema
que o achado da PlanetScale descreve.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Instância única compartilhada** (situação atual) | Acopla o risco de falha entre domínios de dado independentes — um problema de vacuum/WAL na fila afeta a API e os dados de negócio, e vice-versa |
| **Um único Postgres com schemas separados por finalidade** | Isola nomenclatura e permissões, mas não isola processo/recursos — um `VACUUM FULL` ou pico de carga em um schema ainda compete por CPU, memória, WAL e checkpoint com os outros. Não resolve o problema central identificado no estudo da ADR-022 |
| **Uma instância por entidade/domínio de negócio** (granularidade maior — ex.: um Postgres só para `tickets`, outro só para `users`) | Complexidade desproporcional ao problema; o eixo que importa aqui é *perfil de carga* (transacional vs. fila de alto churn), não separação por entidade de domínio |
| **Nomear bancos pela tecnologia** (`db-minion`, `db-pgque`) | Inconsistente com `db-app` (nomeado pela função); obrigaria renomear se a ferramenta por trás de cada fila mudar no futuro |
| **Instância única em desenvolvimento por conveniência, separadas só em produção** | Quebraria a paridade dev/produção que motiva a separação em primeiro lugar (Fator X do Twelve-Factor App) — um bug de bloat/vacuum causado pela mistura de cargas nunca apareceria localmente, só em produção, exatamente o cenário que esta ADR existe para evitar |
| **Keycloak junto de `postgres-app`** (menor mudança em relação ao arranjo atual) | Rejeitada em favor de instância própria (`postgres-keycloak`) — o mesmo raciocínio de isolamento de falha que motiva separar `db-jobs`/`db-events` de `db-app` se aplica à autenticação: um incidente em `postgres-app` não deveria conseguir derrubar login de usuários, e vice-versa |

## Consequências

**Positivo**:
- Isolamento real de falha: um problema de vacuum/WAL/carga numa fila não afeta a
  disponibilidade da API nem dos dados de negócio, e vice-versa
- Permite tuning de `autovacuum`, recursos e política de backup independente por
  instância, conforme o perfil de carga real de cada uma
- Nomenclatura por função (`db-jobs`/`db-events`) sobrevive a troca de ferramenta —
  se o Minion ou o PgQue forem substituídos no futuro, o nome do banco continua fazendo sentido
- Caminho natural e antecipado para a mitigação de conflito de vacuum/WAL entre
  cargas que o próprio estudo da ADR-022 já identificava como risco
- Uma credencial por instância de fila (`db-jobs`/`db-events`), em vez de duas —
  menos segredos a provisionar e rotacionar do que uma primeira leitura do padrão
  da ADR-016 sugeriria, sem abrir mão do isolamento de processo que é o objetivo
  central desta ADR
- `db-jobs` não precisa de nenhum passo de inicialização/InitContainer — o Minion
  migra a si mesmo ao conectar; a única credencial cobre migração e execução sem
  coordenação externa

**Negativo**:
- Multiplica o número de instâncias PostgreSQL a provisionar (de 1 para 3 —
  `postgres-app`, `postgres-jobs`, `postgres-keycloak` —, ou para 4 se a
  ADR-022 também for aceita, com `postgres-events`) — mais segredos, mais
  conectividade de rede a configurar e monitorar, mesmo sendo o mesmo motor em
  todas
- Ambiente de desenvolvimento local fica mais pesado (mais serviços no Docker
  Compose)
- Reduz a simplicidade "sem novo serviço de backing" que hoje é um argumento a favor
  do Minion (ADR-008, nota) — passa a ser tecnicamente um novo serviço de
  infraestrutura (`db-jobs`), ainda que rodando o mesmo motor já conhecido
- Em `db-jobs` e `db-events`, a mesma credencial que opera em tempo de execução
  também tem DDL — diferente de `db-app`, um bug na aplicação poderia alterar o
  schema dessas duas instâncias. Aceito conscientemente porque nenhuma delas guarda
  dado de negócio (ver seção "Credenciais por instância")
- `db-events` precisa de um script de bootstrap idempotente para o `pgque.sql` —
  uma peça de infraestrutura nova que não existe hoje em nenhuma das instâncias
- Código da aplicação passa a manter até três instâncias `Mojo::Pg` simultâneas
  (`$app->pg`, backend do Minion, `$app->pg_events`) em vez de uma só — mais
  superfície para confundir qual conexão usar onde (ver seção "Conexões da
  aplicação")

**Ações necessárias** *(somente quando esta ADR for aceita — nenhuma executada agora)*:
- Atualizar `Stega.pm::startup`: registrar o Minion com uma instância `Mojo::Pg`
  própria para `db-jobs` (`POSTGRESQL_JOBS_URL` + credencial C) — **parar** de
  reaproveitar `Pg => $self->pg`; se a ADR-022 também for aceita, registrar o
  helper `$app->pg_events` para `db-events` (`POSTGRESQL_EVENTS_URL` + credencial D)
- Definir `compose.yml` da Stega com quatro serviços Postgres **separados**
  (containers distintos, não um único serviço com vários bancos): `postgres-app`
  (banco `stega-app`, porta de host `55432`), `postgres-jobs` (banco
  `stega-jobs`, porta `55433`), condicionalmente `postgres-events` (banco
  `stega-events`, porta `55434`), e `postgres-keycloak` (banco `keycloak`,
  porta `55435`) — substitui o único serviço `postgres` de hoje. Atualizar
  `KC_DB_URL` do serviço `keycloak` para apontar para `postgres-keycloak` (host
  interno, não a porta de host) em vez de `postgres`
- Definir manifests Kubernetes: um recurso de banco por instância, com
  `POSTGRESQL_{SUFIXO}_URL` em `ConfigMap` (não é segredo) e
  `POSTGRESQL_{SUFIXO}_USERNAME`/`_PASSWORD` (e `_MIGRATION_USERNAME`/`_PASSWORD`
  só para `APP`) em `Secret`
- Criar `eng/bootstrap_pgque.pl` para `db-events` — mesmo mecanismo de passo
  idempotente do `eng/migrate.pl` da ADR-016, mas script, InitContainer
  (`bootstrap-pgque`) e serviço Compose (`bootstrap-pgque`) **próprios**, nunca uma
  entrada dentro de `migrations/` nem reaproveitando o InitContainer/serviço
  `migrate` existente
- Atualizar ADR-008/ADR-016 (a frase "mesma instância... sem novo serviço de
  backing" deixa de ser verdadeira) e ADR-018 (Stega) para refletir as instâncias
  separadas
- Atualizar Guias 5, 8 e 9 e o `Stega::Config` (ADR-021) com as novas variáveis de
  ambiente (`POSTGRESQL_JOBS_URL`/`_USERNAME`/`_PASSWORD`,
  `POSTGRESQL_EVENTS_URL`/`_USERNAME`/`_PASSWORD`)
