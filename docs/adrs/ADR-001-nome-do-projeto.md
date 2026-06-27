# ADR-001: Nome Oficial do Projeto

**Status**: Aceita  
**Data**: 2026-06-26

## Contexto

Antes de criar qualquer estrutura de documentação ou site, o nome oficial do projeto
precisa ser formalizado. O repositório foi inicializado com o slug provisório
`modern-perl-cloud-native-stack` — descritivo, mas genérico e sem identidade própria.
O processo de definição da identidade visual (ADR-002, ADR-003) consolidou uma metáfora
central — a cristalização do Perl — que deve se refletir no próprio nome do projeto.

## Decisão

### Identidade do projeto

| Atributo | Valor |
|----------|-------|
| **Nome de exibição** | Crystallized Perl |
| **Slug / repo** | `crystallized-perl` |
| **Organização GitHub** | `Hibex-Solutions` |
| **URL do repositório** | `github.com/Hibex-Solutions/crystallized-perl` |
| **URL do site** | `hibex-solutions.github.io/crystallized-perl` |
| **Tagline** (pt-BR, para o site) | Um stack completo e opinativo para construir serviços de internet modernos em Perl |

### Descrição do repositório (GitHub About)

A descrição fica visível na página principal do repositório e nos resultados de busca do
GitHub. Deve ser em inglês para maximizar a descoberta internacional, e cabe em até
350 caracteres.

> Opinionated cloud-native Perl stack for building modern internet services — web apps,
> REST APIs, and background workers. Reference architecture with documented architectural
> decisions (ADRs).

### Tópicos do repositório (GitHub Topics)

Tópicos aparecem como tags clicáveis no repositório e aumentam a descoberta por categoria.
O GitHub recomenda até 20 tópicos; todos em minúsculo, palavras separadas por hífen.

**Conjunto inicial** (configurar ao criar/renomear o repositório):

| Tópico | Categoria |
|--------|-----------|
| `perl` | Linguagem |
| `perl5` | Linguagem (versão) |
| `cloud-native` | Paradigma |
| `docker` | Infraestrutura (princípio já decidido) |
| `web-development` | Escopo |
| `rest-api` | Escopo |
| `background-jobs` | Escopo |
| `twelve-factor-app` | Metodologia |
| `reference-architecture` | Tipo de projeto |
| `adr` | Metodologia de decisão |
| `best-practices` | Propósito |
| `documentation` | Tipo de projeto |

**A adicionar conforme ADRs de stack forem definidas** (framework web, banco de dados,
message broker, etc.): tópicos como `mojolicious`, `postgresql`, `rabbitmq` devem ser
incluídos somente após as respectivas ADRs serem aceitas.

## Justificativa

O nome *Crystallized Perl* captura a tese central do projeto: o Perl clássico —
poderoso, mas muitas vezes percebido como amorfo — submetido a um processo de
cristalização. Cristalização é o fenômeno pelo qual uma substância adquire estrutura
geométrica precisa e repetível. A metáfora é direta:

- A **substância** é o Perl, com todo o seu poder e história
- A **estrutura** são as boas práticas modernas, os padrões cloud-native, as decisões
  arquiteturais documentadas que este projeto registra
- O **resultado** é algo transparente, preciso e lapidado — sem perder a natureza original

O nome também é coerente com o mascote (ADR-002) e com a paleta de cores (ADR-003),
formando uma identidade visual e verbal unificada.

> Referência interna: [`references/RASCUNHO.md`](references/RASCUNHO.md) — brief de
> identidade inicial do projeto, seção "Uma Metáfora Conceitual".

Referências externas:
- [`perl-org`](../references/perl-org.md) — portal oficial; confirma o Perl como linguagem ativa com ecossistema organizado
- [`wikipedia-perl`](../references/wikipedia-perl.md) — contexto histórico da linguagem desde 1987
- [`modern-perl-book`](../references/modern-perl-book.md) — referência do conceito "Modern Perl" que o nome abraça

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| `modern-perl-cloud-native-stack` (slug provisório) | Descritivo mas genérico; sem identidade; não carrega a metáfora |
| Perl Prism | Bela metáfora, mas foca na refração da luz, não no processo de transformação |
| Faceted Perl | Foca no resultado visual (facetas); *crystallized* captura melhor o processo |
| Polished Perl | Metáfora mais abstrata; aliteração não compensa a perda de precisão conceitual |

## Consequências

- **Positivo**: Nome com identidade própria, diretamente derivado da metáfora central
- **Positivo**: Slug curto, memorizável e sem ambiguidade com outras linguagens ou projetos
- **Negativo**: O repositório atual (`modern-perl-cloud-native-stack`) precisa ser renomeado
  no GitHub — operação simples nas configurações do repositório, mas que invalida URLs antigas
- **Ação necessária**: Renomear o repositório em `github.com/Hibex-Solutions/modern-perl-cloud-native-stack`
  para `crystallized-perl` via GitHub Settings antes de publicar qualquer link externo
