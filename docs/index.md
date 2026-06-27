---
slug: /
title: Início
sidebar_position: 1
---

# Crystallized Perl

> Um stack completo e opinativo para construir serviços de internet modernos em Perl —
> aplicações web, APIs HTTP e workers em background — fundamentado em referências reais
> e decisões arquiteturais documentadas.

---

## O que é este projeto

**Crystallized Perl** define *um* stack — não um cardápio de opções.
Cada camada tecnológica está documentada em uma Architectural Decision Record (ADR)
com motivação, alternativas consideradas e consequências.
Cada decisão rastreia ao menos uma fonte externa autoritativa.

O projeto cobre:

- Aplicações web com HTML server-rendered e SPAs com backend Perl
- APIs HTTP: REST, GraphQL e WebSocket
- Workers em background e filas de jobs
- Autenticação, autorização e gerenciamento de sessões
- Observabilidade: logging, métricas e rastreamento distribuído
- Containerização com Docker e implantação cloud-native
- Pipelines de CI/CD e estratégia de testes

## Por onde começar

### Leia as decisões fundacionais

As primeiras quatro ADRs estabelecem o padrão de documentação e a identidade do projeto:

| ADR | Decisão |
|-----|---------|
| [ADR-000](/adrs/ADR-000-padrao-de-adrs) | Padrão de registro de decisões (este formato) |
| [ADR-001](/adrs/ADR-001-nome-do-projeto) | Nome oficial: Crystallized Perl |
| [ADR-002](/adrs/ADR-002-mascote-raptor-cristal) | Mascote: Raptor Cristalizado |
| [ADR-003](/adrs/ADR-003-paleta-de-cores-e-tipografia) | Paleta de cores e tipografia |

### Explore as referências

O projeto mantém uma [biblioteca anotada de 36 fontes externas](/references/perl-org)
que fundamentam cada decisão arquitetural — livros, documentações oficiais, RFCs e
referências da comunidade.

## Princípios não negociáveis

1. **Reference-first** — toda decisão cita ao menos uma fonte externa documentada
2. **Decision transparency** — cada escolha significativa tem uma ADR com motivação e alternativas
3. **Stack cohesion** — este projeto define *um* stack, não um menu de opções
4. **Modern Perl** — Perl 5.38+ obrigatório; padrões arcaicos explicitamente proibidos
5. **Cloud-native first** — tudo roda em containers; desenvolvimento local usa Docker Compose

## Contribuindo

Leia o [guia de contribuição](https://github.com/Hibex-Solutions/crystallized-perl/blob/main/CONTRIBUTING.md)
antes de abrir um pull request. Em especial as seções sobre como propor uma nova ADR
e como corrigir erros de conteúdo.
