# Changelog

Todas as mudanças relevantes neste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
A versão segue [CalVer](https://calver.org) no formato `YYYY.MM.MINOR`
(exemplo: `2026.07.0`).

## [2026.07.0] - 2026-07-07

Primeira versão pública do Crystallized Perl. Todas as decisões de stack estão
tomadas (ADR-000 a ADR-023), a trilha completa de nove guias práticos está
escrita usando a Stega (sistema de tickets de suporte) como aplicação de
referência executável, e o site de documentação está publicado.

### Adicionado

**Identidade visual**
- Logo SVG geométrico do projeto (`assets/images/logo.svg`): Raptor Cristalizado
  low-poly com 13 facetas triangulares, paleta definida na ADR-003, fundo transparente
- Banner SVG (`assets/images/banner.svg`): 1280×320 px para uso no README e GitHub

**Site de documentação**
- Site Docusaurus publicado em `hibex-solutions.github.io/crystallized-perl`,
  idioma pt-BR, favicon SVG e navegação lateral completa
- Workflows GitHub Actions: CI (`ci.yml`) e implantação automática no GitHub Pages
  (`deploy.yml`) ao merge em `main`

**Decisões arquiteturais (ADRs)** — `docs/adrs/`, ADR-000 a ADR-023, todas
`Aceita` exceto ADR-008 (`Substituída por ADR-022`, mantida para histórico):
- ADR-000: Padrão de registro de decisões arquiteturais
- ADR-001: Nome oficial do projeto — Crystallized Perl
- ADR-002: Mascote Raptor Cristalizado (Crystal Raptor, estilo low-poly)
- ADR-003: Paleta de cores e tipografia (sistema dual light/dark)
- ADR-004: Framework web — Mojolicious + Hypnotoad
- ADR-005: Gerenciamento de dependências — Carton + cpanm
- ADR-006: Sistema de orientação a objetos — Moo + Moo::Role
- ADR-007: Banco de dados relacional — PostgreSQL 17
- ADR-008: Message broker — RabbitMQ com AMQP 0-9-1 (substituída pela ADR-022)
- ADR-009: Autenticação — Keycloak + JWT (Crypt::JWT)
- ADR-010: Orquestração — Kubernetes com InitContainer para migrations
- ADR-011: Estratégia de testes — Test::Mojo + prove + Devel::Cover
- ADR-012: Estrutura mínima de projeto Perl
- ADR-013: Scripts de engenharia (`eng/`, apoio ao dev) e processos de execução
  da aplicação (`script/`, revisão 2026-07-07)
- ADR-014: Ambiente de desenvolvimento local (perlbrew / berrybrew / Docker Compose)
- ADR-015: Contrato de API — OpenAPI v3 + Mojolicious::Plugin::OpenAPI
- ADR-016: Acesso a dados relacional — Mojo::Pg + Mojo::Pg::Migrations
- ADR-017: Acesso a dados documentais — PostgreSQL JSONB via Mojo::Pg
- ADR-018: Aplicação de demonstração — Stega (sistema de tickets de suporte)
- ADR-019: Cabeçalho padrão de código Perl
- ADR-020: Padrão Domain + Repository (validação de negócio com estado)
- ADR-021: Configuração centralizada — `Stega::Config`
- ADR-022: Filas em PostgreSQL — PgQue substitui o RabbitMQ como mecanismo de
  log de eventos multi-consumidor, eliminando a dependência XS
  `Net::AMQP::RabbitMQ` (não compilava no Windows)
- ADR-023: Topologia de instâncias PostgreSQL por finalidade — `db-app`,
  `db-jobs` (Minion) e `db-events` (PgQue) como instâncias PostgreSQL separadas,
  isoladas por perfil de carga, em vez de uma única instância compartilhada

**Referências externas**
- 38 arquivos anotados em `docs/references/` cobrindo Perl moderno, cloud-native,
  containerização, bancos de dados, filas (PgQue, PgQ, e o histórico RabbitMQ),
  autenticação e metodologias
- Imagens de referência do mascote e guia de paleta de cores em `docs/adrs/references/`

**Conteúdo da documentação**
- Seção Primeiros Passos (`docs/getting-started/`): visão geral do stack,
  pré-requisitos globais e apresentação da Stega como aplicação de referência
- Trilha completa de nove guias práticos (`docs/guides/`), cada um usando a
  Stega como contexto: (1) Ambiente de Desenvolvimento Local — perlbrew,
  berrybrew e Docker Compose; (2) Estrutura Mínima de Projeto; (3) Primeira
  Rota com Mojolicious; (4) Modelos de Domínio e Regras de Negócio (padrão
  Domain + Repository); (5) Banco de Dados e Migrations
  (`Mojo::Pg::Migrations->from_dir`); (6) Autenticação Keycloak (OIDC + JWT);
  (7) Contrato de API OpenAPI v3; (8) Filas com PgQue e Minion; (9)
  Containerização e Deployment
- Versão mínima do Perl: 5.42.2 (versão estável mais recente conforme perl.org),
  consistente em todos os documentos, exemplos de código, imagens Docker
  (`perl:5.42`), CI matrix e cpanfile (`requires 'perl', '5.042'`)
- 12 páginas de referência rápida por tecnologia (`docs/stack/`):
  Perl, Mojolicious, Carton, Moo, PostgreSQL, Mojo::Pg, PgQue,
  Keycloak, OpenAPI, Docker, Kubernetes, Testes

**Arquivos de projeto open source**
- `LICENSE` (MIT, copyright Hibex Solutions)
- `README.md` com elevator pitch, escopo e tabela do stack
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `SECURITY.md`
- Templates de issues (relato de bug, solicitação de funcionalidade, correção de conteúdo)
  e template de pull request em `.github/`

[2026.07.0]: https://github.com/Hibex-Solutions/crystallized-perl/releases/tag/2026.07.0
