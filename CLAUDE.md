# CLAUDE.md — Crystallized Perl

This file is the authoritative guide for Claude sessions working on this repository.
Read it in full before touching any file. It defines scope, constraints, structure,
and decisions that must not be re-litigated without explicit user instruction.

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

4. **Modern Perl**: Target Perl 5.38+ (or the latest stable at time of writing).
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
└── site/                        ← generated output (git-ignored, never hand-edited)
```

---

## Documentation Site

**Decisão: Docusaurus** (escolhido pelo usuário).

O scaffolding ainda não foi executado. Quando for iniciado:
- Gerar a configuração na raiz do repositório
- A saída do build vai para `build/` (padrão Docusaurus) e deve estar no `.gitignore`
- Deploy via GitHub Actions para branch `gh-pages`
- Não commitar arquivos gerados na branch `main`

| Atributo | Decisão |
|----------|---------|
| Gerador | Docusaurus |
| Idioma do conteúdo | Português (pt-BR) |
| URL do site | `hibex-solutions.github.io/crystallized-perl` |
| Domínio customizado | Não (por ora) |
| Search | Built-in do Docusaurus (Algolia pode ser adicionado depois) |

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

### Guides

Guides live in `docs/guides/`. Each guide is a self-contained tutorial.

Guide requirements:
- Must state prerequisites at the top
- Must list the exact versions of all tools used (pinned, not ranges)
- Must include a "What you will build" section with a concrete outcome
- Must link to at least one ADR that justifies a technology choice in the guide
- Must include a "Next steps" section

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
- Ask the user for the enforcement contact email before creating this file

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

## Technology Stack Decisions

**These are placeholders until ADRs are written.** Do not treat them as final.
When building ADRs, the user will provide the rationale and reference links.

| Layer | Placeholder | Notes |
|-------|-------------|-------|
| Language | Perl 5.38+ | Confirm exact minimum version |
| Web framework | TBD | User will decide with references |
| ORM / DB access | TBD | User will decide with references |
| Template engine | TBD | User will decide with references |
| Job queue | TBD | User will decide with references |
| HTTP client | TBD | User will decide with references |
| Testing | TBD | User will decide with references |
| Containerization | Docker | Princípio decidido — cloud-native first |
| Orchestration | TBD | Kubernetes vs. alternativas mais simples — ADR pendente |
| CI/CD | GitHub Actions | Matches hosting platform |
| Docs site | Docusaurus | Decidido — scaffolding pendente |

When the user provides their chosen tools and reference URLs, write one ADR per
decision and one reference file per source, then update this table with links.

---

## Workflow for Future Claude Sessions

Follow this sequence when resuming work on this project:

1. Re-read this file in full.
2. Check `docs/adrs/` to understand what has already been decided.
3. Check `docs/references/` to understand what sources are in play.
4. Ask the user what they want to work on before creating files.
5. If the user provides new reference URLs, create reference files first,
   then link them from relevant ADRs/guides.
6. Never invent a technology choice. If something is TBD, ask before filling it in.
7. Never add files to the repository root that are not listed in the
   Repository Structure section without asking first.

---

## What to Never Do

- Do not create placeholder files (empty or "coming soon" content)
- Do not invent reference links or URLs
- Do not add any technology to the stack without an ADR
- Do not include data science, ML, or analytics content
- Do not write code examples in Perl versions older than the declared minimum
- Do not commit the `site/` directory
- Do not use `main` branch for GitHub Pages output (use `gh-pages` branch)
- Do not add a Code of Conduct without the enforcement contact email
- Do not push to the remote repository without explicit user instruction
- Do not create the docs site scaffold until the user has confirmed the site generator

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
| Referências externas | 28 fontes em `docs/references/` | — |

**Próximos passos**: scaffolding do Docusaurus, depois ADRs de stack (framework web,
banco de dados, ORM, message broker, testes, orquestração).
