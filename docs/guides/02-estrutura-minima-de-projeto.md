---
sidebar_position: 2
title: "Guia 2 — Estrutura Mínima de Projeto"
---

# Guia 2 — Estrutura Mínima de Projeto Perl com Carton

> **Referências arquiteturais**:
> [ADR-012 — Estrutura Mínima de Projeto](/adrs/ADR-012-estrutura-minima-de-projeto) ·
> [ADR-005 — Carton + cpanm](/adrs/ADR-005-gerenciamento-de-dependencias)

---

## O que você vai construir

Ao final deste guia você terá a estrutura de arquivos obrigatória para qualquer
projeto Crystallized Perl, criada a partir do zero como esqueleto da Stega:

```
crystallized-perl-stega/
├── .gitignore
├── .gitattributes
├── cpanfile              ← dependências declaradas com versões fixas
├── cpanfile.snapshot     ← versões transitivas congeladas pelo Carton
├── DEVELOPMENT.md        ← guia de configuração para contribuidores
├── local/                ← módulos instalados (ignorado pelo Git)
├── lib/                  ← código da aplicação (ainda vazio)
├── migrations/           ← arquivos SQL (ainda vazio)
├── script/               ← ponto de entrada Mojolicious (ainda vazio)
└── t/                    ← testes (ainda vazio)
```

---

## Pré-requisitos

- [Guia 1](/guides/ambiente-de-desenvolvimento) concluído
- Perl **5.42.2** ativo (`perl -v` confirma)
- **Carton** instalado (`carton --version` confirma)
- Git configurado com `core.autocrlf false` (Windows)

---

## Passo 1 — Criar o repositório

```bash
mkdir crystallized-perl-stega
cd crystallized-perl-stega
git init
```

---

## Passo 2 — .gitattributes (primeiro arquivo sempre)

O `.gitattributes` deve ser o primeiro arquivo criado. Ele garante que todos os
arquivos de texto usem LF independentemente do sistema operacional do desenvolvedor —
crítico para scripts executados dentro de containers Linux:

```gitattributes
# .gitattributes

# Força LF em todos os arquivos de texto
* text=auto eol=lf

# Perl
*.pl text eol=lf
*.pm text eol=lf
*.t  text eol=lf

# Shell
*.sh text eol=lf

# SQL
*.sql text eol=lf

# YAML / JSON / TOML
*.yml  text eol=lf
*.yaml text eol=lf
*.json text eol=lf
*.toml text eol=lf

# Markdown
*.md text eol=lf

# PowerShell — manter CRLF (terminais Windows se comportam melhor)
*.ps1 text eol=crlf
```

**Por que `.gitattributes` antes de qualquer código?** Sem ele, um desenvolvedor
Windows que clone o repositório obterá CRLF silenciosamente em todos os arquivos.
Scripts com CRLF falham dentro de containers Linux com erros confusos como
`/usr/bin/env: 'perl\r': No such file or directory`.

---

## Passo 3 — .gitignore

```gitignore
# .gitignore

# Carton — módulos instalados localmente (nunca commitar)
local/

# Variáveis de ambiente locais (nunca commitar credenciais)
.env
.env.local
.env.*.local

# Perl — artefatos de build
blib/
*.bak
*.old
*.orig
*.rej
pm_to_blib
Makefile
Makefile.old
MYMETA.json
MYMETA.yml
META.yml
META.json

# Cobertura de testes
cover_db/

# macOS
.DS_Store

# Windows
Thumbs.db

# Editores
.vscode/
.idea/
*.swp
*.swo
```

**Atenção**: `cpanfile.snapshot` é **incluído** no Git (não listado acima). Ele
garante que todos os ambientes instalem as mesmas versões de módulos.

---

## Passo 4 — cpanfile

O `cpanfile` declara as dependências da Stega com versões mínimas fixadas.
A primeira linha declara a versão mínima de Perl — validada automaticamente
pelo Carton:

```perl
# cpanfile

# Versão mínima do Perl — ver ADR-012 e ADR-005
requires 'perl', '5.042';

# Framework web (ADR-004)
requires 'Mojolicious',                  '9.0';

# Contrato de API OpenAPI v3 (ADR-015)
requires 'Mojolicious::Plugin::OpenAPI', '5.0';

# Acesso a banco de dados (ADR-016)
requires 'Mojo::Pg',                     '4.0';

# Sistema de OO para modelos de domínio (ADR-006)
requires 'Moo',                          '2.0';
requires 'namespace::clean';

# Autenticação JWT (ADR-009)
requires 'Crypt::JWT';

# RabbitMQ — publicação não-bloqueante da aplicação (ADR-008)
requires 'Mojo::RabbitMQ::Client';

# RabbitMQ — consumo bloqueante no worker (ADR-008)
requires 'Net::AMQP::RabbitMQ';

# Fila local de jobs (ADR-018)
requires 'Minion';
requires 'Minion::Backend::Pg';

# Dependências de teste — não incluídas na imagem de produção
on 'test' => sub {
    requires 'Test::More';
    requires 'Test::MockObject';
    requires 'Devel::Cover';
};
```

---

## Passo 5 — Instalar as dependências com Carton

```bash
carton install
```

O Carton:
1. Lê o `cpanfile`
2. Resolve todas as dependências transitivas
3. Instala os módulos em `local/`
4. Gera (ou atualiza) o `cpanfile.snapshot` com as versões exatas de tudo

Verifique o snapshot gerado:

```bash
head -5 cpanfile.snapshot
# CHECKSUMS 1
# ...
# Carton v1.0.34 snapshot
# ...
```

**Adicionar uma nova dependência** segue o mesmo fluxo:

```bash
# 1. Declarar no cpanfile
echo "requires 'Some::Module';" >> cpanfile

# 2. Instalar e atualizar o snapshot
carton install
```

---

## Passo 6 — DEVELOPMENT.md

O `DEVELOPMENT.md` é destinado a desenvolvedores que contribuem com o projeto.
Deve ser suficiente para rodar o projeto localmente sem consultar documentação
externa:

```markdown
# Guia de Desenvolvimento — Stega

## Visão geral

A Stega usa Perl 5.42+ (gerenciado por perlbrew/berrybrew — não modifique o
Perl do sistema). Dependências são gerenciadas pelo Carton. Serviços de apoio
(PostgreSQL, RabbitMQ, Keycloak) rodam via Docker Compose.

## Pré-requisitos

- Docker Desktop 4.28+
- Perl 5.42.2 via perlbrew (Linux/macOS) ou berrybrew (Windows)
- Carton: `cpanm Carton`

## Setup inicial

```bash
# 1. Clonar
git clone https://github.com/hibex-solutions/crystallized-perl-stega.git
cd crystallized-perl-stega

# 2. Copiar variáveis de ambiente
cp .env.example .env

# 3. Instalar dependências
carton install

# 4. Subir serviços de apoio
docker compose up -d postgres rabbitmq keycloak

# 5. Aplicar migrations
carton exec perl eng/migrate.pl

# 6. Popular dados de exemplo
carton exec perl eng/seed.pl

# 7. Iniciar a aplicação
carton exec perl script/stega daemon --listen http://*:3000
```

## Variáveis de ambiente obrigatórias

Consulte `.env.example` — todas as variáveis estão documentadas com valores
de exemplo para desenvolvimento local.

## Rodando os testes

```bash
carton exec prove -lr t/
```

## Scripts de engenharia (`eng/`)

| Script | O que faz |
|--------|-----------|
| `perl eng/migrate.pl` | Aplica migrations pendentes |
| `perl eng/seed.pl` | Popula banco com dados de exemplo |
| `perl eng/setup.pl` | Verifica dependências do ambiente |
| `perl eng/worker.pl` | Inicia o NotificationWorker RabbitMQ |
```

---

## Passo 7 — Criar diretórios de código

```bash
mkdir -p lib/Stega/Controller
mkdir -p lib/Stega/Model
mkdir -p lib/Stega/Job
mkdir -p lib/Stega/Worker
mkdir -p migrations
mkdir -p script
mkdir -p t/unit/model
mkdir -p t/api
mkdir -p t/integration
mkdir -p eng
mkdir -p api
```

---

## Passo 8 — Verificar a estrutura

```bash
find . -not -path './.git/*' -not -path './local/*' | sort
```

Resultado esperado:

```
.
./.gitattributes
./.gitignore
./DEVELOPMENT.md
./api/
./cpanfile
./cpanfile.snapshot
./eng/
./lib/
./lib/Stega/
./lib/Stega/Controller/
./lib/Stega/Job/
./lib/Stega/Model/
./lib/Stega/Worker/
./migrations/
./script/
./t/
./t/api/
./t/integration/
./t/unit/
./t/unit/model/
```

---

## Por que cada arquivo existe

| Arquivo/Diretório | Propósito | Referência |
|------------------|-----------|-----------|
| `.gitattributes` | Garante LF em todos os sistemas operacionais | [ADR-012](/adrs/ADR-012-estrutura-minima-de-projeto) |
| `.gitignore` | Evita que `local/` e credenciais sejam commitados | [ADR-012](/adrs/ADR-012-estrutura-minima-de-projeto) |
| `cpanfile` | Declara dependências com versões mínimas | [ADR-005](/adrs/ADR-005-gerenciamento-de-dependencias) |
| `cpanfile.snapshot` | Congela versões exatas (commitado no Git) | [ADR-005](/adrs/ADR-005-gerenciamento-de-dependencias) |
| `local/` | Módulos instalados pelo Carton (não commitado) | [ADR-005](/adrs/ADR-005-gerenciamento-de-dependencias) |
| `DEVELOPMENT.md` | Guia de configuração inicial para novos contribuidores | [ADR-012](/adrs/ADR-012-estrutura-minima-de-projeto) |
| `lib/` | Código Perl da aplicação (namespaces `Stega::`) | [ADR-004](/adrs/ADR-004-framework-web-mojolicious) |
| `migrations/` | Arquivos SQL de migration (`NNN_descricao.sql`) | [ADR-016](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg) |
| `script/` | Ponto de entrada Mojolicious | [ADR-004](/adrs/ADR-004-framework-web-mojolicious) |
| `t/` | Testes organizados em `unit/`, `api/`, `integration/` | [ADR-011](/adrs/ADR-011-estrategia-de-testes) |
| `eng/` | Scripts de engenharia em Perl | [ADR-013](/adrs/ADR-013-scripts-de-engenharia) |
| `api/` | Contrato OpenAPI v3 (`stega.yaml`) | [ADR-015](/adrs/ADR-015-contrato-de-api-openapi-v3) |

---

## Próximos passos

Com a estrutura criada, prossiga para:

- [**Guia 3 — Primeira Rota com Mojolicious**](/guides/primeira-rota-mojolicious):
  cria `lib/Stega.pm`, o script principal e o primeiro controller
- [**Stack — Carton**](/stack/carton): referência rápida para o ciclo de uso do Carton
- [**Stack — Perl**](/stack/perl): convenções Perl 5.42 que o stack exige
