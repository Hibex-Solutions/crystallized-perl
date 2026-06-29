# Changelog

Todas as mudanças relevantes neste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
A versão segue [CalVer](https://calver.org) no formato `YYYY.MM.MINOR`
(exemplo: `2026.06.0`).

## [Não publicado]

### Adicionado

**Identidade visual**
- Logo SVG geométrico do projeto (`assets/images/logo.svg`): Raptor Cristalizado
  low-poly com 13 facetas triangulares, paleta definida na ADR-003, fundo transparente
- Banner SVG (`assets/images/banner.svg`): 1280×320 px para uso no README e GitHub

**Site de documentação**
- Site Docusaurus configurado para `hibex-solutions.github.io/crystallized-perl`
  com idioma pt-BR, favicon SVG e seis seções na navegação lateral
- Workflows GitHub Actions: CI (`ci.yml`) e implantação automática no GitHub Pages
  (`deploy.yml`) ao merge em `main`

**Decisões arquiteturais (ADRs)**
- ADR-000: Padrão de registro de decisões arquiteturais
- ADR-001: Nome oficial do projeto — Crystallized Perl
- ADR-002: Mascote Raptor Cristalizado (Crystal Raptor, estilo low-poly)
- ADR-003: Paleta de cores e tipografia (sistema dual light/dark)
- ADR-004: Framework web — Mojolicious + Hypnotoad
- ADR-005: Gerenciamento de dependências — Carton + cpanm
- ADR-006: Sistema de orientação a objetos — Moo + Moo::Role
- ADR-007: Banco de dados relacional — PostgreSQL 16
- ADR-008: Message broker — RabbitMQ com AMQP 0-9-1
- ADR-009: Autenticação — Keycloak + JWT (Crypt::JWT)
- ADR-010: Orquestração — Kubernetes com InitContainer para migrations
- ADR-011: Estratégia de testes — Test::Mojo + prove + Devel::Cover
- ADR-012: Estrutura mínima de projeto Perl
- ADR-013: Scripts de engenharia em Perl (`eng/`)
- ADR-014: Ambiente de desenvolvimento local (perlbrew / berrybrew / Docker Compose)
- ADR-015: Contrato de API — OpenAPI v3 + Mojolicious::Plugin::OpenAPI
- ADR-016: Acesso a dados relacional — Mojo::Pg + Mojo::Pg::Migrations
- ADR-017: Acesso a dados documentais — PostgreSQL JSONB via Mojo::Pg
- ADR-018: Aplicação de demonstração — Stega (sistema de tickets de suporte)

**Referências externas**
- 36 arquivos anotados em `docs/references/` cobrindo Perl moderno, cloud-native,
  containerização, bancos de dados, message brokers, autenticação e metodologias
- Imagens de referência do mascote e guia de paleta de cores em `docs/adrs/references/`

**Conteúdo da documentação**
- Seção Primeiros Passos (`docs/getting-started/`): visão geral do stack,
  pré-requisitos globais e apresentação da Stega como aplicação de referência
- Guia 1 — Ambiente de Desenvolvimento Local: perlbrew, berrybrew e Docker Compose;
  versão mínima Perl 5.42.2 (versão estável mais recente conforme perl.org)
- Atualização de versão: Perl 5.38 → 5.42.2 em todos os documentos, exemplos de
  código, imagens Docker (`perl:5.42`), CI matrix e cpanfile (`requires 'perl', '5.042'`)
- Guia 2 — Estrutura Mínima de Projeto: `.gitattributes`, `.gitignore`,
  `cpanfile` e `DEVELOPMENT.md`
- Guia 3 — Primeira Rota com Mojolicious: `Stega.pm`, controllers, `GET /healthz`
  e testes com `Test::Mojo`
- 12 páginas de referência rápida por tecnologia (`docs/stack/`):
  Perl, Mojolicious, Carton, Moo, PostgreSQL, Mojo::Pg, RabbitMQ,
  Keycloak, OpenAPI, Docker, Kubernetes, Testes

**Arquivos de projeto open source**
- `LICENSE` (MIT, copyright Hibex Solutions)
- `README.md` com elevator pitch, escopo e tabela do stack
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `SECURITY.md`
- Templates de issues (relato de bug, solicitação de funcionalidade, correção de conteúdo)
  e template de pull request em `.github/`

[Não publicado]: https://github.com/Hibex-Solutions/crystallized-perl/commits/main
