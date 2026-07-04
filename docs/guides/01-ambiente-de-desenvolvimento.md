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
- **Docker Compose** rodando PostgreSQL 17, RabbitMQ 4.3 e Keycloak 26.6
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
perlbrew --notest install perl-5.42.2
perlbrew switch perl-5.42.2
```

A instalação compila Perl a partir do código-fonte — leva alguns minutos.

:::info Por que `--notest`?
Por padrão o perlbrew executa o conjunto de testes do próprio interpretador Perl
após a compilação. Esses testes verificam o interpretador, não o seu código, e
frequentemente falham em instalações Linux mínimas por fatores do ambiente
(locales não configurados, bibliotecas opcionais ausentes). O binário compilado
é funcional mesmo quando alguns testes falham — `--notest` apenas pula essa etapa.
Para um ambiente de desenvolvimento, isso é adequado.
:::

Verifique:

```bash
perl -v
# This is perl 5, version 42, subversion 2 (v5.42.2)
```

### 5. Instalar cpanm e Carton

```bash
perlbrew install-cpanm
cpanm --notest Carton
```

`--notest` pula a suíte de testes das dependências transitivas do Carton (`Menlo`,
`Parse::PMFile`, etc.) — mesma razão do `--notest` usado na instalação do Perl acima:
os testes verificam o pacote em si, não o seu código, e podem falhar por fatores do
ambiente sem que o módulo deixe de funcionar.

Verifique:

```bash
carton --version
# Carton version X.X.XX
```

Pule para [Clonar e configurar a Stega](#clonar-e-configurar-a-stega).

---

## Caminho B — berrybrew (Windows) {#caminho-b-berrybrew-windows}

### 1. Instalar o berrybrew

O repositório oficial e ativamente mantido é
[`stevieb9/berrybrew`](https://github.com/stevieb9/berrybrew) — o projeto nasceu em
`dnmfarrell/berrybrew`, mas a manutenção foi transferida para Steve Bertrand, e o
próprio README do repositório original aponta para lá.

Duas formas de instalar (execute como Administrador — berrybrew precisa alterar o
`PATH` de sistema):

```powershell
# Opção A — instalador: baixe e execute berrybrewInstaller.exe a partir de
# https://github.com/stevieb9/berrybrew

# Opção B — clonar e configurar manualmente
git clone https://github.com/stevieb9/berrybrew
cd berrybrew
bin\berrybrew.exe config
```

Abra um novo terminal PowerShell após a instalação.

### 2. Instalar Perl 5.42.2 com Strawberry

```powershell
berrybrew fetch              # atualiza a lista de versões disponíveis
berrybrew available          # lista versões disponíveis
berrybrew install 5.42.2_64
berrybrew switch 5.42.2_64
```

`berrybrew available` lê de uma lista **local em cache** — numa instalação nova, essa
lista costuma estar desatualizada e não mostra versões recentes como `5.42.2_64`.
`berrybrew fetch` atualiza esse cache a partir do repositório de versões antes de
listar; sem isso, a versão que você procura pode simplesmente não aparecer.

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
cpanm --notest Carton
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
# .env — valores padrão para desenvolvimento local (copie de .env.example)

# Aplicação — conexão principal
POSTGRESQL_URL=postgresql://postgres:postgres_dev@localhost:5432/stega

# Migration — mesma conexão em desenvolvimento (usuários distintos em produção)
POSTGRESQL_MIGRATION_URL=postgresql://postgres:postgres_dev@localhost:5432/stega

# RabbitMQ
RABBITMQ_HOST=localhost
RABBITMQ_USER=stega
RABBITMQ_PASSWORD=dev_password

# Keycloak
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=stega
KEYCLOAK_CLIENT_ID=stega-web

# Modo de teste: aceita tokens HS256 sem Keycloak em execução
TEST_JWT_SECRET=test_secret_apenas_para_desenvolvimento
```

### 3. Iniciar os serviços de apoio

**Caminho A ou B (Perl nativo):**

```bash
# Sobe apenas PostgreSQL, RabbitMQ e Keycloak — sem a aplicação
docker compose up -d postgres rabbitmq keycloak
```

**Caminho C (Docker Compose completo):**

```bash
# Sobe tudo: serviços de apoio + aplicação + workers (perfil "full")
docker compose --profile full up
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

**Windows nativo**: `Net::AMQP::RabbitMQ` falha ao instalar
(`undefined reference to 'poll'`) — é uma limitação real do pacote no MinGW/Winsock, não uma falta de
ferramenta. Os demais módulos instalam normalmente; esse módulo só é usado pelo
worker de notificações da Stega. Veja a tabela de "Solução de problemas comuns" no
final deste guia.

### 5. Aplicar as migrations do banco

```bash
# Caminhos A e B (Perl nativo):
carton exec perl eng/migrate.pl

# Caminho C (dentro do container):
docker compose exec app perl eng/migrate.pl
```

As 9 migrations da Stega (`migrations/1/` a `migrations/9/`, cada uma com
`up.sql`/`down.sql` — ver [ADR-016](/adrs/ADR-016-acesso-a-dados-relacional-mojo-pg))
criam as tabelas `users`, `products`, `tickets`, `comments`, `events`, `tags` e
`ticket_tags`; a migration 8 relaxa a constraint `UNIQUE` do campo `email` na
tabela `users` (o identificador primário é `keycloak_id`, não o e-mail).

### 6. Popular com dados de exemplo

```bash
# Caminhos A e B:
carton exec perl eng/seed.pl

# Caminho C:
docker compose exec app perl eng/seed.pl
```

### 7. Iniciar a aplicação (caminhos A e B)

```bash
carton exec perl script/stega daemon --listen http://*:3000
```

Para o Caminho C, a aplicação já está rodando após `docker compose --profile full up`
(os serviços `migrate`, `seed` e `app` sobem automaticamente nessa ordem).

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
carton exec prove -lv t/001_health.t

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
| `perlbrew install` falha em testes | Suite de testes do interpretador falha por fatores do ambiente | Use `perlbrew --notest install perl-5.42.2` |
| `DBD::Pg` falha ao instalar | Compilador C ausente | Use berrybrew (já inclui MinGW) ou Docker Compose |
| Keycloak lento para iniciar | Primeira inicialização | Normal — aguarde ~45 segundos |
| `berrybrew available` não lista a versão desejada | Cache local de versões desatualizado | Rode `berrybrew fetch` antes de `berrybrew available` |
| `cpanm Carton` falha ao construir `Parse::PMFile` (ou outra dependência transitiva) | Suite de testes de uma dependência do Carton falha no ambiente, sem que o módulo deixe de funcionar | Use `cpanm --notest Carton` — confirmado funcional no Windows/berrybrew |
| `Net::AMQP::RabbitMQ` falha ao instalar no Windows (`undefined reference to 'poll'`) | O módulo embute um cliente C (`rabbitmq-c`) que assume `poll()`, ausente no MinGW/Winsock — limitação real do pacote, não resolvível com `--notest`/`--force` | Use o Caminho C (Docker Compose) para o que depender desse módulo; o restante da aplicação funciona com Perl nativo, já que o módulo só é carregado por código de worker/notificação |
| `perl`/`prove` sem `carton exec` "funciona" mesmo assim | Strawberry Perl empacota módulos comuns (ex.: `Moo`) em `perl/vendor/lib` — o comando acidentalmente usa essa cópia global em vez da versão travada no `cpanfile.snapshot` | Sempre prefixe `carton exec`; confirme com `carton exec perl -MMoo -e "print $INC{'Moo.pm'}"` — deve apontar para `local/lib/perl5`, nunca para `vendor/lib` |
| `carton exec perl`/`carton exec prove` sai atrasado ou corrompido no Windows | Windows não tem `exec()` real, só emulação por spawn+wait — `carton exec` sempre adiciona uma camada de processo extra, o que afeta a sincronia de qualquer saída (não só `prove`); no `prove`, que usa retorno de carro (`\r`) para a linha de progresso, o mesmo problema aparece como texto sobreposto/corrompido em vez de só atrasado | Encadeie `\| Out-Host` em qualquer comando que imprime para o terminal: `carton exec perl eng\migrate.pl \| Out-Host`, `carton exec prove -lr t\ \| Out-Host` |
| `\| Out-Host` corrige a sincronia mas os acentos saem corrompidos (`Vers├úo`) | `[Console]::OutputEncoding` do PowerShell normalmente não é UTF-8; o pipeline decodifica a saída (que já está em UTF-8 correto) com o codepage errado | Rode uma vez por sessão: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 \| Out-Null` |

---

## Próximos passos

Com o ambiente funcionando, prossiga para:

- [**Guia 2 — Estrutura Mínima de Projeto**](/guides/estrutura-minima-de-projeto):
  entenda a estrutura de arquivos que o stack exige em todo projeto Crystallized Perl
- [**Stack — Carton**](/stack/carton): referência rápida para o gerenciador de dependências
- [**ADR-014**](/adrs/ADR-014-ambiente-de-desenvolvimento-local): os critérios por trás
  da escolha entre perlbrew, berrybrew e Docker Compose
