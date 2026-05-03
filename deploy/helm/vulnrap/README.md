# VulnRap Helm Chart

A Helm chart for deploying the [VulnRap](https://vulnrap.com) API server to Kubernetes. This is the k8s companion to the root `docker-compose.yml` self-hosted example.

> **Status:** Reference chart. Not published to a Helm repo — install directly from the source tree.

## TL;DR

```bash
git clone https://github.com/vulnrap/vulnrap.git
cd vulnrap

helm install vulnrap ./deploy/helm/vulnrap \
  --namespace vulnrap --create-namespace \
  --set-string secrets.data.DATABASE_URL="postgresql://vulnrap:vulnrap@my-pg:5432/vulnrap" \
  --set-string secrets.data.OPENAI_API_KEY="sk-..."
```

## Requirements

- Kubernetes >= 1.24
- Helm >= 3.8
- A PostgreSQL 14+ instance reachable from the cluster (this chart does **not** bundle Postgres — bring your own)
- A container image of the API server published to a registry your cluster can pull from. The `image.repository` default (`ghcr.io/vulnrap/vulnrap`) is a placeholder — override it.

## Installation

### 1. Provision PostgreSQL

This chart deliberately leaves Postgres out of scope. Recommended options:

- [Bitnami PostgreSQL chart](https://github.com/bitnami/charts/tree/main/bitnami/postgresql)
- [CloudNativePG](https://cloudnative-pg.io/) operator
- A managed service (AWS RDS, GCP Cloud SQL, Neon, Supabase, etc.)

Capture the resulting `DATABASE_URL` for the next step.

### 2. Install the chart

```bash
helm install vulnrap ./deploy/helm/vulnrap \
  --namespace vulnrap --create-namespace \
  --values my-values.yaml
```

A minimal `my-values.yaml`:

```yaml
image:
  repository: ghcr.io/your-org/vulnrap
  tag: "v0.1.0"

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: vulnrap.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: vulnrap-tls
      hosts:
        - vulnrap.example.com

env:
  PUBLIC_URL: "https://vulnrap.example.com"
  ALLOWED_ORIGINS: "https://vulnrap.example.com"

secrets:
  data:
    DATABASE_URL: "postgresql://vulnrap:vulnrap@vulnrap-postgresql:5432/vulnrap"
    OPENAI_API_KEY: ""
```

### 3. Verify

```bash
kubectl -n vulnrap get pods,svc,ingress
kubectl -n vulnrap port-forward svc/vulnrap 8080:80
curl http://localhost:8080/api/health
```

## Resources Created

| Resource                             | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `Deployment`                         | Runs `replicaCount` copies of the API server container.                |
| `Service` (ClusterIP by default)     | In-cluster endpoint on port `service.port`.                            |
| `Ingress` (optional)                 | External HTTP/HTTPS entry point.                                       |
| `ConfigMap`                          | Non-sensitive env vars (`PORT`, `PUBLIC_URL`, `ALLOWED_ORIGINS`, …).   |
| `Secret` (stub, optional)            | Holds `DATABASE_URL`, `OPENAI_API_KEY`. **Do not commit real values.** |
| `ServiceAccount` (optional)          | Dedicated identity for the workload.                                   |
| `HorizontalPodAutoscaler` (optional) | CPU-based autoscaling.                                                 |

## Values

| Key                                          | Default                                            | Description                                                  |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `image.repository`                           | `ghcr.io/vulnrap/vulnrap`                          | Container image. **Override.**                               |
| `image.tag`                                  | `""` (chart appVersion)                            | Image tag.                                                   |
| `image.pullPolicy`                           | `IfNotPresent`                                     | Image pull policy.                                           |
| `imagePullSecrets`                           | `[]`                                               | Pull secrets for private registries.                         |
| `replicaCount`                               | `2`                                                | Number of API server pods (ignored when autoscaling).        |
| `service.type`                               | `ClusterIP`                                        | Service type.                                                |
| `service.port`                               | `80`                                               | Service port.                                                |
| `service.targetPort`                         | `8080`                                             | Container port (matches `env.PORT`).                         |
| `ingress.enabled`                            | `false`                                            | Enable Ingress.                                              |
| `ingress.className`                          | `""`                                               | IngressClass.                                                |
| `ingress.hosts`                              | `[{host: vulnrap.local, …}]`                       | Host/path rules.                                             |
| `ingress.tls`                                | `[]`                                               | TLS configuration.                                           |
| `resources`                                  | `100m/256Mi → 1000m/1Gi`                           | CPU/memory requests & limits.                                |
| `autoscaling.enabled`                        | `false`                                            | Enable HPA.                                                  |
| `autoscaling.minReplicas`                    | `2`                                                | HPA min.                                                     |
| `autoscaling.maxReplicas`                    | `10`                                               | HPA max.                                                     |
| `autoscaling.targetCPUUtilizationPercentage` | `75`                                               | HPA target CPU %.                                            |
| `livenessProbe` / `readinessProbe`           | HTTP `/api/health`                                 | Probe configuration. Set `enabled: false` to disable.        |
| `podSecurityContext`                         | non-root, fsGroup 1000                             | Pod security context.                                        |
| `securityContext`                            | drop ALL caps, RO root FS, no privilege escalation | Container security context.                                  |
| `serviceAccount.create`                      | `true`                                             | Create a dedicated ServiceAccount.                           |
| `env`                                        | see `values.yaml`                                  | Non-sensitive env vars (ConfigMap).                          |
| `extraEnv`                                   | `[]`                                               | Extra env vars (raw `[].name/value`).                        |
| `secrets.create`                             | `true`                                             | Create the Secret stub. Set `false` to use `existingSecret`. |
| `secrets.existingSecret`                     | `""`                                               | Name of a pre-existing Secret to mount instead.              |
| `secrets.data.DATABASE_URL`                  | placeholder                                        | Postgres connection string. **Override.**                    |
| `secrets.data.OPENAI_API_KEY`                | `""`                                               | Optional LLM key.                                            |

See [`values.yaml`](./values.yaml) for the authoritative, commented list.

## Secret Management

The chart's `secrets-stub.yaml` is for **bootstrapping and demos only**. For real environments:

1. Set `secrets.create=false` and `secrets.existingSecret=<name>`.
2. Create the Secret out-of-band via your preferred tool: [`sops`](https://github.com/getsops/sops), [Sealed Secrets](https://sealed-secrets.netlify.app/), [External Secrets Operator](https://external-secrets.io/), HashiCorp Vault, etc.
3. The Secret must contain the same keys the chart expects (`DATABASE_URL`, optionally `OPENAI_API_KEY`).

## Linting

The chart is verified with `helm lint`:

```bash
helm lint ./deploy/helm/vulnrap
```

## Upgrading

```bash
helm upgrade vulnrap ./deploy/helm/vulnrap \
  --namespace vulnrap \
  --reuse-values \
  --set image.tag=v0.2.0
```

A rolling update is performed automatically. ConfigMap/Secret changes trigger a rollout via pod-template checksum annotations.

## Uninstall

```bash
helm uninstall vulnrap --namespace vulnrap
```

Your external Postgres (and any data in it) is untouched.

## Out of Scope

- Publishing to a Helm repository (install from source).
- Bundling PostgreSQL — bring your own.
- Mesh / network policies — layer them on top per your cluster's conventions.
