---
sidebar_position: 11
title: Kubernetes
---

# Kubernetes

> **Decisão**: Kubernetes como orquestrador de produção; três Deployments para a
> Stega; InitContainer para migrations; Hypnotoad com SIGUSR2 para atualizações
> sem interrupção.
> [ADR-010 — Orquestração Kubernetes](/adrs/ADR-010-orquestracao-kubernetes)

---

## Por que Kubernetes

A Stega em produção consiste em três processos distintos que precisam de
escalabilidade independente, reinicialização automática em caso de falha e
atualizações sem interrupção. Kubernetes resolve isso declarativamente: os
Deployments mantêm o estado desejado sem intervenção manual.

O Hypnotoad (servidor de produção do Mojolicious) usa pre-forking e suporta
reinicialização via `SIGUSR2` — compatível com a atualização progressiva sem
interrupção do Kubernetes, que termina Pods antigos somente após os novos estarem prontos.

---

## Três Deployments da Stega

```
stega-api                  ← Hypnotoad (pre-fork) — web + API
  └─ InitContainer: carton exec perl eng/migrate.pl

stega-minion-worker        ← Minion worker (jobs internos)
  └─ carton exec perl script/stega minion worker

stega-notification-worker  ← RabbitMQ consumer (notificações)
  └─ carton exec perl eng/worker.pl
```

---

## Manifest: stega-api Deployment

```yaml
# k8s/deployment-api.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-api
  labels:
    app: stega
    component: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: stega
      component: api
  template:
    metadata:
      labels:
        app: stega
        component: api
    spec:
      initContainers:
        - name: migrate
          image: registry.exemplo.com/stega:2026.06.0
          command: ["carton", "exec", "perl", "eng/migrate.pl"]
          env:
            - name: POSTGRESQL_MIGRATION_URL
              valueFrom:
                secretKeyRef:
                  name: stega-secrets
                  key: postgresql-migration-url

      containers:
        - name: api
          image: registry.exemplo.com/stega:2026.06.0
          ports:
            - containerPort: 8080

          env:
            - name: POSTGRESQL_URL
              valueFrom:
                secretKeyRef:
                  name: stega-secrets
                  key: postgresql-url
            - name: RABBITMQ_HOST
              valueFrom:
                configMapKeyRef:
                  name: stega-config
                  key: rabbitmq-host
            - name: KEYCLOAK_URL
              valueFrom:
                configMapKeyRef:
                  name: stega-config
                  key: keycloak-url
            - name: JWT_ISSUER
              valueFrom:
                configMapKeyRef:
                  name: stega-config
                  key: jwt-issuer

          # Liveness: Kubernetes reinicia o container se /healthz não responder
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3

          # Readiness: Kubernetes só direciona tráfego quando o container está pronto
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5

          # Limites de recursos — ajustar conforme carga real
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

---

## Manifest: Service e Ingress

```yaml
# k8s/service-api.yaml
apiVersion: v1
kind: Service
metadata:
  name: stega-api
spec:
  selector:
    app: stega
    component: api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
---
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: stega
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
    - host: stega.exemplo.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: stega-api
                port:
                  number: 80
```

---

## Manifest: stega-minion-worker

```yaml
# k8s/deployment-minion-worker.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stega-minion-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: stega
      component: minion-worker
  template:
    metadata:
      labels:
        app: stega
        component: minion-worker
    spec:
      containers:
        - name: minion-worker
          image: registry.exemplo.com/stega:2026.06.0
          command: ["carton", "exec", "perl", "script/stega", "minion", "worker"]
          env:
            - name: POSTGRESQL_URL
              valueFrom:
                secretKeyRef:
                  name: stega-secrets
                  key: postgresql-url
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

---

## Secrets e ConfigMaps

```yaml
# k8s/secret.yaml (valores em base64)
apiVersion: v1
kind: Secret
metadata:
  name: stega-secrets
type: Opaque
stringData:
  postgresql-url:           postgresql://stega_app:SENHA@postgres:5432/stega
  postgresql-migration-url: postgresql://stega_migrate:SENHA@postgres:5432/stega
  rabbitmq-password:        SENHA_RABBITMQ
---
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: stega-config
data:
  rabbitmq-host: rabbitmq.stega.svc.cluster.local
  keycloak-url:  https://keycloak.exemplo.com
  jwt-issuer:    https://keycloak.exemplo.com/realms/stega
```

---

## Atualização sem interrupção (rolling update)

```bash
# Atualizar para nova versão da imagem
kubectl set image deployment/stega-api api=registry.exemplo.com/stega:2026.07.0

# Acompanhar o rollout
kubectl rollout status deployment/stega-api

# Reverter em caso de problema
kubectl rollout undo deployment/stega-api
```

O Kubernetes usa a estratégia `RollingUpdate` por padrão:
1. Inicia um Pod novo com a nova imagem
2. Aguarda o `readinessProbe` responder com sucesso
3. Termina um Pod antigo com `SIGTERM`
4. O Hypnotoad recebe `SIGTERM`, termina conexões em andamento e sai

O `InitContainer` de migration roda apenas no Pod novo — múltiplos Pods rodando
simultaneamente com o Mojo::Pg migrations são seguros porque a tabela de controle
de migrations usa locking.

---

## HorizontalPodAutoscaler

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: stega-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: stega-api
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

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Migration em múltiplos InitContainers simultâneos | Rolling update pode rodar migrations duas vezes | Mojo::Pg usa lock de advisory — idempotente; mas `-- N down` pode ser problemático |
| `liveness` muito agressivo | Baixo `initialDelaySeconds` reinicia Pod antes do startup completo | `initialDelaySeconds` >= tempo de startup do Hypnotoad (geralmente 5-15s) |
| Secrets no manifesto em texto plano | Secrets em YAML não são criptografados no Git | Use `stringData` + Git-crypt, Sealed Secrets ou Vault |
| `CMD` sem `-f` no Hypnotoad | Sem `-f` (foreground), Hypnotoad daemoniza e o container "termina" com código 0 | Sempre `hypnotoad -f script/stega` em containers |
| Réplicas do minion-worker x Pods da API | Workers Minion consomem do banco; mais réplicas = mais concorrência — pode sobrecarregar o PostgreSQL | Monitore `pg_stat_activity` e ajuste `--concurrency` do worker |
