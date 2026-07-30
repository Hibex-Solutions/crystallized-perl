# ADR-026: Consumidores Cooperativos do PgQue para Distribuição de Trabalho

**Status**: Aceita
**Data**: 2026-07-30

## Contexto

A ADR-025 resolveu a pergunta 3 da ADR-024 (agendamento periódico de jobs
internos) com um processo dedicado (`script/report_scheduler`) que enfileira
`Stega::Job::GenerateActivityReport` periodicamente. Faltava o segundo job do
mesmo backlog: `Stega::Job::CheckSlaBreaches` — varre tickets abertos/em
andamento e **já publica** um evento `ticket.sla_breached` por ticket vencido
no PgQue (código pré-existente, sem mudança nesta ADR).

O que faltava era a **entrega** desse alerta. Diferente do relatório semanal
(entregue por um único consumidor, `NotificationWorker`), um alerta de SLA
vencido é sensível a tempo e o volume de tickets vencidos pode crescer — faz
sentido dividir o trabalho de entrega entre múltiplos processos concorrentes,
não processar tudo em um único worker.

A API "normal" do PgQue (`pgque.subscribe`/`pgque.receive`, já usada pelo
`NotificationWorker`) não serve para isso: cada nome de consumidor é um cursor
lógico único — se dois processos chamarem `pgque.receive('fila', 'mesmo_nome', n)`
concorrentemente, ambos veem o mesmo lote (duplicação, não divisão de
trabalho). Essa é exatamente a pergunta 1 da ADR-024, em aberto: "`pgque.receive`
suporta múltiplos workers concorrentes competindo pelo mesmo nome de
consumidor, ou cada consumidor nomeado é necessariamente um único leitor
lógico?".

Pesquisa nesta sessão, lendo o SQL vendorizado
(`vendor/pgque/pgque.sql` no repositório `crystallized-perl-stega`), encontrou
a resposta: existe uma segunda API, "consumidores cooperativos"
(`pgque.subscribe_subconsumer`, `pgque.receive_coop`, `pgque.next_batch` de 4
argumentos), que permite múltiplos processos ("subconsumers") sob o mesmo
grupo lógico ("consumer" principal) dividirem lotes de eventos entre si — com
takeover automático do lote de uma réplica travada, via parâmetro
`dead_interval`. Granularidade: por **lote** (janela de tick), não por
mensagem individual — mais grosseira que "um worker por mensagem", mas ainda
assim divide trabalho real entre réplicas.

Essa API está marcada pelo próprio autor do PgQue como **"Experimental in
PgQue 0.2"**, com o aviso explícito: "Do not use this as the only processing
path for critical workloads without idempotent handlers and stale-worker
takeover tests." (comentário `pgque.receive_coop` no vendorizado).

## Decisão

**Usar a API cooperativa experimental do PgQue** para qualquer worker que
precise de trabalho dividido entre múltiplas réplicas de verdade — hoje só o
`Stega::Worker::SlaBreachWorker` (`script/sla_breach_worker`, novo), consumidor
dedicado do evento `ticket.sla_breached`:

- Um **grupo cooperativo** por tipo de worker que precise de scaling real
  (`sla_breach_dispatcher` para este caso) — não reaproveita o consumidor
  `notification_worker` existente, que continua com a API normal
  (`subscribe`/`receive`) e não escala.
- **Subconsumer = `hostname() . '-' . $$`** — hostname do container (único
  por réplica em `docker compose up --scale`) + PID, identifica cada réplica
  sem coordenação externa.
- `pgque.subscribe_subconsumer` no início de cada processo (idempotente e
  auto-criador — confirmado lendo `pgque.register_subconsumer` no
  vendorizado: cria o consumidor principal como `coop_main` na primeira
  chamada, se ainda não existir).
- `pgque.receive_coop(fila, consumer, subconsumer, max_return, dead_interval)`
  no lugar de `pgque.receive`; `dead_interval` de 2 minutos permite que outra
  réplica assuma o lote de uma réplica travada. `pgque.ack`/`pgque.nack`
  continuam os mesmos usados pela API normal — `finish_batch` já trata o
  papel `coop_member` internamente (confirmado no vendorizado), não há
  função de ack/nack separada para o caminho cooperativo.
- PgQue continua fan-out por natureza: o novo worker lê a **mesma fila**
  `stega.notifications` (não uma fila nova), só filtra e processa o tipo de
  evento que lhe interessa (`ticket.sla_breached`), ignorando os demais
  silenciosamente.

## Justificativa

Nem o Minion nem a API normal do PgQue oferecem semântica de fila de trabalho
competindo por mensagem — [Minion](../references/minion.md) usa
`Minion::Backend::Pg` com `SKIP LOCKED` para isso entre workers de uma mesma
task, mas os jobs periódicos deste stack (ADR-025) só enfileiram, não
processam (evitando a limitação de `fork()` do Minion no Windows, ADR-024).
[PgQue](../references/pgque.md) resolve o caso de uso de entrega
multi-consumidor desacoplada (fan-out), mas cada consumidor nomeado normal é
um único leitor lógico — a API cooperativa é a peça que faltava para
trabalho *dividido*, não duplicado, entre réplicas de um mesmo tipo de
consumidor.

Aceitar uma feature "Experimental in PgQue 0.2" segue o mesmo espírito de
risco já aceito na ADR-022 para o PgQue como um todo (também early-stage,
v0.2) — aqui um nível a mais, já que a própria feature é marcada experimental
*dentro* do PgQue 0.2, não o pacote inteiro. O caso de uso (alerta de SLA de
uma aplicação de demonstração) tolera esse risco: os handlers já são
idempotentes o bastante (reenviar o mesmo alerta de SLA vencido duas vezes
não corrompe estado nenhum, só duplica um log de demonstração), e o
`dead_interval` cobre o cenário de "worker travado" que o aviso do PgQue
menciona.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| Um único consumidor dedicado, sem scaling real (API normal do PgQue) | Mantém a pergunta 1 da ADR-024 sem resposta prática — não demonstra trabalho dividido, só entrega desacoplada (que o `NotificationWorker` já demonstra) |
| Fila PgQue separada por "shard" (ex.: hash do ticket_id) com um consumidor normal por shard | Complexidade desnecessária para o volume esperado de alertas de SLA nesta aplicação de referência; PgQue não tem primitivo de particionamento nativo para isso, exigiria lógica própria de shard no lado da aplicação |
| Consolidar em Minion (usar `Minion::Backend::Pg` com `SKIP LOCKED` de verdade, um job por ticket vencido) | Reintroduziria a limitação de `fork()` do Minion no Windows (ADR-024) para o *processamento*, não só o agendamento — o objetivo desta ADR é demonstrar PgQue fazendo esse papel, não voltar para o Minion |

## Consequências

**Positivo**:
- Responde, na prática, a pergunta 1 da ADR-024
- Demonstra um exemplo real de integração Minion (agendamento/detecção) +
  PgQue (entrega distribuída) trabalhando juntos na mesma aplicação de
  referência — relevante (embora não conclusivo) para a pergunta 5 da
  ADR-024, sobre consolidar os dois mecanismos
- `sla-breach-worker` escala horizontalmente de verdade
  (`docker compose up --scale sla-breach-worker=N`), sem duplicar entrega

**Negativo**:
- Depende de uma feature marcada "Experimental in PgQue 0.2" pelo próprio
  autor — pode mudar de nome/comportamento em versões futuras do PgQue
  (mesmo aviso já citado na Justificativa)
- Granularidade de divisão de trabalho é por lote (janela de tick), não por
  mensagem individual — réplicas podem ficar com carga desigual se um lote
  específico concentrar muitas mensagens

**Ações necessárias**:
- `docs/references/pgque.md` atualizado com a API cooperativa e esta ADR em
  "Referenciada em"
- `docs/adrs/ADR-024-jobs-assincronos-multiplataforma.md` recebe nota de
  revisão marcando a pergunta 1 como respondida por esta ADR — perguntas 2, 4
  e 5 continuam abertas
