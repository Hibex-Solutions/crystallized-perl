# [PgQue](https://pgque.dev)

**Tipo**: Repositório Open Source
**Autor(es)**: Nikolay Samokhvalov (PostgresAI)
**Publicado**: 2026 (v0.2.0 em 2026-05-25)
**Acessado**: 2026-07-04

## Relevância

PgQue é uma fila de eventos "zero-bloat" para PostgreSQL, implementada inteiramente
em SQL e PL/pgSQL — sem extensão C — que reimplementa o algoritmo do PgQ (Skytools,
criado na Skype) usando batching por snapshot e rotação via `TRUNCATE` em vez de
`DELETE`/`UPDATE` por linha. Expõe uma API SQL completa: produção (`send`,
`send_batch`), consumo com cursor próprio por consumidor (`subscribe`, `receive`,
`ack`, `nack`), dead-letter queue (`dlq_inspect`, `dlq_replay`, `dlq_purge`) e
observabilidade (`get_queue_info`, `get_consumer_info`). Requer PostgreSQL 14+ e,
para o "tick" automático de rotação, `pg_cron` (ou um agendador externo chamando
`pgque.ticker_loop()`).

Candidato central na [ADR-022](../adrs/ADR-022-filas-em-postgresql.md) (proposta,
ainda não aceita) para substituir o RabbitMQ ([ADR-008](../adrs/ADR-008-message-broker-rabbitmq.md))
no papel de log de eventos multi-consumidor (fan-out) do stack — eliminando a
dependência de um cliente AMQP em Perl, cujo módulo principal (`Net::AMQP::RabbitMQ`)
não compila em Windows. Por ser SQL puro, PgQue é acessado inteiramente via
`Mojo::Pg` ([ADR-016](../adrs/ADR-016-acesso-a-dados-relacional-mojo-pg.md)), sem
nenhuma dependência XS nova no cpanfile.

É um projeto em estágio inicial (v0.2.0, "early-stage" segundo o próprio README) —
o motor conceitual (PgQ) tem mais de uma década de uso em produção na Skype, mas o
empacotamento PgQue em si é recente. O estudo completo de prós, contras e
armadilhas está em
[`docs/adrs/references/ADR-022-estudo-filas-postgresql.md`](../adrs/references/ADR-022-estudo-filas-postgresql.md).

## Referenciada em

- [ADR-022](../adrs/ADR-022-filas-em-postgresql.md) — proposta (não aceita) de
  substituir o RabbitMQ por PgQue como mecanismo de filas em PostgreSQL
