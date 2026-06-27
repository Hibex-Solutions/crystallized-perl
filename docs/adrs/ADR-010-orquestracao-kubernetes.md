# ADR-010: Orquestração de Contêineres — Kubernetes

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

A aplicação roda em containers Docker. Em produção, containers isolados precisam de
orquestração para: escalabilidade horizontal automática, reinicialização de containers falhos,
implantações sem interrupção, gerenciamento de segredos e injeção de configuração. O fator
VIII do 12-factor (concorrência) exige que a aplicação seja escalável via processos
adicionais, não via crescimento vertical de um único processo.

## Decisão

**Kubernetes** como plataforma de orquestração de containers em produção. Docker Compose
permanece como ambiente de desenvolvimento local (ADR-014).

## Justificativa

O Kubernetes é a plataforma de orquestração de containers de facto para cargas de
trabalho cloud-native. Para o stack, quatro recursos são diretamente relevantes:

1. **Health Probes**: Liveness e Readiness Probes integram com a rota `/healthz` do
   Mojolicious, permitindo que o Kubernetes detecte Pods não-saudáveis e os reinicie
   automaticamente, além de remover Pods em inicialização do balanceamento de carga
   antes de estarem prontos.

2. **ConfigMaps e Secrets**: Injeção de configuração via variáveis de ambiente no Pod,
   sem hardcoding de credenciais na imagem — fator III do 12-factor.

3. **Deployments separados por processo**: API (Hypnotoad) e Workers (Net::AMQP)
   têm Deployments independentes, escalonáveis separadamente conforme a carga.

4. **Horizontal Pod Autoscaler**: A API pode ter o número de réplicas ajustado
   automaticamente baseado em CPU/memória — o modelo pre-fork do Hypnotoad é
   compatível com isso.

5. **InitContainers**: permitem executar tarefas de preparação antes dos containers
   principais do Pod. O caso de uso central no stack é executar migrations de banco
   de dados com credenciais DDL antes da aplicação subir — garantindo que o schema
   esteja correto e usando um usuário privilegiado separado das credenciais DML da
   aplicação (ver ADR-016).

Referências: [Kubernetes](../references/kubernetes.md),
[Docker](../references/docker.md),
[The Twelve-Factor App](../references/twelve-factor-app.md),
[Mojolicious](../references/mojolicious.md)

### Rota de health check (Mojolicious)

```perl
# lib/MyApp/Controller/Health.pm
package MyApp::Controller::Health;
use Mojo::Base 'Mojolicious::Controller';

sub check {
    my $self = shift;

    # Verificar conectividade com o PostgreSQL
    my $db_ok = eval { $self->pg->db->query('SELECT 1'); 1 } // 0;

    if ($db_ok) {
        $self->render(json => { status => 'ok' });
    }
    else {
        $self->render(json => { status => 'degraded', db => 'unreachable' }, status => 503);
    }
}

1;
```

### InitContainer de migrations

O InitContainer executa antes dos containers principais. Se falhar, o Pod não
avança — a aplicação nunca sobe com schema desatualizado. Usa `POSTGRESQL_MIGRATION_URL`
(credencial DDL) separada da `POSTGRESQL_URL` (credencial DML) usada pela aplicação:

```yaml
# trecho do api-deployment.yaml
spec:
  template:
    spec:
      initContainers:
        - name: migrate
          image: registry.example.com/myapp:latest
          command: ["carton", "exec", "perl", "eng/migrate.pl"]
          env:
            - name: POSTGRESQL_MIGRATION_URL
              valueFrom:
                secretKeyRef:
                  name: myapp-secrets
                  key: POSTGRESQL_MIGRATION_URL
```

### Deployment da API

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-api
  labels:
    app: myapp
    component: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      component: api
  template:
    metadata:
      labels:
        app: myapp
        component: api
    spec:
      initContainers:
        - name: migrate
          image: registry.example.com/myapp:latest
          command: ["carton", "exec", "perl", "eng/migrate.pl"]
          env:
            - name: POSTGRESQL_MIGRATION_URL
              valueFrom:
                secretKeyRef:
                  name: myapp-secrets
                  key: POSTGRESQL_MIGRATION_URL

      containers:
        - name: api
          image: registry.example.com/myapp:latest
          command: ["carton", "exec", "hypnotoad", "-f", "script/my_app.pl"]
          ports:
            - containerPort: 8080

          # Injeção de configuração via Secret e ConfigMap
          envFrom:
            - secretRef:
                name: myapp-secrets        # POSTGRESQL_URL, RABBITMQ_HOST, etc.
            - configMapRef:
                name: myapp-config         # KEYCLOAK_URL, KEYCLOAK_REALM, etc.

          # Probe de readiness: o Pod só entra no balanceamento quando responder 200
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

          # Probe de liveness: reinicia o Pod se não responder por 30s
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3

          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
```

### Deployment dos Workers

```yaml
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-worker
  labels:
    app: myapp
    component: worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapp
      component: worker
  template:
    metadata:
      labels:
        app: myapp
        component: worker
    spec:
      containers:
        - name: worker
          image: registry.example.com/myapp:latest   # mesma imagem da API
          command: ["carton", "exec", "perl", "script/worker.pl"]
          envFrom:
            - secretRef:
                name: myapp-secrets
            - configMapRef:
                name: myapp-config
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "200m"
```

### Secret e ConfigMap

```yaml
# k8s/secrets.yaml (valores em base64 — usar Sealed Secrets ou External Secrets em produção)
apiVersion: v1
kind: Secret
metadata:
  name: myapp-secrets
type: Opaque
stringData:
  POSTGRESQL_URL:             "postgresql://myapp_app:senha_app@postgres-svc:5432/myapp"
  POSTGRESQL_MIGRATION_URL:   "postgresql://myapp_migrate:senha_migrate@postgres-svc:5432/myapp"
  RABBITMQ_HOST:         "rabbitmq-svc"
  RABBITMQ_USER:         "myapp"
  RABBITMQ_PASSWORD:     "password"
  KEYCLOAK_CLIENT_SECRET: "secret"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-config
data:
  KEYCLOAK_URL:    "https://auth.example.com"
  KEYCLOAK_REALM:  "myapp"
  KEYCLOAK_CLIENT_ID: "myapp-api"
  JWT_ISSUER:      "https://auth.example.com/realms/myapp"
  JWT_AUDIENCE:    "myapp-api"
```

### Service e Ingress

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-api-svc
spec:
  selector:
    app: myapp
    component: api
  ports:
    - port: 80
      targetPort: 8080
```

### Horizontal Pod Autoscaler

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp-api
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Docker Compose sozinho** | Adequado apenas para desenvolvimento local; sem auto-recovery de containers falhos, sem escalabilidade horizontal, sem gestão de secrets adequada para produção |
| **Nomad (HashiCorp)** | Orquestrador mais simples, mas ecossistema menor, menos tooling de observabilidade e menor adoção que o Kubernetes |
| **AWS ECS / Google Cloud Run** | Vendor lock-in em plataforma de nuvem específica; Kubernetes é portável entre provedores e self-hosted |
| **Docker Swarm** | Modo de cluster do Docker, mas descontinuado como prioridade pela Docker Inc.; menor ecossistema que Kubernetes |

## Consequências

**Positivo**:
- Health Probes eliminam tráfego para Pods não-saudáveis automaticamente
- Deployments separados para API e Workers permitem escalonamento independente
- ConfigMaps/Secrets separam código de configuração (12-factor fator III)
- HPA escala réplicas da API automaticamente baseado em carga
- InitContainer garante que migrations precedem a aplicação — schema correto antes
  do primeiro request, sem dependência de lógica no startup da aplicação

**Negativo**:
- Curva de aprendizado de Kubernetes (manifests YAML, conceitos de Pod/Deployment/Service)
- Secrets no Kubernetes são base64, não criptografados por padrão — requer Sealed
  Secrets ou External Secrets Operator para gestão segura em produção

**Ações necessárias**:
- Implementar rota `/healthz` com verificação de conectividade ao PostgreSQL
- Criar manifests YAML para Deployment (API + Worker), Service, ConfigMap e Secret
- Configurar InitContainer de migration no Deployment da API (ver ADR-016)
- Configurar registro de imagens Docker (registry) para as imagens de produção
- Avaliar e configurar Sealed Secrets ou External Secrets para gestão de credenciais
- Provisionar dois usuários PostgreSQL: `myapp_migrate` (DDL) e `myapp_app` (DML)
