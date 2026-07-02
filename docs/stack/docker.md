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
- **Paridade dev/prod**: mesmas versões do Perl, PostgreSQL, RabbitMQ e Keycloak em todos os ambientes
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
      POSTGRESQL_URL: postgresql://stega_app:dev_password@postgres:5432/stega
      POSTGRESQL_MIGRATION_URL: postgresql://stega_migrate:dev_password@postgres:5432/stega
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_USER: stega
      RABBITMQ_PASSWORD: dev_password
      KEYCLOAK_URL: http://keycloak:8080
      KEYCLOAK_REALM: stega
      KEYCLOAK_CLIENT_ID: stega-api
      JWT_ISSUER: http://localhost:8080/realms/stega
      JWT_AUDIENCE: stega-api
    ports:
      - "3000:3000"
    command: carton exec perl script/stega daemon --listen http://*:3000
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy

  # Worker Minion
  minion-worker:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      POSTGRESQL_URL: postgresql://stega_app:dev_password@postgres:5432/stega
    command: carton exec perl script/stega minion worker
    depends_on:
      postgres:
        condition: service_healthy

  # Worker de notificações RabbitMQ
  notification-worker:
    build:
      context: .
      target: build
    volumes:
      - .:/app
      - /app/local
    environment:
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_USER: stega
      RABBITMQ_PASSWORD: dev_password
    command: carton exec perl eng/worker.pl
    depends_on:
      rabbitmq:
        condition: service_healthy

  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB:       stega
      POSTGRES_USER:     stega_migrate
      POSTGRES_PASSWORD: dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stega_migrate -d stega"]
      interval: 5s
      retries: 5

  rabbitmq:
    image: rabbitmq:4.3-management
    environment:
      RABBITMQ_DEFAULT_USER: stega
      RABBITMQ_DEFAULT_PASS: dev_password
    ports:
      - "5672:5672"
      - "15672:15672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "ping"]
      interval: 10s
      retries: 5

  keycloak:
    image: quay.io/keycloak/keycloak:25.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN:          admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"

volumes:
  postgres_data:
```

---

## Comandos Docker essenciais

```bash
# Subir todos os serviços
docker compose up

# Subir em background
docker compose up -d

# Subir apenas serviços de apoio (sem a aplicação)
docker compose up -d postgres rabbitmq keycloak

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
