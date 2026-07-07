# [Mojo::Pg](https://docs.mojolicious.org/Mojo/Pg)

**Tipo**: Documentação Oficial  
**Autor(es)**: Sebastian Riedel e colaboradores  
**Publicado**: 2014 (atualizado continuamente)  
**Acessado**: 2026-06-27

## Relevância
Mojo::Pg é a camada oficial de acesso a PostgreSQL do ecossistema Mojolicious. Provê
queries não-bloqueantes integradas ao event loop do Mojo, pool de conexões assíncronas e
suporte nativo a migrations via `Mojo::Pg::Migrations`. O sistema de migrations armazena
scripts SQL versionados, rastreia as migrações aplicadas diretamente no banco e se
integra ao startup da aplicação — permitindo que o esquema evolua junto com o código,
de forma declarativa e reprodutível. Não exige dependências além do ecossistema Mojo e
do driver DBI/DBD::Pg, eliminando a necessidade de um ORM pesado para o stack
cloud-native.

## Referenciada em
- ADR-016: Acesso a Dados Relacional — Mojo::Pg e Migrations
- [ADR-022](../adrs/ADR-022-filas-em-postgresql.md): proposta (não aceita) de
  filas em PostgreSQL — todo acesso ao PgQue seria feito via `Mojo::Pg`, sem
  dependência XS nova
