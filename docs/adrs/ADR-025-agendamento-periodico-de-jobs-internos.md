# ADR-025: Agendamento Periódico de Jobs Internos

**Status**: Aceita
**Data**: 2026-07-29

## Contexto

A ADR-024 (`Proposta`) documenta uma pesquisa em aberto com cinco perguntas
técnicas sobre jobs assíncronos multiplataforma. A pergunta 3 dessa ADR é
independente das demais (que tratam da limitação de `fork()` do Minion no
Windows e de uma possível consolidação Minion↔PgQue): "falta um mecanismo de
agendamento periódico (cron) tanto no Minion quanto no PgQue — resolver isso
faz parte do escopo desta ADR ou é um problema separado?".

O problema é concreto e já bloqueava trabalho real na Stega (ADR-018):
`Stega::Job::CheckSlaBreaches` e `Stega::Job::GenerateActivityReport` estavam
totalmente implementados e registrados como tasks do Minion
(`Stega.pm::_setup_minion`), mas nenhum dos dois era jamais enfileirado — não
havia `enqueue()` para eles em nenhum Controller, `CronJob` do Kubernetes,
`pg_cron`, nem qualquer outro agendador (inventário completo na ADR-024).

Esta ADR responde só a pergunta 3, de forma isolada, na implementação do
disparo periódico de `generate_activity_report` na Stega — as perguntas
1/2/4/5 da ADR-024 (sobre `fork()` no Windows e a eventual consolidação
Minion↔PgQue) continuam sem resposta e fora do escopo aqui.

## Decisão

**Um processo dedicado de longa duração enfileira jobs Minion agendados,
seguindo exatamente o padrão já aceito para o tick do PgQue na ADR-022**
(`script/pgque_ticker`): um script em `script/` (ADR-013) — `script/report_scheduler`
na Stega — que roda em loop, verifica periodicamente quais tasks têm intervalo
vencido e chama `$app->minion->enqueue($task)` para cada uma.

Características da decisão:

- **Só enfileira, nunca processa jobs.** `enqueue()` apenas insere uma linha no
  backend do Minion (`db-jobs`) — não depende de `fork()`, então este processo
  roda nativamente nos três sistemas operacionais (Linux/macOS/Windows) sem
  esbarrar na limitação documentada na ADR-024 para o *worker* do Minion.
- **Lista de agendamento extensível.** Um array de entradas
  `{ task => <nome da task>, interval => <segundos> }`, avaliado por uma
  função pura (`Stega::Scheduler::due_jobs` na Stega, testável sem banco) —
  adicionar outro job agendado (ex.: `check_sla_breaches`, ainda pendente) é
  só acrescentar uma entrada, sem mudar o mecanismo.
- **Intervalo configurável por variável de ambiente**, com default seguro
  (semanal, no caso de `generate_activity_report`) — um valor curto só é
  aceitável para validação manual, nunca em produção.
- **Exatamente uma réplica.** Mesma ressalva operacional do
  `pgque_ticker`: nenhuma coordenação existe entre réplicas concorrentes deste
  processo, então rodar mais de uma enfileiraria a mesma task em duplicidade.

## Justificativa

Nem o Minion nem o PgQue resolvem agendamento recorrente hoje —
[Minion](../references/minion.md) oferece `delay` para adiar a execução de um
job específico uma única vez, sem equivalente a um agendador recorrente
embutido; [PgQue](../references/pgque.md) já documenta explicitamente que seu
próprio tick de rotação depende de "`pg_cron` (ou um agendador externo
chamando `pgque.ticker()` em loop)" — ou seja, o próprio mecanismo de fila
escolhido na ADR-022 tem exatamente essa mesma lacuna, resolvida na época com
um processo dedicado (`script/pgque_ticker`) em vez de trazer `pg_cron` como
dependência nova.

Esta ADR aplica o mesmo raciocínio já aceito naquela decisão (ver
"Revisão 2026-07-07" da [ADR-022](ADR-022-filas-em-postgresql.md)) ao problema
análogo de agendar jobs do Minion: um processo próprio, simples e sem estado
compartilhado entre réplicas, é consistente com o que o stack já faz e não
introduz nenhuma dependência nova nem exige tocar a imagem `postgres:17-alpine`
das instâncias existentes (ADR-023).

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| `pg_cron` na instância `db-jobs` | Exigiria trocar `postgres:17-alpine` por uma imagem com a extensão compilada — contra a decisão da ADR-022 de manter as imagens Postgres do stack intocadas, sem extensão customizada |
| `CronJob` do Kubernetes chamando `minion job -e <task>` | O repositório ainda não tem nenhum manifesto Kubernetes; sem um processo equivalente para Docker Compose/desenvolvimento local, não haveria como validar o comportamento fora de produção |
| Job Minion que se reenfileira ao final da própria execução (`enqueue` de si mesmo com `delay`) | Mistura lógica de agendamento com lógica de negócio dentro do próprio Job; um job que falha ou nunca roda quebra silenciosamente o próprio agendamento, sem um processo externo observável para diagnosticar |
| Consolidar em PgQue puro (`pgque.send`/`receive` no lugar do Minion) para os jobs periódicos | Fora de escopo desta ADR — é exatamente a pergunta 5 da ADR-024, ainda sem resposta; mudaria o mecanismo de execução dos Jobs, não só o de agendamento |

## Consequências

**Positivo**:
- Cross-platform desde o primeiro dia — nenhuma exceção de Windows, ao
  contrário do worker do Minion (ADR-024)
- Reaproveita um padrão operacional já validado em produção na Stega
  (`pgque_ticker`), sem dependência nova no `cpanfile` nem na infraestrutura
- `check_sla_breaches` (e qualquer job periódico futuro) usa o mesmo mecanismo
  só acrescentando uma entrada na lista de agendamento
- Responde definitivamente a pergunta 3 da ADR-024

**Negativo**:
- Mais um processo de longa duração para operar e monitorar (ao lado de
  `pgque_ticker`, `minion worker` e `notification_worker`)
- Assim como o `pgque_ticker`, exige disciplina operacional para nunca escalar
  a mais de uma réplica

**Ações necessárias**:
- Nenhuma mudança nas ADRs 008/022/023 — nenhuma delas é revogada ou alterada
  por esta decisão
- ADR-024 recebe uma nota de revisão apontando que a pergunta 3 foi respondida
  por esta ADR, mantendo seu próprio status `Proposta` (perguntas 1/2/4/5
  continuam abertas)
- `docs/references/minion.md` e `docs/references/pgque.md` atualizados
  (seção `## Referenciada em`)
