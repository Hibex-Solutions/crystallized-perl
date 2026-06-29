# ADR-012: Estrutura Mínima de Projeto Crystallized Perl

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Todo projeto que segue o stack Crystallized Perl precisa de um conjunto consistente
de arquivos de configuração e documentação desde o primeiro commit. Sem uma estrutura
padronizada, cada projeto desenvolve convenções próprias que dificultam a integração
entre equipes e invalidam os guias do stack. A estrutura mínima deve resolver três
problemas simultaneamente:

1. **Portabilidade de plataforma**: linha de fim de arquivo (CRLF vs. LF) entre
   Windows e Linux/macOS causa falhas silenciosas em scripts shell e no Perl executado
   dentro de containers (ver ADR-014).
2. **Rastreabilidade de versão**: a versão do Perl usada pelo projeto deve ser
   declarada explicitamente e visível no repositório, não apenas no ambiente local.
3. **Onboarding documentado**: um desenvolvedor novo deve conseguir rodar o projeto
   localmente com os arquivos do repositório como única referência.

## Decisão

Todo projeto Crystallized Perl inicia com os seguintes arquivos obrigatórios:

```
projeto/
├── .gitignore
├── .gitattributes
├── cpanfile              ← inclui 'requires perl, 5.042' como primeira linha
├── cpanfile.snapshot     ← gerado pelo Carton, versionado no Git
├── Dockerfile
├── docker-compose.yml
├── README.md             ← instruções mínimas de uso
├── DEVELOPMENT.md        ← guia detalhado de configuração para contribuidores
├── eng/                  ← scripts de engenharia em Perl (ver ADR-013)
├── lib/                  ← código da aplicação
├── migrations/           ← arquivos SQL de migration (ver ADR-016)
├── script/               ← ponto de entrada Mojolicious
└── t/                    ← testes (ver ADR-011)
```

## Justificativa

### .gitignore

Baseado no template `Perl.gitignore` da coleção oficial do GitHub
([github/gitignore](../references/github-gitignore.md)), adaptado para o stack:

```gitignore
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

# Carton — dependências instaladas localmente (nunca commitar)
local/

# Variáveis de ambiente locais (nunca commitar credenciais)
.env
.env.local
.env.*.local

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

**Nota**: `cpanfile.snapshot` é **incluído** no Git (não listado acima). Ele garante
reprodutibilidade das dependências entre ambientes (ver ADR-005).

### .gitattributes

Garante que todos os arquivos de texto usem LF independentemente do SO do
desenvolvedor — essencial para evitar falhas ao executar scripts dentro de containers
Linux a partir de um checkout Windows (ver ADR-014):

```gitattributes
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

# Markdown / Documentação
*.md   text eol=lf

# PowerShell (Windows — manter CRLF)
*.ps1 text eol=crlf
```

**Exceção intencional**: arquivos `.ps1` usam CRLF — alguns terminais Windows e o
próprio PowerShell se comportam melhor com CRLF em scripts PowerShell.

### Declaração de versão do Perl no cpanfile

A versão mínima do Perl é declarada como primeira linha do `cpanfile`:

```perl
requires 'perl', '5.042';   # versão mínima — ver ADR-005

requires 'Mojolicious',              '9.0';
requires 'Mojo::Pg',                 '4.0';
requires 'Moo',                      '2.0';
# ... demais dependências
```

Isso torna a versão visível para `carton check`, para ferramentas de CI e para
qualquer desenvolvedor que abra o arquivo. A versão local instalada é gerenciada
por perlbrew ou berrybrew (ver ADR-014).

### README.md mínimo

O `README.md` de todo projeto deve conter as seções abaixo com o nível de detalhe
suficiente para executar o projeto localmente sem buscar documentação externa:

```markdown
# Nome do Projeto

Descrição de uma linha.

## Pré-requisitos

- Docker e Docker Compose
- Perl 5.42+ (via perlbrew ou berrybrew — ver DEVELOPMENT.md)
- Carton (`cpanm Carton`)

## Executando localmente

```bash
# 1. Copiar variáveis de ambiente
cp .env.example .env

# 2. Iniciar serviços de apoio e a aplicação
docker compose up
```

## Rodando os testes

```bash
carton exec prove -lr t/
# ou dentro do container:
docker compose exec app carton exec prove -lr t/
```

## Gerando a imagem Docker

```bash
docker build -t nome-do-projeto:dev .
```

## Documentação

Consulte `DEVELOPMENT.md` para o guia completo de configuração
do ambiente de desenvolvimento.
```

### DEVELOPMENT.md

Guia detalhado destinado a desenvolvedores que contribuem com o projeto. Estrutura
mínima obrigatória:

```markdown
# Guia de Desenvolvimento

## Índice
1. Visão geral do ambiente
2. Instalando o Perl local
3. Instalando as dependências do projeto
4. Variáveis de ambiente
5. Iniciando os serviços
6. Fluxo de trabalho
7. Rodando os testes

## 1. Visão geral do ambiente

Este projeto usa Perl 5.42+ gerenciado localmente (sem depender do Perl do sistema
operacional). As dependências são gerenciadas pelo Carton. Os serviços de apoio
(PostgreSQL, RabbitMQ) rodam via Docker Compose.

## 2. Instalando o Perl local

**Linux / macOS — perlbrew**

Consulte a documentação oficial: https://perlbrew.pl/

```bash
\curl -L https://install.perlbrew.pl | bash
source ~/perl5/perlbrew/etc/bashrc  # adicionar ao .bashrc/.zshrc
perlbrew install perl-5.42.2
perlbrew switch perl-5.42.2
```

**Windows — berrybrew**

Consulte a documentação oficial: https://github.com/dnmfarrell/berrybrew

```powershell
berrybrew install 5.42.2_64
berrybrew switch 5.42.2_64
```

## 3. Instalando as dependências do projeto

```bash
cpanm Carton           # instalar o Carton globalmente
carton install         # instalar dependências declaradas no cpanfile
```

## 4. Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste os valores:

```bash
cp .env.example .env
```

Variáveis obrigatórias (ver ADR-016 para a separação de credenciais de banco):

```bash
# Aplicação — usuário DML (SELECT, INSERT, UPDATE, DELETE)
POSTGRESQL_URL=postgresql://myapp_app:dev_password@localhost/myapp

# Migration — usuário DDL (CREATE, ALTER, DROP) — usado pelo eng/migrate.pl
POSTGRESQL_MIGRATION_URL=postgresql://myapp_migrate:dev_password@localhost/myapp

# RabbitMQ
RABBITMQ_HOST=localhost
RABBITMQ_USER=myapp
RABBITMQ_PASSWORD=dev_password

# Keycloak (para desenvolvimento local com Keycloak via Docker Compose)
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=myapp
KEYCLOAK_CLIENT_ID=myapp-api
JWT_ISSUER=http://localhost:8080/realms/myapp
JWT_AUDIENCE=myapp-api
```

Documente todas as variáveis em `.env.example` com valores de exemplo.

## 5. Iniciando os serviços

```bash
docker compose up -d postgres rabbitmq   # só os serviços de apoio
carton exec perl script/my_app.pl daemon # aplicação em modo de desenvolvimento
```

## 6. Fluxo de trabalho

Scripts auxiliares em `eng/` (ver ADR-013):

```bash
# Linux/macOS
perl eng/migrate.pl     # aplicar migrations
perl eng/seed.pl        # popular banco para desenvolvimento

# Windows (PowerShell)
.\eng\migrate.ps1
.\eng\seed.ps1
```

## 7. Rodando os testes

```bash
carton exec prove -lr t/
```
```

Referências: [github/gitignore](../references/github-gitignore.md),
[Perlbrew](../references/perlbrew.md),
[berrybrew](../references/berrybrew.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Sem .gitattributes** | Desenvolvedor Windows gera CRLF silenciosamente; scripts falham dentro de containers Linux sem mensagem clara de erro |
| **Versão do Perl apenas em documentação** | Texto de documentação envelhece sem alerta; `cpanfile` é verificado pelo Carton automaticamente |
| **Um único README.md com todo o conteúdo** | README longo afasta visitantes do repositório; DEVELOPMENT.md mantém a integração detalhada de contribuidores separada do panorama público |
| **Makefile para tarefas auxiliares** | Requer Make instalado (ausente por padrão no Windows); não aproveita o conhecimento Perl da equipe |

## Consequências

**Positivo**:
- Qualquer desenvolvedor que clone o repositório encontra instruções válidas imediatamente
- `.gitattributes` elimina a classe de erros CRLF/LF de forma declarativa e automática
- A versão mínima do Perl é validada pelo Carton em `carton install`
- Estrutura de diretórios consistente entre todos os projetos do stack

**Negativo**:
- Custo inicial de criar esses arquivos para cada projeto novo
- `.env.example` precisa ser mantido sincronizado com as variáveis reais usadas

**Ações necessárias**:
- Criar `.env.example` com todas as variáveis obrigatórias e valores de exemplo
- Configurar `git config core.autocrlf false` como pré-requisito documentado
  no DEVELOPMENT.md para desenvolvedores Windows (complementar ao `.gitattributes`)
- Criar scripts de engenharia iniciais em `eng/` (ver ADR-013)
