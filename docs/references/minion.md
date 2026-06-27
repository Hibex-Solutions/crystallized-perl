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

A distinção central entre Minion e RabbitMQ (ADR-008) é o escopo:

| Característica | Minion | RabbitMQ |
|----------------|--------|----------|
| Processo | Mesmo ecossistema (worker Perl) | Processo independente, qualquer linguagem |
| Roteamento | Por tipo de task | Por exchange + routing key |
| Backend | PostgreSQL (já no stack) | Broker externo dedicado |
| Caso de uso | Jobs internos persistentes | Integração entre serviços distintos |

Na aplicação Stega (ADR-018), o Minion processa jobs que pertencem ao domínio
da aplicação (verificação de SLA, processamento de webhooks recebidos, relatórios),
enquanto o RabbitMQ conecta a Stega com serviços externos de notificação.

## Referenciada em

- [ADR-008](../adrs/ADR-008-message-broker-rabbitmq.md) — Minion citado como alternativa complementar ao RabbitMQ para jobs internos
- [ADR-018](../adrs/ADR-018-aplicacao-de-demonstracao.md) — Stega usa Minion com `Minion::Backend::Pg` para jobs assíncronos internos
