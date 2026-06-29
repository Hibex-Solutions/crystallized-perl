---
sidebar_position: 1
title: Primeiros Passos
---

# Primeiros Passos

Bem-vindo ao **Crystallized Perl** — um stack completo e opinativo para construir
serviços de internet modernos em Perl: aplicações web, APIs HTTP e workers em background.

---

## O que você vai encontrar aqui

Esta documentação é organizada em quatro seções:

| Seção | Conteúdo |
|-------|---------|
| **Primeiros Passos** | Esta seção — visão geral, pré-requisitos e orientação |
| [**Guias**](/guides) | Tutoriais passo a passo usando a aplicação [Stega](/adrs/ADR-018-aplicacao-de-demonstracao) como referência |
| [**Stack**](/stack) | Referência rápida por tecnologia — comandos, padrões, armadilhas |
| [**Decisões (ADRs)**](/adrs/ADR-000-padrao-de-adrs) | Architectural Decision Records — o porquê de cada escolha |

---

## Para quem é este stack

Este projeto é para desenvolvedores que querem construir **serviços de internet em
Perl moderno** e preferem seguir um stack decidido a avaliar infinitas opções.

Assume-se que você:
- Conhece os fundamentos de Perl (variáveis, referências, módulos)
- Sabe o básico de HTTP e serviços web
- Tem familiaridade com linha de comando e Git
- Conhece Docker (ou quer aprender junto com o stack)

Se você é novo em Perl, o livro [*Modern Perl*](/references/modern-perl-book) é o
ponto de partida recomendado antes de seguir os guias.

---

## Pré-requisitos globais

Todos os guias desta documentação partem dos seguintes pré-requisitos:

### Ferramentas obrigatórias

| Ferramenta | Versão mínima | Verificação |
|-----------|--------------|-------------|
| Git | 2.40+ | `git --version` |
| Docker | 24+ | `docker --version` |
| Docker Compose | v2 (embutido no Docker) | `docker compose version` |

### Perl local (apenas para guias fora de Docker)

Se você preferir rodar Perl diretamente no sistema (sem Docker):

| Plataforma | Ferramenta | Versão |
|-----------|-----------|--------|
| Linux / macOS | perlbrew | qualquer versão recente |
| Windows | berrybrew | qualquer versão recente |
| Perl instalado | — | **5.42.2** (versão mínima do stack) |

O [Guia 1](/guides/ambiente-de-desenvolvimento) cobre a instalação passo a passo
para cada plataforma.

---

## A aplicação de referência — Stega

Todos os guias e exemplos de código usam a **Stega** — um sistema de tickets de
suporte para produtos de software — como aplicação de referência canônica.

A Stega foi escolhida porque exercita **todos** os componentes do stack:

- Frontend server-rendered com autenticação Keycloak (OIDC)
- API REST com contrato OpenAPI v3
- PostgreSQL com JSONB, busca full-text e migrations
- Fila local de jobs com Minion (PostgreSQL backend)
- Worker de notificações com RabbitMQ (AMQP 0-9-1)

Você não implementa a Stega do zero nos guias. Os guias usam o **repositório
`hibex-solutions/crystallized-perl-stega`** como contexto e focam no aspecto
técnico sendo ensinado. Consulte o [ADR-018](/adrs/ADR-018-aplicacao-de-demonstracao)
para o design completo da aplicação.

---

## Por onde começar

### Se você quer seguir a trilha de guias

Siga os guias na ordem numérica — cada um pressupõe o anterior:

1. [**Guia 1 — Ambiente de Desenvolvimento**](/guides/ambiente-de-desenvolvimento):
   instala Perl 5.42, Carton e sobe os serviços locais com Docker Compose
2. [**Guia 2 — Estrutura Mínima de Projeto**](/guides/estrutura-minima-de-projeto):
   cria o esqueleto da Stega com `cpanfile`, `.gitattributes` e DEVELOPMENT.md
3. [**Guia 3 — Primeira Rota com Mojolicious**](/guides/primeira-rota-mojolicious):
   implementa o `GET /healthz` e a estrutura de controllers da aplicação

### Se você quer entender as decisões

Leia as ADRs em ordem crescente, começando pelo
[ADR-000 (padrão de ADRs)](/adrs/ADR-000-padrao-de-adrs) e
[ADR-004 (Mojolicious)](/adrs/ADR-004-framework-web-mojolicious).

### Se você quer consultar uma tecnologia específica

Vá direto à seção [Stack](/stack) e encontre a página da tecnologia que você precisa.

---

## Princípios que guiam cada decisão

Antes de mergulhar nos guias, vale entender os cinco princípios não negociáveis
do stack — eles aparecem em cada ADR:

1. **Reference-first** — toda decisão cita ao menos uma fonte externa autoritativa
2. **Decision transparency** — cada escolha tem uma ADR com motivação e alternativas
3. **Stack cohesion** — este projeto define *um* stack, não um menu de opções
4. **Modern Perl** — Perl 5.42+ obrigatório; padrões arcaicos são explicitamente proibidos
5. **Cloud-native first** — tudo roda em containers; desenvolvimento local usa Docker Compose
