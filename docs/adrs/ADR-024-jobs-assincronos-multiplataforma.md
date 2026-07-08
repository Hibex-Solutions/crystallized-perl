# ADR-024: Jobs Assíncronos Multiplataforma — Pendência de Pesquisa

**Status**: Proposta  
**Data**: 2026-07-08

> Esta ADR **não propõe uma solução**. Ela documenta um problema conhecido, o
> inventário de uso real levantado até agora e as perguntas técnicas em aberto
> que precisam ser respondidas antes de qualquer decisão. Permanece `Proposta`
> — sem prazo — até que uma pesquisa futura permita registrar uma `## Decisão`
> de verdade, seja nesta ADR revisada, seja em uma ADR nova que a substitua.

## Contexto

A ADR-014 estabelece que a equipe pode trabalhar em Linux, macOS e Windows, com
três caminhos de desenvolvimento local em ordem crescente de paridade com
produção (perlbrew/berrybrew nativo, ou Docker Compose) — o objetivo explícito
é rodar em containers (cloud-native) **e** permitir desenvolvimento nativo nos
três sistemas operacionais, não apenas via Docker. A migração de RabbitMQ para
PgQue (ADR-022) resolveu a última exceção conhecida dessa paridade que era
ligada a uma dependência XS/compilador C (`Net::AMQP::RabbitMQ` não compilava
no Windows).

Na validação nativa no Windows dessa mesma migração (2026-07-08), apareceu uma
exceção diferente, não relacionada a compilador C nem ao PgQue: `Minion.pm`
(o próprio módulo `Minion`, não código desta aplicação) recusa operar —
`croak 'Minion workers do not support fork emulation'` — em qualquer Perl com
`$Config{d_pseudofork}` verdadeiro. Esse é o caso do Strawberry/berrybrew no
Windows, que emula `fork()` via ithreads em vez de usar `fork()` real do SO.
Isso afeta:

- O processo de produção `carton exec perl script/stega minion worker`
  (não roda de jeito nenhum nativamente no Windows)
- Qualquer teste que chame `$app->minion->perform_jobs`
  (`t/030_webhooks.t`, `t/070_notifications.t` na Stega)

Essa limitação **não foi introduzida pela ADR-022** — existe desde a adoção
original do Minion (ADR-008) e independe do mecanismo de fila de eventos
escolhido. Mas ela é hoje a **última exceção de plataforma** que resta no
stack depois da migração para PgQue: todo o resto (`script/stega daemon`,
`script/worker`, `script/pgque_ticker`, scripts de `eng/`) já roda nativamente
nos três sistemas operacionais sem ressalva.

O paliativo atual (guardas `skip_all` nos testes, avisos em documentação —
ver "Onde o problema está referenciado hoje" em Consequências) contorna o
sintoma, não resolve o problema. Esta ADR existe para registrar formalmente
essa pendência e reunir, num único lugar, tudo que já aprendemos
investigando-a — para que uma pesquisa futura não comece do zero.

### Inventário de uso real do Minion na Stega (levantado em 2026-07-08)

Antes de avaliar qualquer alternativa, é preciso saber exatamente o que está
em uso hoje — não o que o Minion é capaz de fazer em tese.

| Task | Disparado por | O que faz | Recursos do Minion usados |
|------|---------------|-----------|----------------------------|
| `send_welcome_notification` | HTTP — `Controller::Auth`, primeiro login | Publica o evento `ticket.welcome` no PgQue | `enqueue` básico |
| `process_webhook_payload` | HTTP — `Controller::Webhook` (genérico e GitHub) | Cria/atualiza ticket a partir do payload recebido | `enqueue` básico |
| `check_sla_breaches` | **Nenhum disparo hoje** | Varre tickets abertos/em andamento, publica `ticket.sla_breached` para os que estourarem SLA | `enqueue` básico (nunca chamado) |
| `generate_activity_report` | **Nenhum disparo hoje** | Gera estatísticas semanais por produto, publica `report.weekly_ready` | `enqueue` básico (nunca chamado) |

Observações consolidadas:

- **Nenhum dos 4 jobs usa qualquer recurso avançado do Minion**: sem `unique`,
  sem `priority`, sem `delay`, sem `attempts` customizado (todos usam o
  default, que é 1 tentativa — ou seja, **não há retry automático configurado
  hoje** em nenhum dos quatro), sem `Minion::Admin` (a interface web nunca foi
  habilitada nesta aplicação). O uso real é o subconjunto mais simples possível
  da API do Minion: registrar uma task, enfileirar com argumentos, processar.
- **2 dos 4 jobs são disparados por HTTP** (padrão "enfileira e responde
  rápido" — tira trabalho do ciclo de requisição/resposta).
- **2 dos 4 jobs foram pensados para rodar periodicamente mas nunca foram
  conectados a um agendador** — `check_sla_breaches` e
  `generate_activity_report` estão registrados como tasks e prontos para
  rodar, mas não existe CronJob do Kubernetes, `pg_cron`, nem qualquer outro
  mecanismo que os enfileire. Esse é um gap pré-existente, **independente**
  desta ADR, mas relevante para as perguntas abaixo: qualquer mecanismo de
  jobs escolhido no futuro precisa resolver agendamento periódico, porque nem
  o Minion nem o PgQue fazem isso hoje.
- Nenhum dos 4 cenários parece depender, à primeira vista, da semântica
  estrita de "fila de trabalho" (um job é processado por exatamente um worker,
  entre vários concorrentes) de um jeito que o modelo de consumidor nomeado do
  PgQue (fan-out — vários consumidores leem o mesmo evento, cada um com seu
  cursor) não pudesse cobrir. Mas isso é uma impressão a partir do código
  atual, não uma conclusão técnica verificada — ver a primeira pergunta em
  Justificativa.

## Decisão

**Nenhuma decisão foi tomada.** O propósito desta ADR, por ora, é só registrar
o problema, o inventário de uso real do Minion (acima) e as perguntas em
aberto (abaixo) que uma pesquisa futura precisa responder.

## Justificativa

Não há decisão a justificar ainda. Esta ADR se apoia em
[Minion](../references/minion.md) — a documentação oficial do próprio módulo
cuja limitação de `fork()` motiva esta pesquisa, e cuja seção "Relevância" já
documenta a distinção de escopo entre Minion e PgQue que várias das perguntas
abaixo colocam em questão.

### Perguntas técnicas em aberto

1. **`pgque.receive(queue, consumer, n)` suporta múltiplos workers
   concorrentes competindo pelo mesmo nome de consumidor** (semântica de fila
   de trabalho, análoga ao Minion), ou cada consumidor nomeado é
   necessariamente um único leitor lógico? O PgQue já usa `SKIP LOCKED`
   internamente (confirmado no código-fonte durante a migração da ADR-022) —
   precisa verificar se isso se estende a réplicas concorrentes do mesmo
   consumidor, ou só a consumidores diferentes lendo em paralelo.
2. O retry com `pgque.nack(batch_id, msg, retry_after, reason)` cobre o que o
   `attempts`/backoff automático do Minion dá (mesmo que nenhum job use isso
   hoje)?
3. Falta um mecanismo de agendamento periódico (cron) tanto no Minion quanto
   no PgQue — resolver isso faz parte do escopo desta ADR (já que
   `check_sla_breaches`/`generate_activity_report` precisam disso) ou é um
   problema separado, a registrar em outro lugar? `pg_cron` é uma opção ainda
   não avaliada.
4. Existe equivalente operacional ao `minion job`/`Minion::Admin` só com SQL
   sobre PgQue (`get_queue_info`/`get_consumer_info` já existem, mas cobrem
   menos que a CLI/UI do Minion), ou isso é uma perda real de ergonomia
   operacional que pesa contra consolidar tudo em PgQue?
5. Se as respostas acima apontarem para "dá para consolidar", ainda restam (ao
   menos) duas rotas de solução bem diferentes, e esta ADR não escolhe entre
   elas:
   - **(a) Consolidar em PgQue puro**, eliminando o Minion e a instância
     `db-jobs` (exigiria revisão da ADR-023);
   - **(b) Manter os dois mecanismos**, resolvendo só o problema de Windows —
     por exemplo, reimplementando o worker loop de forma que não dependa de
     `fork()` real (um modelo single-process baseado em `Mojo::IOLoop`, como o
     `NotificationWorker`/`pgque_ticker` já fazem), ou via contribuição
     upstream ao próprio Minion.

## Alternativas Consideradas

Nenhuma alternativa foi avaliada a fundo ainda — a tabela abaixo é o ponto de
partida para a pesquisa futura, não um veredito.

| Direção candidata | Situação |
|--------------------|----------|
| Manter Minion + PgQue, resolver só o `fork()` no Windows (worker loop sem fork, ou fix upstream) | Não avaliada — viabilidade depende de quanto do `Minion::Backend::Pg` dá para reaproveitar sem o worker padrão do Minion |
| Consolidar tudo em PgQue puro, eliminando o Minion e `db-jobs` | Não avaliada — depende das perguntas 1, 2 e 4 da Justificativa |
| PostgreSQL puro sem PgQue nem Minion (`SKIP LOCKED` + `LISTEN`/`NOTIFY` + tabela própria) | A ADR-022 já rejeitou essa rota para eventos multi-consumidor ("Opção C" do estudo anexo), mas jobs internos são um caso de uso mais simples — pode caber aqui mesmo tendo sido rejeitada lá |
| `pg_cron` para o agendamento periódico que falta hoje | Não avaliada |
| Status quo — Docker/WSL2 obrigatório só para o worker Minion | É o comportamento atual; não atende ao objetivo de paridade nativa da ADR-014, e é exatamente o motivo desta ADR existir |

## Consequências

Nenhuma — esta ADR, enquanto `Proposta`, não altera nada do stack em vigor.
ADR-008 (histórica), ADR-022 e ADR-023 permanecem exatamente como estão. O
paliativo atual (guardas `skip_all` nos testes que dependem de
`perform_jobs`, avisos em documentação) continua sendo a solução até que esta
pendência seja resolvida.

**Ações necessárias**: nenhuma no código hoje. Quando esta pesquisa avançar, a
ADR-024 deve ser revisada com uma `## Decisão` de verdade (ou substituída por
uma ADR nova) — e, nesse momento, todo lugar que hoje referencia esta ADR como
"pendência" precisa ser atualizado para refletir a decisão final:

- [ADR-014](ADR-014-ambiente-de-desenvolvimento-local.md), seção Consequências/Negativo (Revisão 2026-07-08)
- [ADR-022](ADR-022-filas-em-postgresql.md), Revisão 2026-07-08 e bullet de Consequências/Positivo
- [Guia 1 — Ambiente de Desenvolvimento](../guides/01-ambiente-de-desenvolvimento.md), passo 4 e tabela de troubleshooting
- [Guia 8 — Filas com PgQue e Minion](../guides/08-filas-com-pgque-e-minion.md), Passo 4, tabela de troubleshooting e tabela dos quatro processos
- `DEVELOPMENT.md` e `README.md` da Stega (repositório `crystallized-perl-stega`)
- `t/030_webhooks.t` e `t/070_notifications.t` da Stega (guardas `skip_all`)
