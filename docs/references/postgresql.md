# [PostgreSQL](https://www.postgresql.org/)

**Tipo**: Documentação Oficial  
**Autor(es)**: The PostgreSQL Global Development Group  
**Publicado**: 1996 (atualizado continuamente)  
**Acessado**: 2026-06-26

## Relevância
PostgreSQL é o banco de dados relacional open source mais avançado do mercado. Suporte
completo a ACID, JSON nativo, full-text search, extensões (PostGIS, pgvector) e
replicação. Candidato principal para a ADR de banco de dados relacional do stack —
compatível com todos os ORMs e clientes Perl relevantes.

## Referenciada em
- ADR-007: Banco de Dados Relacional — PostgreSQL
- ADR-016: Acesso a Dados Relacional — Mojo::Pg e Migrations
- ADR-017: Acesso a Dados de Documentos — PostgreSQL JSONB
- ADR-018: Aplicação de Demonstração — Stega
- [ADR-022](../adrs/ADR-022-filas-em-postgresql.md): Filas em PostgreSQL —
  revogação do RabbitMQ (aceita em 2026-07-07), com base em `SKIP LOCKED`,
  `LISTEN`/`NOTIFY` e autovacuum/`TRUNCATE` documentados na versão 17
- [ADR-023](../adrs/ADR-023-topologia-de-instancias-postgresql.md): Topologia de
  Instâncias PostgreSQL — quatro instâncias dedicadas por finalidade em vez de
  uma compartilhada (aceita em 2026-07-07)
