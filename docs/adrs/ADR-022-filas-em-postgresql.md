# ADR-022: Filas em PostgreSQL — Revogação do RabbitMQ

**Status**: Proposta
**Data**: 2026-07-04

> Esta ADR está em avaliação. Enquanto o status permanecer `Proposta`, a
> [ADR-008](ADR-008-message-broker-rabbitmq.md) (RabbitMQ) continua `Aceita` e em
> vigor — nada nesta ADR entra em efeito até que o usuário a aceite (ver revisão
> 2026-07-04 da [ADR-000](ADR-000-padrao-de-adrs.md)). O estudo técnico completo que
> fundamenta esta proposta — prós, contras, armadilhas, opções descartadas e
> impacto detalhado no repositório e na Stega — está em
> [`references/ADR-022-estudo-filas-postgresql.md`](references/ADR-022-estudo-filas-postgresql.md).
> Esta ADR decide o **mecanismo** de filas; a topologia de instâncias (quantos
> Postgres, um por finalidade) é decidida separadamente na
> [ADR-023](ADR-023-topologia-de-instancias-postgresql.md) — também `Proposta`.

## Contexto

A [ADR-008](ADR-008-message-broker-rabbitmq.md) define RabbitMQ, acessado via
`Net::AMQP::RabbitMQ`, como message broker do stack — usado para o papel de log de
eventos multi-consumidor (fan-out) que o Minion (fila de jobs interna, já em
PostgreSQL) não cobre.

Na prática, essa decisão tem um problema recorrente e documentado: `Net::AMQP::RabbitMQ`
é um módulo XS que embute a biblioteca C `librabbitmq`, e **não compila em Windows**
— falha de link (`undefined reference to 'poll'`), não de teste, sem flag que
contorne. Isso já é uma exceção registrada no [Guia 8](../guides/08-rabbitmq-e-minion.md)
(rodar o worker via Docker Compose no Windows, enquanto o resto da aplicação roda
com Perl nativo). Nenhuma alternativa Perl resolve isso sem trocar um problema por
outro: `Mojo::RabbitMQ::Client` está arquivado (2025-01-24, sem manutenção desde
2019); `AnyEvent::RabbitMQ` é pure-Perl no protocolo, mas sua interface síncrona
usual (`Net::RabbitFoot`) depende de `Coro` — outro módulo XS com histórico
problemático no Windows. O levantamento completo, incluindo issues do GitHub que
confirmam esse problema fora do nosso ambiente, está na seção 1 do estudo anexo.

Ao mesmo tempo, o stack já **prova**, em produção, que PostgreSQL sozinho resolve
fila de forma confiável: o Minion (ADR-008, nota "Minion como alternativa simples")
usa `Minion::Backend::Pg`, que implementa `SELECT ... FOR UPDATE SKIP LOCKED` +
`LISTEN`/`NOTIFY` — exatamente o padrão que a documentação oficial do PostgreSQL 17
recomenda para filas (`sql-select.html`: "can be used to avoid lock contention with
multiple consumers accessing a queue-like table" — tradução: "pode ser usado para
evitar disputa de lock com múltiplos consumidores acessando uma tabela do tipo
fila"). O que falta ao Minion é o papel
específico de fan-out multi-consumidor que hoje só o RabbitMQ cobre.

## Decisão

Revogar a decisão de usar RabbitMQ (ADR-008) e adotar **PostgreSQL como banco único**
do stack para dados relacionais (ADR-007), documentos JSONB (ADR-017) **e filas** —
eliminando RabbitMQ, `Net::AMQP::RabbitMQ` e qualquer cliente AMQP do stack.

Mecanismo concreto proposto: **PgQue** (SQL puro + PL/pgSQL, licença Apache-2.0,
[pgque.dev](https://pgque.dev)) assume o papel de log de eventos multi-consumidor que o
RabbitMQ tem hoje. **Minion permanece inalterado** para a fila de jobs interna — as
duas camadas continuam distintas por escopo, só que ambas agora vivem inteiramente
em PostgreSQL:

```
HTTP Handler → $c->minion->enqueue(...)
                  ↓ (fila no Postgres, inalterado — Minion::Backend::Pg)
           Minion Worker → pgque.send('stega.notifications', ...)
                                  ↓ (log de eventos no Postgres — PgQue)
                            NotificationWorker (pgque.receive/ack, cursor próprio)
```

**Tick de rotação**: um **processo próprio, de longa duração** (`Deployment`,
mesmo molde do `NotificationWorker`/worker do Minion — não um `CronJob` do
Kubernetes) chama `pgque.ticker()` em loop apertado (~100ms-1s), mais
`pgque.maint()`/`maint_retry_events()` periodicamente (~30s) — não `pg_cron`.
`pgque.ticker_loop()` é de uso interno do `pg_cron` (é o que ele agenda a cada
1s, e essa procedure faz sub-tick de 100ms por dentro); um processo externo
chama `pgque.ticker()` diretamente. Um `CronJob` do Kubernetes não atingiria a
cadência necessária sozinho (granularidade mínima de 1 minuto) — só serviria
se o próprio comando implementasse um laço interno de alta frequência antes de
sair, e nesse caso um `Deployment` sempre ativo é mais simples (sem lidar com
sobreposição de execuções nem com o laço precisar terminar antes do próximo
disparo). Essa escolha evita exigir uma imagem PostgreSQL customizada ou
alterar `shared_preload_libraries`; a imagem `postgres:17-alpine` (ADR-007/
ADR-014) permanece sem modificação para `db-events`, ao custo explícito de mais
um processo persistente a construir e operar.

**Restrição de implementação obrigatória**: exatamente **uma** réplica desse
processo (`replicas: 1`, mesma configuração já usada para o
`notification-worker` — ver Guia 9). O PgQue não protege `pgque.ticker()`
contra chamadas concorrentes quando o agendamento é externo (isso só é
garantido pelo próprio `pg_cron` quando o tick roda dentro dele) — duas
réplicas chamando `ticker()` ao mesmo tempo não têm nenhuma coordenação entre
si por parte do PgQue.

Ver seção 11 do estudo anexo para o raciocínio completo por trás desta escolha.

Instalação: um script de bootstrap dedicado (`eng/bootstrap_pgque.pl` —
deliberadamente **fora** de `migrations/` e do fluxo de `Mojo::Pg::Migrations`, por
ser instalação de um pacote de terceiros, não uma migration de domínio) carrega
`pgque.sql` uma vez e concede o papel `pgque_admin` (já contém `pgque_reader`/
`pgque_writer`) **à credencial que vai efetivamente se conectar ao banco onde o
PgQue vive** — não necessariamente `stega_app`/`stega_migrate`: esta ADR decide o
mecanismo de filas, não em qual instância/credencial ele roda. A ADR-023 (também
`Proposta`) decide isso: se aceita, o PgQue vive numa instância `db-events`
dedicada com sua própria credencial única (D), sem nenhuma relação com as
credenciais de `db-app`. Em Kubernetes é um InitContainer separado do de migration
(`bootstrap-pgque`, não `migrate`); em Docker Compose, um serviço `bootstrap-pgque`
separado do serviço `migrate` — mesmo mecanismo de passo idempotente, script e nome
distintos, para não confundir "instalar o PgQue" com "aplicar migrations do
domínio" (ver ADR-023 para a topologia e as credenciais completas).

## Justificativa

O estudo completo — API do PgQue, comparação com PgQ (Skytools) e com Postgres sem
nenhuma extensão, armadilhas de bloat/vacuum/WAL sob carga sustentada, e o
levantamento de que nenhum cliente Perl AMQP resolve o problema de Windows sem
reintroduzir outra dependência XS problemática — está em
[`references/ADR-022-estudo-filas-postgresql.md`](references/ADR-022-estudo-filas-postgresql.md).

Referências: [PostgreSQL](../references/postgresql.md), [PgQue](../references/pgque.md),
[PgQ](../references/pgq.md), [Minion](../references/minion.md),
[Mojo::Pg](../references/mojo-pg.md).

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Manter RabbitMQ** (status quo, ADR-008) | O problema de build no Windows não é do nosso ambiente — é documentado externamente (issue #144 do `Net::AMQP::RabbitMQ`) e não tem solução no cliente Perl sem reintroduzir outra dependência XS problemática (Coro, via `Net::RabbitFoot`). Mantém permanentemente uma exceção "Docker-only" para um componente, contrariando o objetivo de paridade nativa da ADR-014 |
| **PgQ original** (Skytools, `pgq/pgq`) | Extensão C + daemon externo `pgqd` — reintroduz a mesma classe de fricção operacional (peça de infraestrutura C a compilar e manter) que estamos tentando eliminar, só do lado do servidor Postgres em vez do cliente Perl. Mantido sem desenvolvimento ativo desde 2023 |
| **PostgreSQL sem nenhuma extensão** (`SKIP LOCKED` + `LISTEN`/`NOTIFY` + tabela própria) | Tecnicamente viável e zero dependência de terceiros, mas exige construir e manter, por conta própria, tudo que a PgQue já oferece pronto: rotação anti-bloat, dead-letter queue, fan-out multi-consumidor, observabilidade. Mesmo princípio já aplicado na ADR-016 (preferir mecanismo de biblioteca testada a utilitário próprio equivalente). Mantida como plano B caso a maturidade da PgQue (v0.2.0) seja considerada risco alto demais |
| **Outro broker cross-platform** (NATS, Redis Streams) | Resolveria o problema de cliente Perl no Windows, mas adiciona um novo serviço de backing ao stack — o oposto do objetivo desta proposta, que é consolidar em um único banco |
| **Apenas Minion, sem substituto para o RabbitMQ** | Minion não oferece fan-out multi-consumidor nem modelo de tópico/roteamento — continuaria sem solução para o caso de uso de notificação externa desacoplada que motivou o RabbitMQ na ADR-008 original |

## Consequências

**Positivo**:
- Um único serviço de backing (PostgreSQL) para dados relacionais, documentos e
  filas — um serviço a menos para operar, monitorar e manter credenciais
- Elimina completamente a dependência XS/C (`librabbitmq`) do stack — nenhum
  módulo de fila exige compilador C no ambiente de desenvolvimento
- Remove a exceção "Windows nativo precisa de Docker" do Guia 8/ADR-014 — paridade
  nativa completa em qualquer plataforma
- Observabilidade de fila via SQL puro (`pgque.get_queue_info()` etc.), sem
  ferramenta externa (Management UI do RabbitMQ deixa de ser necessária)
- Reaproveita um padrão já validado em produção no próprio stack (`Minion::Backend::Pg`
  já usa `SKIP LOCKED`/`LISTEN`/`NOTIFY`) em vez de introduzir um paradigma novo

**Negativo**:
- PgQue está em estágio inicial (v0.2.0, poucos meses de existência como projeto
  empacotado) — risco de maturidade real, ainda que o algoritmo subjacente (PgQ) 
  tenha uma década de uso em produção na Skype
- Concentra mais carga de trabalho (filas, além de dados relacionais e JSONB) na
  mesma instância PostgreSQL — risco de conflito de vacuum/WAL entre cargas sob
  volume alto (ver seção 8 do estudo anexo). **Mitigado pela ADR-023** (proposta
  separada, também `Proposta`): instância `db-events` dedicada, isolada de `db-app`
- Perde interoperabilidade AMQP nativa — se um sistema externo não-Perl precisar
  consumir esses eventos diretamente via protocolo padrão de mensageria no futuro,
  precisaria de uma ponte adicional (nada no stack usa isso hoje)
- Modelo de fan-out do PgQue (log de eventos com cursor por consumidor) é
  conceitualmente diferente de exchanges/routing keys do RabbitMQ — não é um
  substituto 1:1, é um modelo diferente que cobre o mesmo caso de uso

**Ações necessárias** *(somente quando esta ADR for aceita — nenhuma executada agora)*:
- **Pré-requisito**: a baseline de
  testes contra o mecanismo atual (`t/070_notifications.t`, cobrindo os 3 jobs
  Minion sem teste antes e o roteamento do `NotificationWorker`) já existe no
  repositório da Stega — ver seção 10 do estudo anexo, "Cobertura de testes".
  Ao implementar esta ADR, a função de dreno desses testes (hoje conectando via
  `Net::AMQP::RabbitMQ`) precisa ser **reescrita por completo** para
  `pgque.receive()` — as asserções sobre o resultado (routing key + payload)
  permanecem as mesmas e servem de critério de aceite
- Atualizar o status da ADR-008 para `Substituída por ADR-022`
- Remover o serviço `rabbitmq` do `compose.yml` (repositório central e Stega),
  incluindo do serviço `test` (hoje depende de `rabbitmq`/usa `RABBITMQ_HOST`
  para rodar `t/070_notifications.t` — passa a depender de `postgres-events`
  e usar `POSTGRESQL_EVENTS_URL`/`_USERNAME`/`_PASSWORD`, ver ADR-023), e a
  instalação de `librabbitmq-dev`/`librabbitmq4` do Dockerfile
- Instalar `pgque.sql` e criar os papéis `pgque_reader`/`pgque_writer`/`pgque_admin`
  no banco da Stega
- Reescrever `Stega::Worker::NotificationWorker` e os jobs Minion que publicam
  eventos (`SendWelcomeNotification`, `CheckSlaBreaches`, `GenerateActivityReport`)
  para usar `pgque.send()`/`receive()`/`ack()`/`nack()` via `Mojo::Pg`
- Remover `Net::AMQP::RabbitMQ` do `cpanfile`
- Remover as variáveis `RABBITMQ_HOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`,
  `RABBITMQ_VHOST` e `RABBITMQ_PORT` — nenhuma substituta é necessária, já que o
  PgQue é acessado pela mesma conexão Postgres da aplicação (`POSTGRESQL_APP_URL`
  e credenciais associadas) ou, se a ADR-023 também for aceita, por
  `POSTGRESQL_EVENTS_URL`/`_USERNAME`/`_PASSWORD` — não por um protocolo próprio
  com host/usuário/senha separados
- Atualizar a lista de variáveis de ambiente documentada na ADR-021
  (`Stega::Config`) — remove a chave `rabbitmq` do hashref de configuração
- Criar o processo/`Deployment` de ticker (`pgque.ticker()` em loop, mais
  `maint()`/`maint_retry_events()` periodicamente) no Kubernetes e o
  equivalente em Docker Compose para desenvolvimento
- Reescrever o Guia 8 e atualizar os manifests Kubernetes do Guia 9 (remover
  `Deployment`/`Service` do RabbitMQ, adicionar o `Deployment` de ticker)
- Remover a exceção "Windows nativo" do Guia 8 e da ADR-014
- Atualizar `docs/references/minion.md`, `mojo-pg.md` e `postgresql.md` com esta
  ADR na seção "Referenciada em"
- Atualizar a tabela "Technology Stack" e "Decisões Iniciais Resolvidas" do
  `CLAUDE.md`
