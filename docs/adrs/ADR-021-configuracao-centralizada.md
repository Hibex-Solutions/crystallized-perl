# ADR-021: Configuração Centralizada — `Stega::Config`

**Status**: Aceita
**Data**: 2026-07-03

> **Nota 2026-07-04**: as variáveis `POSTGRESQL_APP_URL`/`POSTGRESQL_APP_USERNAME`/
> `POSTGRESQL_APP_PASSWORD`/`POSTGRESQL_APP_MIGRATION_USERNAME`/
> `POSTGRESQL_APP_MIGRATION_PASSWORD` abaixo já refletem a Revisão 2026-07-04 da
> [ADR-016](ADR-016-acesso-a-dados-relacional-mojo-pg.md) (formato explícito, sem
> credenciais embutidas na URL) — essa parte está **em vigor**. O restante da lista
> pode mudar se duas ADRs `Proposta` forem aceitas: a
> [ADR-022](ADR-022-filas-em-postgresql.md) remove a chave `rabbitmq`; a
> [ADR-023](ADR-023-topologia-de-instancias-postgresql.md) acrescenta
> `POSTGRESQL_JOBS_URL`/`_USERNAME`/`_PASSWORD` e, condicionalmente,
> `POSTGRESQL_EVENTS_URL`/`_USERNAME`/`_PASSWORD`.

## Contexto

A Stega lê dezenas de variáveis de ambiente (`KEYCLOAK_URL`, `KEYCLOAK_FRONTEND_URL`,
`KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `RABBITMQ_HOST`,
`RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `RABBITMQ_VHOST`, `RABBITMQ_PORT`,
`POSTGRESQL_APP_URL`, `POSTGRESQL_APP_USERNAME`, `POSTGRESQL_APP_PASSWORD`,
`POSTGRESQL_APP_MIGRATION_USERNAME`, `POSTGRESQL_APP_MIGRATION_PASSWORD`,
`STEGA_SECRET`, `TEST_JWT_SECRET`,
`GITHUB_WEBHOOK_SECRET`) espalhadas por `$ENV{...}` direto em Controllers, Jobs,
Workers e scripts de engenharia. Antes desta ADR:

- `Stega::Controller::Auth` lia `KEYCLOAK_*` de forma independente em quatro métodos
  (`login`, `callback`, `logout`, `change_password`), cada um reescrevendo a mesma
  cadeia de fallback
- `Stega::Job::SendWelcomeNotification` e `Stega::Worker::NotificationWorker` tinham
  literalmente os mesmos cinco `$ENV{RABBITMQ_*}` copiados
- `lib/Stega.pm`, `eng/migrate.pl` e `eng/seed.pl` cada um lia `POSTGRESQL_URL`/
  `POSTGRESQL_MIGRATION_URL` de forma independente

Isso cria risco real de divergência silenciosa: um nome digitado de forma
ligeiramente diferente (`KEYCLOAK_CLIENTE_ID` em vez de `KEYCLOAK_CLIENT_ID`, por
exemplo) não gera erro de compilação — apenas o valor nunca é lido, e o código
segue para o valor padrão sem aviso. Também não há um único lugar para auditar
quais variáveis de ambiente a aplicação de fato usa.

## Decisão

Um módulo `Stega::Config` com uma única função, `load()`, que lê todo `%ENV` da
aplicação **uma vez** e devolve um hashref estruturado por área (`postgresql`,
`rabbitmq`, `keycloak`, e chaves de nível superior para segredos avulsos). É o
único arquivo do código-fonte que contém a string literal de cada nome de
variável de ambiente.

Dois consumidores, dois padrões de uso:
- **A aplicação Mojolicious** (`lib/Stega.pm`) chama `Stega::Config::load()` uma
  vez em `startup()` e popula o atributo nativo `$self->config` (já existente em
  todo objeto `Mojolicious`, sem plugin necessário) — Controllers e helpers lêem
  `$c->app->config->{...}` daí em diante
- **Processos sem instância de app** (`eng/migrate.pl`, `eng/seed.pl`,
  `Stega::Worker::NotificationWorker`, executado via `eng/worker.pl`) chamam
  `Stega::Config::load()` diretamente

Onde o comportamento diverge entre consumidores de uma mesma variável — por
exemplo, `KEYCLOAK_URL` ausente derruba a validação JWT via JWKS
(`lib/Stega.pm::_decode_jwt_token`) mas as rotas de redirect web (`login`/
`logout`/`change_password`) caem para `http://localhost:8080` — o valor no
hashref fica **bruto** (sem default aplicado) e a decisão de morrer ou usar um
valor padrão continua no código que consome, não em `Stega::Config`. A única
exceção computada é `keycloak.frontend_url`, que já resolve a cadeia
`KEYCLOAK_FRONTEND_URL // KEYCLOAK_URL // 'http://localhost:8080'` — usada de
forma idêntica pelos três métodos que precisam dela.

## Justificativa

Mojolicious já expõe `config` como atributo nativo de qualquer aplicação — não é
preciso nenhum plugin ou dependência nova para ter um único ponto central de
configuração acessível via `$app->config`/`$c->app->config` em qualquer
Controller ([Mojolicious](../references/mojolicious.md)). `Mojolicious::Plugin::Config`
(também documentado ali) adiciona carregamento a partir de um arquivo `.conf` —
capacidade que a Stega não precisa, já que toda configuração já vem de variáveis
de ambiente, não de um arquivo versionado.

A escolha de manter a fonte de verdade em variáveis de ambiente — só centralizando
a *leitura*, não migrando para um arquivo de configuração — segue diretamente do
Fator III (Config) do [Twelve-Factor App](../references/twelve-factor-app.md), já
adotado como referência central do stack: configuração que varia entre implantações
pertence ao ambiente, não a um arquivo no repositório. `Stega::Config` é uma camada
de leitura, não uma camada de armazenamento — não introduz um arquivo `.conf` com
valores de produção, apenas nomeia e organiza o que já vinha de `%ENV`.

Um módulo próprio (em vez de depender só de `$app->config` do Mojolicious) foi
necessário porque parte dos consumidores (`eng/*.pl`, `NotificationWorker`) não têm
instância de aplicação Mojolicious — são processos standalone. `Stega::Config::load()`
funciona igualmente nos dois contextos, sem depender do ciclo de vida do Mojolicious.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Manter `$ENV{...}` espalhado** (status quo) | Risco de nomes digitados de forma inconsistente sem erro de compilação; nenhum lugar único para auditar quais variáveis a aplicação usa |
| **`Mojolicious::Plugin::Config` com arquivo `.conf`** | Resolveria a centralização para a aplicação, mas não para os scripts `eng/*.pl`/`NotificationWorker` (sem instância de app); adicionaria um arquivo de configuração ao repositório quando a fonte de verdade já é `%ENV` — tensão com o Fator III do Twelve-Factor App |
| **Unificar todos os defaults dentro de `Stega::Config`, inclusive os divergentes** | Testado e descartado: `KEYCLOAK_URL` tem comportamento genuinamente diferente entre consumidores (morrer vs. cair para `localhost`) por razões de segurança/DX distintas — forçar um único default apagaria essa distinção deliberada em vez de só centralizar a leitura |
| **Variável de ambiente única com JSON serializado** (`STEGA_CONFIG_JSON`) | Uma única variável esconde qual configuração existe atrás de um blob opaco; pior para auditabilidade do que várias variáveis nomeadas, mesmo centralizadas na leitura |

## Consequências

**Positivo**:
- Cada nome de variável de ambiente aparece exatamente uma vez no código-fonte
  (`lib/Stega/Config.pm`) — elimina o risco de nomes divergentes por digitação
- Um único arquivo documenta toda a configuração externa que a aplicação lê
- Zero dependência nova — usa o atributo `config` já nativo do Mojolicious
- Funciona igualmente para a aplicação (via `$app->config`) e para scripts
  standalone (via chamada direta a `Stega::Config::load()`)

**Negativo**:
- Uma camada de indireção a mais entre `%ENV` e o código que consome (aceitável
  dado o ganho de auditabilidade)
- Comportamentos genuinamente divergentes entre consumidores (como `KEYCLOAK_URL`)
  ainda exigem lógica própria em cada call site — `Stega::Config` centraliza a
  leitura, não decide sozinho o que fazer com um valor ausente

**Ações necessárias**:
- Criar `lib/Stega/Config.pm` com a função `load()`
- Atualizar `lib/Stega.pm` (`startup()`, `_setup_database`, `_decode_jwt_token`)
  para usar `$self->config`
- Atualizar `Stega::Controller::Auth` (`login`, `callback`, `logout`,
  `change_password`) e `Stega::Controller::Webhook` (`_verify_github_signature`)
  para usar `$c->app->config`
- Atualizar `Stega::Job::SendWelcomeNotification` (recebe `$app`, já disponível
  via `$job->app`) e `Stega::Worker::NotificationWorker` (chama
  `Stega::Config::load()` diretamente, sem instância de app)
- Atualizar `eng/migrate.pl` e `eng/seed.pl` para usar `Stega::Config::load()`
- Validado via suíte completa (75 testes, `Result: PASS`) e via `curl` contra a
  aplicação real em Docker: `/healthz`, redirect de sessão para `/login`, URL de
  redirect do Keycloak montada corretamente a partir de `keycloak.frontend_url`,
  e `NotificationWorker` conectando ao RabbitMQ via `Stega::Config` sem erro
