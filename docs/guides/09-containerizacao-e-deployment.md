---
sidebar_position: 9
title: "Guia 9 — Containerização e Deployment"
---

# Guia 9 — Containerização com Docker e Deployment em Kubernetes

> **Referências arquiteturais**:
> [ADR-005 — Carton + cpanm](/adrs/ADR-005-gerenciamento-de-dependencias) ·
> [ADR-010 — Orquestração Kubernetes](/adrs/ADR-010-orquestracao-kubernetes)

---

## O que você vai construir

Ao final deste guia você terá:

- Um `Dockerfile` multi-stage (`deps → test → production`) — os testes bloqueiam a
  geração da imagem final se falharem
- `compose.yml` com um perfil completo (`full`) rodando os quatro processos da
  Stega e as quatro instâncias PostgreSQL inteiramente em containers, sem Perl
  local
- Manifests de Kubernetes: InitContainers de migrations e bootstrap do PgQue,
  Deployment da API e dos workers (incluindo o ticker do PgQue), Health Probes,
  Secret/ConfigMap

---

## Pré-requisitos

- [Guia 8](/guides/filas-com-pgque-e-minion) concluído
- Docker Desktop (ou engine equivalente) com suporte a BuildKit
- Um cluster Kubernetes para a parte final (`kind`/`minikube` servem para testar
  localmente; nenhum comando deste guia precisa de um cluster real até lá)

---

## Passo 1 — Dockerfile multi-stage

Três estágios: dependências, teste, produção. O estágio de teste roda a suíte
completa — se falhar, o `docker build` para aí, e a imagem de produção nunca é
gerada:

```dockerfile
# Estágio 1: instala as dependências Perl com Carton
FROM perl:5.42-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    libssl-dev \
    gcc \
    make \
    && rm -rf /var/lib/apt/lists/*

RUN cpanm --notest Carton

COPY cpanfile cpanfile.snapshot ./
RUN carton install

# Estágio 2: imagem para execução dos testes (inclui t/ e ferramentas de build)
FROM deps AS test

COPY lib templates public api migrations eng script t cpanfile vendor ./

ENV PERL5LIB=/app/local/lib/perl5
ENV PATH=/app/local/bin:$PATH

# Estágio 3: imagem de produção mínima — sem t/, sem gcc/make
FROM perl:5.42-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/local ./local
COPY lib templates public api migrations eng script cpanfile vendor ./

ENV PERL5LIB=/app/local/lib/perl5
ENV PATH=/app/local/bin:$PATH

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:3000/healthz || exit 1

CMD ["hypnotoad", "-f", "script/stega"]
```

Note que a imagem final não instala `gcc`/`make`/`libpq-dev` — só a biblioteca de
runtime (`libpq5`, não `libpq-dev`) — porque os módulos XS já foram compilados no
estágio `deps` e só o resultado (`local/`) é copiado adiante. Nenhum módulo de
fila exige compilador C (PgQue é SQL puro, consumido via `Mojo::Pg`, ADR-022) —
a mesma imagem serve os quatro processos (Guia 8), incluindo `vendor/pgque/pgque.sql`,
usado pelo InitContainer/serviço de bootstrap do PgQue (Passo 3).

O `HEALTHCHECK` do Dockerfile usa a mesma rota `/healthz` que o Kubernetes vai
consultar depois — dois níveis de verificação com a mesma fonte da verdade.

Build local:

```bash
docker build --target production -t stega:latest .
docker build --target test -t stega:test .   # imagem intermediária, com t/
```

---

## Passo 2 — Docker Compose completo (perfil `full`)

Um perfil `full` sobe os quatro processos da Stega inteiramente containerizados —
útil para quem quer validar sem Perl instalado localmente (ver Guia 1, Caminho C):

```yaml
services:
  migrate:
    profiles: [full]
    build: .
    depends_on:
      postgres-app: { condition: service_healthy }
    environment:
      POSTGRESQL_APP_URL: postgresql://postgres-app:5432/stega-app
      POSTGRESQL_APP_MIGRATION_USERNAME: postgres
      POSTGRESQL_APP_MIGRATION_PASSWORD: postgres_dev
    command: perl eng/migrate.pl
    restart: "no"

  bootstrap-pgque:
    profiles: [full]
    build: .
    depends_on:
      postgres-events: { condition: service_healthy }
    environment:
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: postgres
      POSTGRESQL_EVENTS_PASSWORD: postgres_dev
    command: perl eng/bootstrap_pgque.pl
    restart: "no"

  app:
    profiles: [full]
    build: .
    depends_on:
      seed: { condition: service_completed_successfully }
    environment:
      POSTGRESQL_APP_URL: postgresql://postgres-app:5432/stega-app
      POSTGRESQL_APP_USERNAME: postgres
      POSTGRESQL_APP_PASSWORD: postgres_dev
      POSTGRESQL_JOBS_URL: postgresql://postgres-jobs:5432/stega-jobs
      POSTGRESQL_JOBS_USERNAME: postgres
      POSTGRESQL_JOBS_PASSWORD: postgres_dev
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: postgres
      POSTGRESQL_EVENTS_PASSWORD: postgres_dev
    ports: ["3000:3000"]
    command: perl script/stega daemon

  minion-worker:
    profiles: [full]
    build: .
    depends_on:
      seed: { condition: service_completed_successfully }
      bootstrap-pgque: { condition: service_completed_successfully }
    environment:
      # Stega.pm::startup configura as três instâncias Mojo::Pg
      # incondicionalmente (ADR-023), qualquer que seja o subcomando — os
      # Jobs Minion usam $app->pg (db-app: ex.: criar um ticket a partir de
      # um webhook) e $app->pg_events (db-events: publicar notificações),
      # não só o backend do próprio Minion (db-jobs). Faltar qualquer uma
      # das três faz Jobs específicos falharem em runtime, não no boot do
      # worker — mais fácil de esquecer do que parece, achado real ao
      # validar o roteiro de webhooks do TESTING.md.
      POSTGRESQL_APP_URL: postgresql://postgres-app:5432/stega-app
      POSTGRESQL_APP_USERNAME: postgres
      POSTGRESQL_APP_PASSWORD: postgres_dev
      POSTGRESQL_JOBS_URL: postgresql://postgres-jobs:5432/stega-jobs
      POSTGRESQL_JOBS_USERNAME: postgres
      POSTGRESQL_JOBS_PASSWORD: postgres_dev
      POSTGRESQL_EVENTS_URL: postgresql://postgres-events:5432/stega-events
      POSTGRESQL_EVENTS_USERNAME: postgres
      POSTGRESQL_EVENTS_PASSWORD: postgres_dev
    command: perl script/stega minion worker
    healthcheck: { disable: true }   # não serve HTTP — ver nota abaixo

  pgque-ticker:
    profiles: [full]
    build: .
    depends_on:
      bootstrap-pgque: { condition: service_completed_successfully }
    deploy:
      replicas: 1    # obrigatório — PgQue não coordena ticker() concorrente
    command: perl script/pgque_ticker
    healthcheck: { disable: true }   # não serve HTTP — ver nota abaixo

  notification-worker:
    profiles: [full]
    build: .
    depends_on:
      bootstrap-pgque: { condition: service_completed_successfully }
    command: perl script/worker
    healthcheck: { disable: true }   # não serve HTTP — ver nota abaixo
```

As três imagens de worker herdam o `HEALTHCHECK` do Dockerfile (Passo 1) —
`curl` a `/healthz` na porta 3000 — mas nenhuma delas serve HTTP, então nunca
ficariam `healthy` por definição, só `unhealthy` indefinidamente. Desabilitado
por serviço no `compose.yml` (`healthcheck: { disable: true }`), não no
Dockerfile — o `app` continua precisando do healthcheck real.

`migrate` e `bootstrap-pgque` rodam uma vez e saem (`restart: "no"`) — são o
equivalente, em Docker Compose, aos InitContainers do Kubernetes (Passo 3):
processos curtos que precisam terminar com sucesso *antes* de `app`/
`notification-worker` subirem, usando
`depends_on: condition: service_completed_successfully`. São dois passos
distintos, com nomes próprios — "aplicar migrations do domínio" (`db-app`) não é
"instalar o PgQue" (`db-events`), mesmo sendo ambos idempotentes (ADR-023).

```bash
docker compose --profile full up --build
```

O estágio de testes também roda em container, isolado do `production`:

```bash
docker compose --profile full --profile test run --rm test
```

---

## Passo 3 — Kubernetes: InitContainer de migrations

Em produção, o equivalente ao serviço `migrate` do Compose é um **InitContainer** —
executa antes dos containers principais do Pod; se falhar, o Pod não avança:

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: stega, component: api }
  template:
    metadata:
      labels: { app: stega, component: api }
    spec:
      initContainers:
        - name: migrate
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "perl", "eng/migrate.pl"]
          env:
            - name: POSTGRESQL_APP_URL
              valueFrom:
                configMapKeyRef: { name: stega-config, key: POSTGRESQL_APP_URL }
            - name: POSTGRESQL_APP_MIGRATION_USERNAME
              valueFrom:
                secretKeyRef: { name: stega-secrets, key: POSTGRESQL_APP_MIGRATION_USERNAME }
            - name: POSTGRESQL_APP_MIGRATION_PASSWORD
              valueFrom:
                secretKeyRef: { name: stega-secrets, key: POSTGRESQL_APP_MIGRATION_PASSWORD }

        - name: bootstrap-pgque
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "perl", "eng/bootstrap_pgque.pl"]
          env:
            - name: POSTGRESQL_EVENTS_URL
              valueFrom:
                configMapKeyRef: { name: stega-config, key: POSTGRESQL_EVENTS_URL }
            - name: POSTGRESQL_EVENTS_USERNAME
              valueFrom:
                secretKeyRef: { name: stega-secrets, key: POSTGRESQL_EVENTS_USERNAME }
            - name: POSTGRESQL_EVENTS_PASSWORD
              valueFrom:
                secretKeyRef: { name: stega-secrets, key: POSTGRESQL_EVENTS_PASSWORD }

      containers:
        - name: api
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "hypnotoad", "-f", "script/stega"]
          ports:
            - containerPort: 3000

          envFrom:
            - secretRef: { name: stega-secrets }      # POSTGRESQL_APP/JOBS/EVENTS_USERNAME/_PASSWORD, KEYCLOAK_CLIENT_SECRET
            - configMapRef: { name: stega-config }     # POSTGRESQL_APP/JOBS/EVENTS_URL, KEYCLOAK_URL, KEYCLOAK_REALM, etc.

          readinessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

          livenessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3

          resources:
            requests: { memory: "128Mi", cpu: "100m" }
            limits:   { memory: "256Mi", cpu: "500m" }
```

`POSTGRESQL_APP_MIGRATION_USERNAME`/`_PASSWORD` (privilégio DDL) só existe no
InitContainer — o container principal `api` recebe apenas `POSTGRESQL_APP_USERNAME`/
`_PASSWORD` (DML) via `stega-secrets`. Um bug na
aplicação não consegue alterar o schema, porque a credencial que ela usa não tem
esse privilégio (Guia 5).

---

## Passo 4 — Deployments dos workers

Mesma imagem, comandos diferentes — cada worker do Guia 8 vira um `Deployment`
independente, escalável separadamente da API:

```yaml
# k8s/minion-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-minion-worker
spec:
  replicas: 2
  selector:
    matchLabels: { app: stega, component: minion-worker }
  template:
    metadata:
      labels: { app: stega, component: minion-worker }
    spec:
      containers:
        - name: minion-worker
          image: registry.example.com/stega:latest   # mesma imagem da API
          command: ["carton", "exec", "perl", "script/stega", "minion", "worker"]
          envFrom:
            - secretRef: { name: stega-secrets }
            - configMapRef: { name: stega-config }
          resources:
            requests: { memory: "64Mi", cpu: "50m" }
            limits:   { memory: "128Mi", cpu: "200m" }
```

```yaml
# k8s/notification-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-notification-worker
spec:
  replicas: 1    # um consumidor por fila é suficiente na escala da Stega
  selector:
    matchLabels: { app: stega, component: notification-worker }
  template:
    metadata:
      labels: { app: stega, component: notification-worker }
    spec:
      containers:
        - name: notification-worker
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "perl", "script/worker"]
          envFrom:
            - secretRef: { name: stega-secrets }
            - configMapRef: { name: stega-config }
```

```yaml
# k8s/pgque-ticker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-pgque-ticker
spec:
  replicas: 1    # OBRIGATÓRIO — PgQue não coordena ticker() concorrente fora do pg_cron
  selector:
    matchLabels: { app: stega, component: pgque-ticker }
  template:
    metadata:
      labels: { app: stega, component: pgque-ticker }
    spec:
      containers:
        - name: pgque-ticker
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "perl", "script/pgque_ticker"]
          envFrom:
            - secretRef: { name: stega-secrets }
            - configMapRef: { name: stega-config }
```

Nenhum dos três Deployments de worker/ticker tem `readinessProbe`/`livenessProbe`
HTTP — eles não servem HTTP. O Kubernetes já reinicia o Pod se o processo morrer
(todo container reinicia por padrão, `restartPolicy: Always`), o que cobre a maior
parte do que um health check faria aqui. O `stega-pgque-ticker` é o único
Deployment desta trilha com `replicas` travado em 1 por exigência do PgQue, não
por escolha de capacidade — nunca escale este Deployment horizontalmente.

---

## Passo 5 — Secret, ConfigMap e Service

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stega-secrets
type: Opaque
stringData:
  POSTGRESQL_APP_USERNAME:           "stega_app"
  POSTGRESQL_APP_PASSWORD:           "senha_app"
  POSTGRESQL_APP_MIGRATION_USERNAME: "stega_migrate"
  POSTGRESQL_APP_MIGRATION_PASSWORD: "senha_migrate"
  POSTGRESQL_JOBS_USERNAME:          "stega_jobs"
  POSTGRESQL_JOBS_PASSWORD:          "senha_jobs"
  POSTGRESQL_EVENTS_USERNAME:        "stega_events"
  POSTGRESQL_EVENTS_PASSWORD:        "senha_events"
  KEYCLOAK_CLIENT_SECRET:            "secret"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: stega-config
data:
  # Servidor/porta/banco — nunca credencial (Revisão 2026-07-04 da ADR-016).
  # Três instâncias PostgreSQL distintas (ADR-023) — cada uma seu próprio Service.
  POSTGRESQL_APP_URL:    "postgresql://postgres-app-svc:5432/stega-app"
  POSTGRESQL_JOBS_URL:   "postgresql://postgres-jobs-svc:5432/stega-jobs"
  POSTGRESQL_EVENTS_URL: "postgresql://postgres-events-svc:5432/stega-events"
  KEYCLOAK_URL:   "https://auth.example.com"
  KEYCLOAK_REALM: "stega"

---
apiVersion: v1
kind: Service
metadata:
  name: stega-api-svc
spec:
  selector: { app: stega, component: api }
  ports:
    - port: 80
      targetPort: 3000
```

Segredos (senhas, client secret) em `Secret`; configuração não-sensível em
`ConfigMap` — a distinção não é técnica (o Kubernetes trata os dois de forma
parecida, `Secret` só em base64, não criptografado por padrão) mas organizacional:
facilita saber o que precisa de rotação/Sealed Secrets em produção.

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| Build falha no estágio `test` | Um teste real está quebrando | Rode `carton exec prove -lr t/` localmente antes de buildar |
| Pod fica em `Init:CrashLoopBackOff` | InitContainer de migration ou bootstrap-pgque falhando | `kubectl logs <pod> -c migrate` ou `-c bootstrap-pgque` — geralmente credencial errada ou a instância PostgreSQL correspondente (`db-app`/`db-events`) inacessível |
| Notificações nunca chegam mesmo com `notification-worker` rodando | `stega-pgque-ticker` não está rodando, ou tem mais de uma réplica | Confirme `kubectl get deploy stega-pgque-ticker` com `replicas: 1` e Pod `Running` — sem tick, `pgque.receive()` nunca retorna nada (Guia 8) |
| `readinessProbe` nunca fica `Ready` | `/healthz` checando o banco e o banco está inacessível do Pod | Confirme `POSTGRESQL_APP_URL`/`POSTGRESQL_APP_USERNAME`/`_PASSWORD` e conectividade de rede (NetworkPolicy, Service correto) |
| Imagem de produção maior que o esperado | Camadas do estágio `deps` (gcc, headers `-dev`) vazando para produção | Confirme que `production` parte de `perl:5.42-slim` limpo, não de `deps` |

---

## Fechando a trilha de guias

Com este guia, a trilha cobre o ciclo completo: ambiente local (Guia 1), estrutura
do projeto (Guia 2), primeira rota (Guia 3), regras de negócio testáveis (Guia 4),
banco de dados (Guia 5), autenticação (Guia 6), contrato de API (Guia 7),
processamento assíncrono (Guia 8) e deployment (este guia) — a mesma Stega, do
zero até rodando em produção.

Explore os ADRs completos para o raciocínio por trás de cada decisão — a lista
completa está em `docs/adrs/`, começando pela [ADR-000](/adrs/ADR-000-padrao-de-adrs)
para entender o próprio formato de ADR usado neste projeto.
