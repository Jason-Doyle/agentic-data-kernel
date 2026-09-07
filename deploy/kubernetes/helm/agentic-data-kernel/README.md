# Kubernetes Helm Chart

This chart deploys the Agentic Data Kernel API and effect worker against an
external PostgreSQL 18 database.

## Prerequisites

- Kubernetes 1.29 or newer
- PostgreSQL 18 with pgvector 0.8+ and pgcrypto
- a migration identity with `CREATEROLE`
- a ReadWriteMany filesystem supporting hard links and file fsync
- an externally managed Secret
- a TLS-capable ingress controller when public access is enabled

Create the Secret before installing:

```powershell
kubectl create namespace agentic-data
$databaseUrl = Read-Host "agentic_app PostgreSQL URL"
$migrationDatabaseUrl = Read-Host "Administrative PostgreSQL URL"
$appDatabasePassword = Read-Host "Runtime role password"
$authPepper = Read-Host "AUTH_PEPPER"
$artifactKeyring = Read-Host "ARTIFACT_KEYRING JSON"
$embeddingApiKey = Read-Host "Embedding provider key"

kubectl -n agentic-data create secret generic agentic-data-runtime `
  --from-literal=DATABASE_URL=$databaseUrl `
  --from-literal=AUTH_PEPPER=$authPepper `
  --from-literal=ARTIFACT_KEYRING=$artifactKeyring `
  --from-literal=EMBEDDING_API_KEY=$embeddingApiKey

kubectl -n agentic-data create secret generic agentic-data-admin `
  --from-literal=MIGRATION_DATABASE_URL=$migrationDatabaseUrl `
  --from-literal=APP_DATABASE_PASSWORD=$appDatabasePassword
```

Prefer an external secret operator or provider-native secret integration for
repeatable environments. Direct `kubectl --from-literal` arguments can be
visible to local process inspection.

Install:

```powershell
helm upgrade --install agentic-data `
  .\deploy\kubernetes\helm\agentic-data-kernel `
  --namespace agentic-data `
  --set image.tag="1.1.0" `
  --set config.embeddingBaseUrl="https://api.openai.com/v1" `
  --set config.effectAllowedHosts="payments.example.com"
```

For managed cloud databases, set `config.databaseSsl=require`. Supply
`persistence.existingClaim` when the platform provisions the filesystem
outside the chart.

The storage root must already be writable by UID/GID `10001`, or the CSI
driver must honor the pod `fsGroup`. The optional root init container is
disabled by default because restricted Pod Security policies and NFS
root-squash can reject ownership changes. Enable `artifactInit.enabled` only
after verifying the storage backend and namespace policy.

`networkPolicy.enabled` defaults to false. When enabling it, provide explicit
`networkPolicy.ingressFrom` selectors and `networkPolicy.egress` rules for DNS,
PostgreSQL, the embedding endpoint, and approved effect destinations. Standard
Kubernetes NetworkPolicy cannot filter HTTPS by hostname.

When enabling ingress, configure at least one `ingress.tls` entry and disable
plain HTTP through the selected ingress controller. Set
`ingress.tlsOnlyAnnotation` and `ingress.tlsOnlyValue` to its redirect or
HTTP-disable annotation, for example
`nginx.ingress.kubernetes.io/ssl-redirect=true`. Also set
`config.trustedProxyHops` to the exact number of trusted forwarding hops. The
chart rejects ingress with a zero hop count.

Create the namespace and both Secrets before Helm runs. Runtime pods cannot
read the administrative Secret. The bootstrap and migration hooks
intentionally fail when their external Secret is absent.
They use `jobs.serviceAccountName`, which defaults to the namespace's existing
`default` service account because pre-install hooks run before chart-managed
service accounts are created. Point it at another pre-created service account
when jobs require cloud workload identity.

Add `DATABASE_CA_CERT_BASE64` to the Secret when the PostgreSQL CA is not in
the container's system trust store.

`databaseProxy.enabled` adds a sidecar to API and worker pods and a native
Kubernetes sidecar to both hook Jobs. When using an authenticated local proxy,
point both database URLs at its loopback port and set
`config.databaseSsl=disable`; the proxy owns encrypted upstream verification.
An in-pod init container waits for the loopback proxy port before any main
container starts. Kubernetes 1.29 or newer is required for native sidecars.

Helm stores ordinary values in release history. Do not place credentials in a
values file or pass them with `--set`.
Always set either `image.tag` to an immutable release version or
`image.digest` to a `sha256:` OCI digest, never both.

### Remote MCP

The API can expose authenticated Streamable HTTP MCP at `/mcp`. It is disabled
by default. Enable it only behind the chart's trusted HTTPS ingress:

```powershell
--set-string config.mcpHttpEnabled=true `
--set-string config.mcpHttpPublicOrigin=https://agent-data.example.com `
--set-string config.mcpHttpWriteEnabled=false
```

`mcpHttpPublicOrigin` must exactly match the public scheme and host seen by
clients. The endpoint validates `Host` and any supplied `Origin` header.
Keep write tools disabled for investigation-only agents.
