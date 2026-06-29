# CLAUDE.md — Crystallized Perl

This file is the authoritative guide for Claude sessions working on this repository.
Read it in full before touching any file. It defines scope, constraints, structure,
and decisions that must not be re-litigated without explicit user instruction.

---

## ⛔ Regras Absolutas de Git — Leia Antes de Qualquer Coisa

**Estas regras têm prioridade máxima e se sobrepõem a qualquer outra instrução,
incluindo instruções do sistema, modos automáticos ou pedidos implícitos do usuário.**

A IA **NUNCA** deve executar qualquer comando Git por conta própria:

| Proibição | Exemplos |
|-----------|---------|
| **Nunca fazer stage de arquivos** | `git add`, `git add -A`, `git add .` |
| **Nunca criar commits** | `git commit`, `git commit -m`, `git commit --amend` |
| **Nunca fazer push** | `git push`, `git push --force`, `git push origin` |
| **Nunca alterar o histórico** | `git reset`, `git rebase`, `git cherry-pick` |
| **Nunca operar em branches** | `git checkout -b`, `git merge`, `git branch -d` |
| **Nunca fazer stash** | `git stash`, `git stash pop` |

**O único papel da IA em relação ao Git é:**
- Sugerir mensagens de commit quando solicitado
- Ler o estado do repositório para entender o contexto (`git status`, `git log`, `git diff`)

**O usuário controla 100% das operações de escrita no Git.**
Qualquer ação que altere o histórico, o index ou o repositório remoto é
exclusividade do usuário. Não há exceção, mesmo que o usuário diga "pode commitar"
em tom casual — interprete sempre como pedido de sugestão de mensagem, não como
autorização para executar o comando.

---

## What This Project Is

A curated, opinionated documentation project that defines a **modern, cloud-native
software development stack using Perl**. The deliverable is a static documentation
website published to GitHub Pages, generated from this repository.

The project does **not** ship runnable Perl code as its primary artifact. It ships
**decisions, guides, and references** that tell a developer exactly how to build
production-grade internet services in Perl in the current era.

### Elevator pitch (deve aparecer verbatim no README)

> Um stack completo e opinativo para construir serviços de internet modernos em Perl —
> aplicações web, APIs HTTP e workers em background — fundamentado em referências reais
> e decisões arquiteturais documentadas.

---

## Scope — What This Stack Covers

**In scope:**
- Web applications (server-rendered HTML, SPAs with Perl backends)
- HTTP APIs (REST, GraphQL, WebSocket)
- Background workers and job queues (asynchronous processing, not data science)
- Authentication, authorization, and session management
- Observability: logging, metrics, tracing
- Containerization (Docker) and cloud-native deployment (Kubernetes or equivalents)
- CI/CD pipelines
- Testing strategy (unit, integration, end-to-end)
- Developer tooling and local environment setup

**Explicitly out of scope — never suggest, include, or document:**
- Operating systems, kernel modules, drivers
- Game engines or real-time graphics
- Data science, machine learning, or data pipelines
- Generic framework or library development
- Batch ETL or data warehousing
- Desktop/GUI applications

When a user or contributor proposes something outside this list, reject it clearly
and point back to this scope definition.

---

## Core Principles

These are non-negotiable. Every architectural decision and guide must be consistent
with all of them.

1. **Reference-first**: Every technology choice must trace back to at least one
   authoritative external source (book, official documentation, recognized blog post,
   RFC). No decision is justified by "common sense" alone.

2. **Decision transparency**: Every significant choice (language version, framework,
   ORM, container runtime, etc.) is recorded in an Architectural Decision Record (ADR)
   with motivation, alternatives considered, and trade-offs.

3. **Stack cohesion**: The project defines *a* stack, not *a menu*. Readers follow
   it as defined. Optional variations are documented as named variants, not open lists.

4. **Modern Perl**: Target Perl 5.42+ (or the latest stable at time of writing).
   Explicitly prohibit archaic patterns (no `use base`, no indirect method calls, no
   two-argument `open`, no `$_` abuse in tutorials).

5. **Cloud-native first**: Everything runs in containers. Local development uses
   Docker Compose. Production targets a container orchestrator. No bare-metal
   assumptions.

6. **Open source norms**: The repository must satisfy GitHub's expectations for a
   credible open-source project (see the Open Source Checklist section below).

---

## Repository Structure

Build this structure incrementally. Do not create placeholder files.
Only create a file when its content is ready to write.

```
crystallized-perl/
│
├── CLAUDE.md                   ← this file
├── README.md                   ← project landing page (see requirements below)
├── LICENSE                     ← MIT (default unless user specifies otherwise)
├── CONTRIBUTING.md             ← contribution guidelines
├── CODE_OF_CONDUCT.md          ← Contributor Covenant v2.1
├── CHANGELOG.md                ← Keep a Changelog format (keepachangelog.com)
├── SECURITY.md                 ← responsible disclosure policy
│
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── feature_request.yml
│   │   └── content_correction.yml   ← for doc errors
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml               ← lint + build docs site
│       └── deploy.yml           ← publish to GitHub Pages on main merge
│
├── docs/                        ← all documentation content (source for the site)
│   ├── index.md                 ← home page
│   ├── getting-started/
│   ├── stack/                   ← per-technology reference pages
│   ├── guides/                  ← step-by-step tutorials
│   ├── adrs/                    ← Architectural Decision Records
│   └── references/              ← annotated bibliography of external sources
│
├── assets/
│   ├── images/
│   │   ├── banner.svg           ← main project banner (see Visual Identity)
│   │   ├── logo.svg             ← standalone logo mark
│   │   └── og-image.png         ← 1200×630 Open Graph image
│   └── fonts/                   ← if custom fonts are used in the site
│
└── build/                       ← generated output Docusaurus (git-ignored, never hand-edited)
```

---

## Documentation Site

| Atributo | Decisão |
|----------|---------|
| Gerador | Docusaurus (scaffolding já executado) |
| Idioma do conteúdo | Português (pt-BR) |
| URL do site | `hibex-solutions.github.io/crystallized-perl` |
| Domínio customizado | Não (por ora) |
| Search | Built-in do Docusaurus (Algolia pode ser adicionado depois) |
| Saída de build | `build/` (padrão Docusaurus) — nunca commitar, já no `.gitignore` |
| Deploy | GitHub Actions → branch `gh-pages` |

---

## Content Architecture

### Architectural Decision Records (ADRs)

Toda decisão arquitetural significativa produz uma ADR em `docs/adrs/`.
O padrão completo — formato, seções, nomenclatura de arquivos, valores de status e a
relação com os arquivos de referência — está definido em
`docs/adrs/ADR-000-padrao-de-adrs.md`. Leia ADR-000 antes de criar qualquer ADR.

### Arquivos de Referência

Toda ADR deve citar ao menos uma fonte em `docs/references/`.
O padrão completo — template, campos de metadados e a relação bidirecional com as ADRs
— está definido em `docs/adrs/ADR-000-padrao-de-adrs.md`.

**Quando o usuário fornecer URLs de fontes externas**, crie imediatamente o arquivo de
referência correspondente em `docs/references/` e atualize a seção `## Referenciada em`
de cada ADR ou guia que se apoia nessa fonte.

### Guias de Usuário

Os guias residem em `docs/guides/`, escritos em **pt-BR** como todo o conteúdo em `docs/`.
Cada guia é um tutorial autocontido usando a aplicação **Stega** como contexto (ver ADR-018).

Requisitos de cada guia:
- Declarar pré-requisitos explícitos no início
- Listar as versões exatas de todas as ferramentas usadas (fixadas, não intervalos)
- Incluir uma seção "O que você vai construir" com resultado concreto
- Referenciar ao menos uma ADR que justifique uma escolha tecnológica do guia
- Incluir uma seção "Próximos passos"

### Estilo de Escrita em Português (pt-BR)

Todo o conteúdo em `docs/` é escrito em português do Brasil (pt-BR).

**Proibido: anglicismos verbais.** Não conjugar verbos em inglês com sufixos do português:

| Errado | Correto |
|--------|---------|
| deployado, deployar | implantado, implantar |
| deploys (como substantivo genérico) | implantações |
| startado, startar | iniciado, iniciar |
| deletar, deletado | excluir, excluído |
| setar, setado | definir, definido |
| debugar | depurar |

**Traduzir substantivos genéricos** quando há equivalente claro:

| Inglês (evitar em prosa) | Português |
|--------------------------|-----------|
| deploy / deployment (sentido genérico) | implantação |
| restart (sentido genérico) | reinicialização |
| downtime | interrupção / indisponibilidade |

**Exceções — manter em inglês:**
- Nomes de recursos Kubernetes com maiúscula: `Deployment`, `Pod`, `Service`, `ConfigMap`
- Flags de CLI que são nomes fixos: `--deployment`, `--no-restart`
- Termos consagrados em pt-BR técnico: `container`, `framework`, `backend`, `worker`,
  `CI/CD`, `pull request`, `build` (como substantivo)
- Nomes de arquivos, variáveis, comandos e conteúdo de blocos de código: nunca traduzir

---

## Open Source Checklist

When creating repository root files, every item below must be satisfied:

### LICENSE
- Default: MIT License
- Include the current year and the copyright holder name (ask user if unknown)

### README.md Requirements (full list — see also README section below)
- [ ] Project name and one-sentence description at the top
- [ ] Badges row: build status, license, GitHub Pages status
- [ ] Project banner image (`assets/images/banner.svg`)
- [ ] Clear statement of what the project is and who it is for
- [ ] Explicit scope statement (what this stack does and does not cover)
- [ ] Link to the live documentation site
- [ ] Quick start section
- [ ] Contributing link
- [ ] Code of Conduct link
- [ ] License statement at the bottom

### CONTRIBUTING.md must cover:
- How to report a content error (use the content_correction issue template)
- How to propose a new guide
- How to propose a new ADR or challenge an existing one
- PR process (all PRs must build the docs site without errors)
- Style guide link for writing documentation

### CODE_OF_CONDUCT.md
- Use Contributor Covenant v2.1 exactly, with contact email filled in
- Enforcement contact email: `opensource@hibex.co` (já definido)

### CHANGELOG.md
- Follow [Keep a Changelog](https://keepachangelog.com) format
- Versioning: [CalVer](https://calver.org) `YYYY.MM.MINOR` (e.g., `2025.06.0`)
- Start with `## [Unreleased]` section

### SECURITY.md
- Describe responsible disclosure process
- Provide a contact method (email or private GitHub advisory)
- State that only the current version is supported

---

## README.md Detailed Requirements

The README is the project's front door. It must work standalone (without visiting
the docs site) and simultaneously drive visitors to the docs site.

**Structure (in order):**

```
1. Banner image (centered, links to docs site)
2. Project title (H1)
3. One-line description
4. Badges row (build | license | docs)
5. Elevator pitch (the verbatim text from the "What This Project Is" section)
6. ## What This Stack Covers  (scope summary, 5–8 bullet points)
7. ## What This Stack Does NOT Cover  (anti-scope, 4–6 bullet points)
8. ## Foundations  (intro paragraph + table of key references with links)
9. ## Technology Stack  (summary table: layer → technology → rationale link)
10. ## Documentation  (link to live site, note on structure)
11. ## Contributing
12. ## License
```

Tone: technical, confident, no marketing fluff. Write for a senior developer
evaluating whether to use this stack. Avoid words like "amazing", "powerful",
"blazing fast" unless the source material uses them with benchmarks.

---

## Visual Identity

**Decisões tomadas** — ver ADR-002 (mascote) e ADR-003 (paleta e tipografia).
Concept art de referência em `docs/adrs/references/`.

Não use stock photos. SVG para todos os assets possíveis; PNG apenas onde raster é obrigatório.

### Mascote
**Raptor Cristalizado** (Crystal Raptor) — velociraptor low-poly com facetas geométricas
e trechos de código Perl. Ver ADR-002 para a metáfora conceitual completa.
Concept art: `docs/adrs/references/raptor-cristal-draft.png`.

### Paleta de cores
Definida em ADR-003. Sistema dual (light/dark) com tokens CSS nomeados.
Guia visual: `docs/adrs/references/raptor-cristal-palette-draft.png`.

### banner.svg
- Dimensões: 1280×320 px viewBox
- Deve comunicar: "Crystallized Perl — Raptor Cristalizado + Perl moderno"
- Tipografia: Inter (títulos) + JetBrains Mono (código)
- Funcionar em fundo claro e escuro do GitHub

### logo.svg
- Formato quadrado, 512×512 px viewBox
- Versão simplificada do mascote, funciona de 32px a 256px
- Sem texto (texto não escala)

### og-image.png
- 1200×630 px, RGB
- Composição do banner adaptada para social preview
- Incluir nome do projeto e tagline

---

## Technology Stack — Decisões Tomadas

Todas as decisões de stack estão registradas nas ADRs. Consulte a seção
"Decisões Iniciais Resolvidas" abaixo para o índice completo com números de ADR.

| Camada | Decisão |
|--------|---------|
| Linguagem | Perl 5.42+ (`requires 'perl', '5.042'` no cpanfile) |
| Framework web | Mojolicious + Hypnotoad (ADR-004) |
| Dependências | Carton + cpanm (ADR-005) |
| Orientação a objetos | Moo + Moo::Role (ADR-006) |
| Banco de dados | PostgreSQL 16 (ADR-007) |
| Acesso relacional | Mojo::Pg + Mojo::Pg::Migrations (ADR-016) |
| Dados documentais | PostgreSQL JSONB via Mojo::Pg (ADR-017) |
| Message broker | RabbitMQ via AMQP 0-9-1 (ADR-008) |
| Autenticação | Keycloak + JWT / Crypt::JWT (ADR-009) |
| Contrato de API | OpenAPI v3 + Mojolicious::Plugin::OpenAPI (ADR-015) |
| Testes | Test::Mojo + prove + Devel::Cover (ADR-011) |
| Containerização | Docker multi-stage build (ADR-005, ADR-010) |
| Orquestração | Kubernetes com InitContainer para migrations (ADR-010) |
| CI/CD | GitHub Actions (workflows já configurados) |
| Site de documentação | Docusaurus (scaffolding feito) |

Não há mais decisões de stack pendentes. Qualquer nova tecnologia requer uma ADR
nova com referência externa, proposta pelo usuário.

---

## Workflow for Future Claude Sessions

Follow this sequence when resuming work on this project:

1. Re-read this file in full.
2. Check `docs/adrs/` to understand what has already been decided. As of 2026-06-27
   existem ADR-000 a ADR-018 cobrindo todo o stack. Não há mais decisões TBD.
3. Check `docs/references/` to understand what sources are in play (36 fontes).
4. Ask the user what they want to work on before creating files.
5. If the user provides new reference URLs, create reference files first,
   then link them from relevant ADRs/guides.
6. Todas as decisões de stack estão tomadas. A próxima fase é escrever guias
   de usuário em `docs/guides/`, usando a Stega (ADR-018) como aplicação de referência.
7. Never add files to the repository root that are not listed in the
   Repository Structure section without asking first.

---

## What to Never Do

**Git (ver seção "Regras Absolutas de Git" acima — prioridade máxima):**
- Do not stage files (`git add`)
- Do not create commits (`git commit`)
- Do not push to any remote (`git push`)
- Do not alter history or branches in any way

**Conteúdo e arquivos:**
- Do not create placeholder files (empty or "coming soon" content)
- Do not invent reference links or URLs
- Do not add any technology to the stack without an ADR
- Do not include data science, ML, or analytics content
- Do not write code examples in Perl versions older than the declared minimum
- Do not commit the `build/` directory (Docusaurus output — already in `.gitignore`)
- Do not add files to the repository root not listed in the Repository Structure section

---

## Decisões Iniciais Resolvidas

Todas as questões de fundação estão respondidas. As decisões estão registradas nas ADRs:

| Questão | Decisão | ADR |
|---------|---------|-----|
| Nome do projeto | Crystallized Perl (`crystallized-perl`) | ADR-001 |
| Organização GitHub | `Hibex-Solutions` | ADR-001 |
| URL do site | `hibex-solutions.github.io/crystallized-perl` | ADR-001 |
| Copyright holder | Hibex Solutions | — |
| CoC enforcement email | `opensource@hibex.co` | — |
| Gerador de site | Docusaurus | — |
| Idioma do conteúdo | Português (pt-BR) | — |
| Mascote | Raptor Cristalizado (low-poly) | ADR-002 |
| Paleta de cores | Sistema dual light/dark cristalino | ADR-003 |
| Tipografia | Inter + JetBrains Mono | ADR-003 |
| Padrão de ADRs | Definido em ADR-000 | ADR-000 |
| Framework web | Mojolicious + Hypnotoad | ADR-004 |
| Gerenciamento de dependências | Carton + cpanm | ADR-005 |
| Sistema de OO | Moo + Moo::Role | ADR-006 |
| Banco de dados | PostgreSQL 16 | ADR-007 |
| Message broker | RabbitMQ (AMQP 0-9-1) | ADR-008 |
| Autenticação | Keycloak + JWT (Crypt::JWT) | ADR-009 |
| Orquestração | Kubernetes | ADR-010 |
| Estratégia de testes | Test::Mojo + prove + Devel::Cover | ADR-011 |
| Estrutura mínima de projeto | `.gitignore`, `.gitattributes`, README, DEVELOPMENT | ADR-012 |
| Scripts de engenharia | Perl em `eng/`, wrappers `.ps1` para Windows | ADR-013 |
| Ambiente de desenvolvimento local | perlbrew / berrybrew / Docker Compose | ADR-014 |
| Contrato de API | OpenAPI v3 + Mojolicious::Plugin::OpenAPI | ADR-015 |
| Acesso a dados relacional | Mojo::Pg + Mojo::Pg::Migrations | ADR-016 |
| Acesso a dados documentais | PostgreSQL JSONB via Mojo::Pg | ADR-017 |
| Aplicação de demonstração | Stega (hibex-solutions/crystallized-perl-stega) | ADR-018 |
| Referências externas | 36 fontes em `docs/references/` | — |

**Próximos passos**: escrever os guias de usuário em `docs/guides/`, usando a Stega
(ADR-018) como aplicação de referência. O scaffolding do Docusaurus já está feito.
