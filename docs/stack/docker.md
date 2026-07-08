---
sidebar_position: 10
title: Docker + Docker Compose
---

# Docker + Docker Compose

> **Decisão**: Docker multi-stage build para imagens de produção; Docker Compose
> para ambiente de desenvolvimento local com paridade máxima.
> [ADR-005 — Carton + cpanm](/adrs/ADR-005-gerenciamento-de-dependencias) ·
> [ADR-010 — Orquestração Kubernetes](/adrs/ADR-010-orquestracao-kubernetes)

---

## Por que Docker

Todo serviço do stack roda em container. Isso garante:
- **Paridade dev/prod**: mesmas versões do Perl, PostgreSQL (quatro instâncias por finalidade, ADR-023) e Keycloak em todos os ambientes
- **Builds reprodutíveis**: o `cpanfile.snapshot` garante os mesmos módulos em cada `docker build`
- **Isolamento**: cada serviço vive em seu próprio processo sem dependências do SO host

O multi-stage build mantém a imagem de produção limpa: compiladores C
(necessários para módulos XS como `DBD::Pg`) ficam apenas no estágio de build,
não na imagem final.

---

## Dockerfile da Stega

```dockerfile
# ── Estágio de build ─────────────────────────────────────────────────────────
FROM perl:5.42 AS build

WORKDIR /app

# Instalar Carton no estágio de build (tem compilador C)
RUN cpanm --notest Carton

# Cache de layer: copiar arquivos de dependência antes do código
# Se cpanfile.snapshot não mudar, esta layer é reutilizada
COPY cpanfile cpanfile.snapshot ./

# Instalar exatamente as versões do snapshot (sem resolver, sem rede desnecessária)
RUN carton install --deployment

# ── Estágio de teste ─────────────────────────────────────────────────────────
FROM build AS test

# Instalar deps de teste (seção 'on test => sub {...}' do cpanfile)
RUN carton install

# Copiar o código
COPY . .

# Testes bloqueiam a progressão: se falhar, a imagem de produção não é gerada
RUN carton exec prove -lr t/

# ── Estágio de produção ───────────────────────────────────────────────────────
FROM perl:5.42-slim AS production

WORKDIR /app

# Copiar APENAS os módulos compilados do estágio de build
# COPY --from=test cria dependência implícita: produção só é alcançada se test passou
COPY --from=test /app/local ./local

# Copiar o código da aplicação (sem test/ e sem local/)
COPY lib ./lib
COPY script ./script
COPY migrations ./migrations
COPY api ./api
COPY eng ./eng
COPY cpanfile cpanfile.snapshot ./

EXPOSE 8080

# -f: foreground (não daemoniza — necessário para Docker/Kubernetes)
CMD ["carton", "exec", "hypnotoad", "-f", "script/stega"]
```

---

## compose.yml para desenvolvimento

```yaml
# compose.yml
services:

  # Aplicação web principal (Hypnotoad ou daemon)
  app:
    build:
      context: .
      target: build         # usa estágio de build (tem compiladores)
    volumes:
      - .:/app              # monta código local — alterações refletidas em tempo real
      - /app/local          # volume anônimo para local/ não ser sobrescrito
    environment:
      POSTGRESQL_APP_URL: postgresql://postgres-app:5432/stega-app
      POSTGRESQL_APP_USERNAME: stega_app
      POSTGRESQL_APP_PASSWORD: dev_password
      POSTGRESQL_APP_MIGRATION_USERNAME: stega_migrate
      POSTGRESQL_APP_MIGRATION_PASSWORD: dev_password
      POSTGRESQL_JOBS_URL: postgresql://postgres-jobs:5432/stega-jobs
      POSTGRESQL_JOBS_USERNAME: stega_jobs
      POSTGRESQL_JOBS_PASSWORD: dev_password
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: stega_events
      POSTGRESQL_EVENTS_PASSWORD: dev_password
      KEYCLOAK_URL: http://keycloak:8080
      KEYCLOAK_REALM: stega
      KEYCLOAK_CLIENT_ID: stega-api
      JWT_ISSUER: http://localhost:8080/realms/stega
      JWT_AUDIENCE: stega-api
    ports:
      - "3000:3000"
    command: carton exec perl script/stega daemon --listen http://*:3000
    depends_on:
      postgres-app:
        condition: service_healthy
      bootstrap-pgque:
        condition: service_completed_successfully

  # Worker Minion — o BACKEND do Minion usa instância própria (db-jobs),
  # nunca reaproveita db-app (ADR-023). Mas o processo inteiro ainda precisa
  # de db-app/db-events também: Stega.pm::startup configura as três
  # instâncias Mojo::Pg incondicionalmente, e os Jobs em si (ex.:
  # ProcessWebhookPayload) usam $app->pg (db-app) e $app->pg_events
  # (db-events) para fazer seu trabalho — só o backend de agendamento do
  # próprio Minion é que fica isolado em db-jobs.
  minion-worker:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      POSTGRESQL_APP_URL: postgresql://postgres-app:5432/stega-app
      POSTGRESQL_APP_USERNAME: stega_app
      POSTGRESQL_APP_PASSWORD: dev_password
      POSTGRESQL_JOBS_URL: postgresql://postgres-jobs:5432/stega-jobs
      POSTGRESQL_JOBS_USERNAME: stega_jobs
      POSTGRESQL_JOBS_PASSWORD: dev_password
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: stega_events
      POSTGRESQL_EVENTS_PASSWORD: dev_password
    command: carton exec perl script/stega minion worker
    depends_on:
      postgres-app:
        condition: service_healthy
      postgres-jobs:
        condition: service_healthy
      postgres-events:
        condition: service_healthy

  # Worker de notificações — consumidor PgQue (ADR-022)
  notification-worker:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: stega_events
      POSTGRESQL_EVENTS_PASSWORD: dev_password
    command: carton exec perl script/worker
    depends_on:
      bootstrap-pgque:
        condition: service_completed_successfully

  # Tick de rotação do PgQue — replicas: 1 obrigatório (ADR-022)
  pgque-ticker:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: stega_events
      POSTGRESQL_EVENTS_PASSWORD: dev_password
    command: carton exec perl script/pgque_ticker
    depends_on:
      bootstrap-pgque:
        condition: service_completed_successfully

  # Instala pgque.sql em db-events — passo idempotente, separado de migrations (ADR-023)
  bootstrap-pgque:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: stega_events
      POSTGRESQL_EVENTS_PASSWORD: dev_password
    command: carton exec perl eng/bootstrap_pgque.pl
    depends_on:
      postgres-events:
        condition: service_healthy
    restart: "no"

  postgres-app:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB:       stega-app
      POSTGRES_USER:     stega_migrate
      POSTGRES_PASSWORD: dev_password
    ports:
      - "55432:5432"
    volumes:
      - postgres_app_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stega_migrate -d stega-app"]
      interval: 5s
      retries: 5

  postgres-jobs:
    image: postgres:17-alpine    # mesma imagem, instância de propósito único (ADR-023)
    environment:
      POSTGRES_DB:       stega-jobs
      POSTGRES_USER:     stega_jobs
      POSTGRES_PASSWORD: dev_password
    ports:
      - "55433:5432"
    volumes:
      - postgres_jobs_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stega_jobs -d stega-jobs"]
      interval: 5s
      retries: 5

  postgres-events:
    image: postgres:17-alpine    # imagem intocada — sem pg_cron nem extensão custom
    environment:
      POSTGRES_DB:       stega-events
      POSTGRES_USER:     stega_events
      POSTGRES_PASSWORD: dev_password
    ports:
      - "55434:5432"
    volumes:
      - postgres_events_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stega_events -d stega-events"]
      interval: 5s
      retries: 5

  postgres-keycloak:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB:       keycloak
      POSTGRES_USER:     keycloak
      POSTGRES_PASSWORD: dev_password
    ports:
      - "55435:5432"
    volumes:
      - postgres_keycloak_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U keycloak -d keycloak"]
      interval: 5s
      retries: 5

  keycloak:
    image: quay.io/keycloak/keycloak:25.0
    command: start-dev
    depends_on:
      postgres-keycloak:
        condition: service_healthy
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres-keycloak:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: dev_password
      KEYCLOAK_ADMIN:          admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"

volumes:
  postgres_app_data:
  postgres_jobs_data:
  postgres_events_data:
  postgres_keycloak_data:
```

---

## Comandos Docker essenciais

```bash
# Subir todos os serviços
docker compose up

# Subir em background
docker compose up -d

# Subir apenas serviços de apoio (sem a aplicação)
docker compose up -d postgres-app postgres-jobs postgres-events postgres-keycloak keycloak

# Executar um comando dentro do container da aplicação
docker compose exec app carton exec perl eng/migrate.pl
docker compose exec app carton exec prove -lr t/

# Ver logs de um serviço
docker compose logs -f app

# Reconstruir imagem após mudança no Dockerfile ou cpanfile
docker compose build

# Parar todos os serviços (preserva volumes)
docker compose down

# Parar e remover volumes (reseta bancos de dados)
docker compose down -v

# Ver status dos serviços
docker compose ps
```

---

## Build e push para produção

```bash
# Build da imagem de produção
docker build --target production -t stega:latest .

# Com tag de versão
docker build --target production -t stega:2026.06.0 .

# Push para registry
docker push registry.exemplo.com/stega:2026.06.0
```

---

## .dockerignore

```
# .dockerignore

# Módulos instalados pelo Carton (reconstruídos no build)
local/

# Artefatos de desenvolvimento
cover_db/
.env
.env.*

# Controle de versão
.git/

# Sistema operacional
.DS_Store
Thumbs.db
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `local/` no `.dockerignore` ausente | Módulos locais compilados para o SO do host são copiados para o container Linux — causam falhas | Sempre incluir `local/` no `.dockerignore` |
| `COPY . .` antes das deps | Invalida cache de layer do `carton install` a cada mudança de código | Copiar `cpanfile` e `cpanfile.snapshot` antes de `COPY . .` |
| `target: build` em produção | A imagem de build tem compiladores C e é maior | Usar `target: production` em produção; `build` apenas em desenvolvimento |
| Volume `/app/local` ausente em dev | O volume anônimo garante que `local/` do container não seja sobrescrita pelo volume `.:/app` | Declarar `- /app/local` explicitamente no `volumes` do serviço |
| `start-dev` do Keycloak em produção | Modo de desenvolvimento sem TLS e sem configuração de clustering | Keycloak em produção requer configuração dedicada com HTTPS |
