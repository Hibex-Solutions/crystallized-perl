# [Minion](https://docs.mojolicious.org/Minion)

**Tipo**: Documentação Oficial  
**Autor(es)**: Sebastian Riedel e colaboradores  
**Publicado**: 2014 (atualizado continuamente)  
**Acessado**: 2026-06-27

## Relevância

Minion é o sistema de filas de jobs nativo do ecossistema Mojolicious. Oferece
jobs persistentes com retry automático, prioridades, agendamento, concorrência
configurável e uma interface web de administração. Suporta múltiplos backends;
no stack Crystallized Perl, usa `Minion::Backend::Pg` — o mesmo PostgreSQL
da aplicação, sem serviço adicional.

A distinção central entre Minion e PgQue (ADR-022) é o escopo — ambos hoje em
PostgreSQL, mas em instâncias dedicadas distintas (`db-jobs`/`db-events`, ADR-023):

| Característica | Minion | PgQue |
|----------------|--------|-------|
| Processo | Mesmo ecossistema (worker Perl) | Consumidores nomeados, fan-out real |
| Roteamento | Por tipo de task | Por tipo de evento (`type`), cursor por consumidor |
| Backend | PostgreSQL, instância `db-jobs` | PostgreSQL, instância `db-events` |
| Caso de uso | Jobs internos persistentes | Notificação de múltiplos consumidores desacoplados |

Na aplicação Stega (ADR-018), o Minion processa jobs que pertencem ao domínio
da aplicação (verificação de SLA, processamento de webhooks recebidos, relatórios),
enquanto o PgQue conecta a Stega com serviços externos de notificação
(`NotificationWorker`).

## Referenciada em

- [ADR-008](../adrs/ADR-008-message-broker-rabbitmq.md) — Minion citado como
  alternativa complementar ao RabbitMQ para jobs internos (histórico)
- [ADR-018](../adrs/ADR-018-aplicacao-de-demonstracao.md) — Stega usa Minion com `Minion::Backend::Pg` para jobs assíncronos internos
- [ADR-022](../adrs/ADR-022-filas-em-postgresql.md) — cita `Minion::Backend::Pg`
  como prova de conceito já em produção do padrão `SKIP LOCKED`/`LISTEN`/`NOTIFY`
  que fundamenta a adoção do PgQue no lugar do RabbitMQ (aceita em 2026-07-07)
- [ADR-023](../adrs/ADR-023-topologia-de-instancias-postgresql.md) — Minion passa
  a usar uma instância PostgreSQL própria (`db-jobs`), nunca a mesma de `db-app`
- [ADR-024](../adrs/ADR-024-jobs-assincronos-multiplataforma.md) — `Minion.pm`
  não roda nativamente no Windows (`fork()` emulado via ithreads); ADR `Proposta`,
  pendência de pesquisa sobre se o PgQue pode cobrir os cenários de job atuais
