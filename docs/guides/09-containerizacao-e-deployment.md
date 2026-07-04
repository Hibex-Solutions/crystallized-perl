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
- `compose.yml` com um perfil completo (`full`) rodando os três processos da Stega
  inteiramente em containers, sem Perl local
- Manifests de Kubernetes: InitContainer de migrations, Deployment da API e dos
  workers, Health Probes, Secret/ConfigMap

---

## Pré-requisitos

- [Guia 8](/guides/rabbitmq-e-minion) concluído
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
    librabbitmq-dev \
    libssl-dev \
    gcc \
    make \
    && rm -rf /var/lib/apt/lists/*

RUN cpanm --notest Carton

COPY cpanfile cpanfile.snapshot ./
RUN carton install

# Estágio 2: imagem para execução dos testes (inclui t/ e ferramentas de build)
FROM deps AS test

COPY lib templates public api migrations eng script t cpanfile ./

ENV PERL5LIB=/app/local/lib/perl5
ENV PATH=/app/local/bin:$PATH

# Estágio 3: imagem de produção mínima — sem t/, sem gcc/make
FROM perl:5.42-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    librabbitmq4 \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/local ./local
COPY lib templates public api migrations eng script cpanfile ./

ENV PERL5LIB=/app/local/lib/perl5
ENV PATH=/app/local/bin:$PATH

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:3000/healthz || exit 1

CMD ["hypnotoad", "-f", "script/stega"]
```

Note que a imagem final não instala `gcc`/`make`/`libpq-dev` — só as bibliotecas de
runtime (`libpq5`, não `libpq-dev`) — porque os módulos XS já foram compilados no
estágio `deps` e só o resultado (`local/`) é copiado adiante. `librabbitmq4` (runtime)
está presente mesmo que `Net::AMQP::RabbitMQ` só seja usado pelos processos de
worker — a mesma imagem serve os três processos (Guia 8), então precisa ter tudo que
qualquer um deles usa.

O `HEALTHCHECK` do Dockerfile usa a mesma rota `/healthz` que o Kubernetes vai
consultar depois — dois níveis de verificação com a mesma fonte da verdade.

Build local:

```bash
docker build --target production -t stega:latest .
docker build --target test -t stega:test .   # imagem intermediária, com t/
```

---

## Passo 2 — Docker Compose completo (perfil `full`)

Um perfil `full` sobe os três processos da Stega inteiramente containerizados —
útil para quem quer validar sem Perl instalado localmente (ver Guia 1, Caminho C):

```yaml
services:
  migrate:
    profiles: [full]
    build: .
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      POSTGRESQL_MIGRATION_URL: postgresql://postgres:postgres_dev@postgres:5432/stega
    command: perl eng/migrate.pl
    restart: "no"

  app:
    profiles: [full]
    build: .
    depends_on:
      seed: { condition: service_completed_successfully }
    environment:
      POSTGRESQL_URL: postgresql://postgres:postgres_dev@postgres:5432/stega
      RABBITMQ_HOST: rabbitmq
    ports: ["3000:3000"]
    command: perl script/stega daemon

  minion-worker:
    profiles: [full]
    build: .
    depends_on:
      seed: { condition: service_completed_successfully }
    command: perl script/stega minion worker

  notification-worker:
    profiles: [full]
    build: .
    depends_on:
      rabbitmq: { condition: service_healthy }
    command: perl eng/worker.pl
```

`migrate` roda uma vez e sai (`restart: "no"`) — é o equivalente, em Docker Compose,
ao InitContainer do Kubernetes (Passo 3): um processo curto que precisa terminar
com sucesso *antes* de `app` subir, usando `depends_on: condition:
service_completed_successfully`.

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
            - name: POSTGRESQL_MIGRATION_URL
              valueFrom:
                secretKeyRef: { name: stega-secrets, key: POSTGRESQL_MIGRATION_URL }

      containers:
        - name: api
          image: registry.example.com/stega:latest
          command: ["carton", "exec", "hypnotoad", "-f", "script/stega"]
          ports:
            - containerPort: 3000

          envFrom:
            - secretRef: { name: stega-secrets }      # POSTGRESQL_URL, RABBITMQ_*, KEYCLOAK_CLIENT_SECRET
            - configMapRef: { name: stega-config }     # KEYCLOAK_URL, KEYCLOAK_REALM, etc.

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

`POSTGRESQL_MIGRATION_URL` (privilégio DDL) só existe no InitContainer — o container
principal `api` recebe apenas `POSTGRESQL_URL` (DML) via `stega-secrets`. Um bug na
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
          command: ["carton", "exec", "perl", "eng/worker.pl"]
          envFrom:
            - secretRef: { name: stega-secrets }
            - configMapRef: { name: stega-config }
```

Nenhum dos dois Deployments de worker tem `readinessProbe`/`livenessProbe` HTTP —
eles não servem HTTP. O Kubernetes já reinicia o Pod se o processo morrer (todo
container reinicia por padrão, `restartPolicy: Always`), o que cobre a maior parte
do que um health check faria aqui.

---

## Passo 5 — Secret, ConfigMap e Service

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stega-secrets
type: Opaque
stringData:
  POSTGRESQL_URL:           "postgresql://stega_app:senha_app@postgres-svc:5432/stega"
  POSTGRESQL_MIGRATION_URL: "postgresql://stega_migrate:senha_migrate@postgres-svc:5432/stega"
  RABBITMQ_HOST:            "rabbitmq-svc"
  RABBITMQ_PASSWORD:        "senha"
  KEYCLOAK_CLIENT_SECRET:   "secret"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: stega-config
data:
  KEYCLOAK_URL:   "https://auth.example.com"
  KEYCLOAK_REALM: "stega"
  RABBITMQ_USER:  "stega"

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
| Pod fica em `Init:CrashLoopBackOff` | InitContainer de migration falhando | `kubectl logs <pod> -c migrate` — geralmente credencial DDL errada ou Postgres inacessível |
| `readinessProbe` nunca fica `Ready` | `/healthz` checando o banco e o banco está inacessível do Pod | Confirme `POSTGRESQL_URL` e conectividade de rede (NetworkPolicy, Service correto) |
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
