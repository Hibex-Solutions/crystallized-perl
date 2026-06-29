---
sidebar_position: 1
title: "Guia 1 — Ambiente de Desenvolvimento"
---

# Guia 1 — Ambiente de Desenvolvimento Local

> **Referência arquitetural**: [ADR-014 — Ambiente de Desenvolvimento Local](/adrs/ADR-014-ambiente-de-desenvolvimento-local)

---

## O que você vai construir

Ao final deste guia você terá um ambiente de desenvolvimento funcional com:

- Perl **5.42.2** instalado e isolado do Perl do sistema operacional
- **Carton** configurado para gerenciamento de dependências do projeto
- **Docker Compose** rodando PostgreSQL 16, RabbitMQ 3 e Keycloak 25
- O repositório `crystallized-perl-stega` clonado e com dependências instaladas
- A aplicação Stega iniciada em modo de desenvolvimento em `http://localhost:3000`

---

## Pré-requisitos

| Ferramenta | Versão mínima | Observação |
|-----------|--------------|------------|
| Git | 2.40+ | `git --version` |
| Docker Desktop | 4.28+ | inclui Docker Engine 24+ e Compose v2 |

Nenhum Perl precisa estar pré-instalado — o guia instala a versão correta.

---

## Escolha seu caminho

O stack suporta três caminhos de desenvolvimento:

| Caminho | Plataforma | Paridade com produção |
|---------|-----------|----------------------|
| [perlbrew](#caminho-a-perlbrew-linuxmacos) | Linux / macOS | Alta |
| [berrybrew](#caminho-b-berrybrew-windows) | Windows | Alta |
| [Docker Compose completo](#caminho-c-docker-compose-recomendado) | Qualquer | **Máxima (recomendado)** |

O caminho C (Docker Compose) é o mais próximo do ambiente de produção Kubernetes
e elimina diferenças entre plataformas. Os caminhos A e B são adequados para quem
prefere rodar Perl diretamente no sistema.

---

## Caminho A — perlbrew (Linux/macOS) {#caminho-a-perlbrew-linuxmacos}

### 1. Instalar ferramentas de compilação (Linux)

O perlbrew compila o Perl a partir do código-fonte. Em distribuições Linux sem
ambiente de desenvolvimento instalado, os pacotes de compilação precisam ser
instalados primeiro:

```bash
# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y build-essential libssl-dev zlib1g-dev

# Fedora / RHEL / CentOS
sudo dnf install -y gcc make openssl-devel zlib-devel
```

No macOS as ferramentas de linha de comando do Xcode já suprem esse requisito:

```bash
xcode-select --install
```

### 2. Instalar o perlbrew

```bash
\curl -L https://install.perlbrew.pl | bash
```

A barra invertida em `\curl` contorna aliases do shell e garante o binário real.

### 3. Ativar no shell

Adicione ao seu `.bashrc` ou `.zshrc`:

```bash
source ~/perl5/perlbrew/etc/bashrc
```

Recarregue o shell:

```bash
source ~/.bashrc   # ou source ~/.zshrc
```

### 4. Instalar Perl 5.42.2

```bash
perlbrew install perl-5.42.2
perlbrew switch perl-5.42.2
```

A instalação compila Perl a partir do código-fonte — leva alguns minutos.

Verifique:

```bash
perl -v
# This is perl 5, version 42, subversion 2 (v5.42.2)
```

### 5. Instalar cpanm e Carton

```bash
perlbrew install-cpanm
cpanm Carton
```

Verifique:

```bash
carton --version
# Carton version X.X.XX
```

Pule para [Clonar e configurar a Stega](#clonar-e-configurar-a-stega).

---

## Caminho B — berrybrew (Windows) {#caminho-b-berrybrew-windows}

### 1. Instalar o berrybrew

Baixe e execute o instalador do
[repositório oficial](https://github.com/dnmfarrell/berrybrew/releases).

Abra um novo terminal PowerShell após a instalação.

### 2. Instalar Perl 5.42.2 com Strawberry

```powershell
berrybrew available          # lista versões disponíveis
berrybrew install 5.42.2_64
berrybrew switch 5.42.2_64
```

Verifique:

```powershell
perl -v
# This is perl 5, version 42, subversion 2 (v5.42.2)
```

### 3. Configurar CRLF no Git

Ao usar Docker em Windows com containers Linux, arquivos CRLF causam falhas
silenciosas em scripts executados dentro de containers. Configure antes de clonar
qualquer repositório:

```powershell
git config --global core.autocrlf false
```

### 4. Instalar Carton

```powershell
cpanm Carton
```

Pule para [Clonar e configurar a Stega](#clonar-e-configurar-a-stega).

---

## Caminho C — Docker Compose (recomendado) {#caminho-c-docker-compose-recomendado}

Este caminho usa containers para tudo: Perl, PostgreSQL, RabbitMQ e Keycloak.
Nenhum Perl local é necessário — o container usa a mesma imagem de produção.

Verifique o Docker:

```bash
docker compose version
# Docker Compose version v2.x.x
```

Pule direto para [Clonar e configurar a Stega](#clonar-e-configurar-a-stega) —
o `compose.yml` da Stega inicia todos os serviços, incluindo a aplicação.

---

## Clonar e configurar a Stega

### 1. Clonar o repositório

```bash
git clone https://github.com/hibex-solutions/crystallized-perl-stega.git
cd crystallized-perl-stega
```

### 2. Copiar as variáveis de ambiente

```bash
cp .env.example .env
```

O arquivo `.env.example` contém valores pré-configurados para desenvolvimento local.
Para o caminho A ou B (Perl nativo), ajuste as URLs de banco se necessário:

```bash
# .env — valores padrão para desenvolvimento local

# Aplicação — usuário DML (SELECT, INSERT, UPDATE, DELETE)
POSTGRESQL_URL=postgresql://stega_app:dev_password@localhost:5432/stega

# Migration — usuário DDL (CREATE, ALTER, DROP)
POSTGRESQL_MIGRATION_URL=postgresql://stega_migrate:dev_password@localhost:5432/stega

# RabbitMQ
RABBITMQ_HOST=localhost
RABBITMQ_USER=stega
RABBITMQ_PASSWORD=dev_password

# Keycloak
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=stega
KEYCLOAK_CLIENT_ID=stega-api
JWT_ISSUER=http://localhost:8080/realms/stega
JWT_AUDIENCE=stega-api
```

### 3. Iniciar os serviços de apoio

**Caminho A ou B (Perl nativo):**

```bash
# Sobe apenas PostgreSQL, RabbitMQ e Keycloak — sem a aplicação
docker compose up -d postgres rabbitmq keycloak
```

**Caminho C (Docker Compose completo):**

```bash
# Sobe tudo: serviços de apoio + aplicação + workers
docker compose up
```

Aguarde os serviços ficarem saudáveis. O Keycloak leva ~30 segundos para iniciar.

Verifique:

```bash
docker compose ps
# NAME                 STATUS
# stega-postgres       Up (healthy)
# stega-rabbitmq       Up (healthy)
# stega-keycloak       Up (healthy)
```

### 4. Instalar dependências (caminhos A e B apenas)

```bash
carton install
```

O Carton lê o `cpanfile.snapshot` e instala as versões exatas de todos os módulos
no diretório `local/`. Módulos XS como `DBD::Pg` precisam de compilador C —
disponível por padrão no Strawberry Perl (Windows) e nas imagens Perl do Docker.

### 5. Aplicar as migrations do banco

```bash
# Caminhos A e B (Perl nativo):
carton exec perl eng/migrate.pl

# Caminho C (dentro do container):
docker compose exec app carton exec perl eng/migrate.pl
```

As 7 migrations da Stega criam as tabelas: `users`, `products`, `tickets`,
`comments`, `events`, `tags` e `ticket_tags`.

### 6. Popular com dados de exemplo

```bash
# Caminhos A e B:
carton exec perl eng/seed.pl

# Caminho C:
docker compose exec app carton exec perl eng/seed.pl
```

### 7. Iniciar a aplicação (caminhos A e B)

```bash
carton exec perl script/stega daemon --listen http://*:3000
```

Para o Caminho C, a aplicação já está rodando após `docker compose up`.

### 8. Verificar

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

A interface web está disponível em `http://localhost:3000`.

---

## Verificando a instalação completa

```bash
# Perl e Carton
perl -v | grep "version"
carton --version

# Docker e serviços
docker compose ps

# Endpoint de saúde da aplicação
curl -s http://localhost:3000/healthz | grep ok

# Painel do RabbitMQ (Management UI)
# http://localhost:15672 — usuário: stega / senha: dev_password

# Keycloak Admin Console
# http://localhost:8080 — usuário: admin / senha: admin
```

---

## Comandos úteis do dia a dia

```bash
# Rodar os testes
carton exec prove -lr t/

# Rodar um arquivo de teste específico
carton exec prove -lv t/api/health.t

# Reiniciar apenas um serviço de apoio
docker compose restart postgres

# Encerrar tudo
docker compose down

# Encerrar e remover volumes (reseta banco)
docker compose down -v
```

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| `Can't locate Mojo.pm` | Carton não foi rodado ou `carton exec` foi omitido | `carton install && carton exec perl ...` |
| `Connection refused` ao banco | PostgreSQL ainda iniciando | Aguarde `docker compose ps` mostrar `(healthy)` |
| Scripts falham com `\r not found` | CRLF no Windows | `git config --global core.autocrlf false` e re-clone |
| `I can't find make or gmake` | Ferramentas de compilação ausentes no Linux | `sudo apt-get install -y build-essential` (Ubuntu/Debian) |
| `DBD::Pg` falha ao instalar | Compilador C ausente | Use berrybrew (já inclui MinGW) ou Docker Compose |
| Keycloak lento para iniciar | Primeira inicialização | Normal — aguarde ~45 segundos |

---

## Próximos passos

Com o ambiente funcionando, prossiga para:

- [**Guia 2 — Estrutura Mínima de Projeto**](/guides/estrutura-minima-de-projeto):
  entenda a estrutura de arquivos que o stack exige em todo projeto Crystallized Perl
- [**Stack — Carton**](/stack/carton): referência rápida para o gerenciador de dependências
- [**ADR-014**](/adrs/ADR-014-ambiente-de-desenvolvimento-local): os critérios por trás
  da escolha entre perlbrew, berrybrew e Docker Compose
