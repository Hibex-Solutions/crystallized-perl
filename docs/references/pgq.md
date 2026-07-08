# [PgQ](https://github.com/pgq/pgq)

**Tipo**: Repositório Open Source
**Autor(es)**: Projeto Skytools (originado na Skype); mantido hoje pela comunidade `pgq/pgq`
**Publicado**: ~2006 (última release v3.5.1 em 2023-09-07)
**Acessado**: 2026-07-04

## Relevância

PgQ é a fila de eventos original em que o [PgQue](pgque.md) se inspira — "generic,
high-performance lockless queue with simple API based on SQL functions", criada
como parte do Skytools na Skype e usada historicamente em escala de centenas de
milhões de usuários. Diferente do PgQue, PgQ **é uma extensão C** (exige
`CREATE EXTENSION` e compilação no servidor PostgreSQL) acompanhada de um daemon
externo (`pgqd`) para rotação/tick — infraestrutura adicional a operar, não menos
que o RabbitMQ que a [ADR-022](../adrs/ADR-022-filas-em-postgresql.md) propõe
eliminar.

Avaliado como alternativa na ADR-022 e rejeitado nessa proposta em favor do PgQue,
justamente por reintroduzir uma peça de infraestrutura C do lado do servidor
PostgreSQL. Importante para o registro: **PgQue não é uma nova versão ou
continuidade oficial deste repositório** — é um projeto novo e distinto que
reimplementa o algoritmo conceitual do PgQ em SQL puro, sem a extensão C nem o
daemon `pgqd`. O levantamento completo dessa relação está em
[`docs/adrs/references/ADR-022-estudo-filas-postgresql.md`](../adrs/references/ADR-022-estudo-filas-postgresql.md),
seção 5.

## Referenciada em

- [ADR-022](../adrs/ADR-022-filas-em-postgresql.md) — avaliado e rejeitado como
  alternativa ao PgQue (extensão C + daemon externo, sem desenvolvimento ativo
  desde 2023); ADR aceita em 2026-07-07 com PgQue como mecanismo escolhido
