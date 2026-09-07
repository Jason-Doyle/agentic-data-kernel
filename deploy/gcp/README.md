# Google Kubernetes Engine with OpenTofu

This module installs the shared Helm chart into an existing GKE cluster.
GKE Autopilot is the recommended managed runtime for this profile.

## Required Google Cloud resources

- private, VPC-native GKE cluster;
- Cloud SQL for PostgreSQL 18 with pgvector 0.8+ and pgcrypto;
- private IP connectivity from GKE to Cloud SQL;
- Filestore mounted through a ReadWriteMany PVC;
- separate runtime and administrative Kubernetes Secrets matching the
  deployment contract;
- runtime and job Kubernetes service accounts bound through Workload Identity
  to a Google service account with `roles/cloudsql.client`;
- TLS ingress configuration when public access is enabled.

Cloud Storage FUSE is not supported because the artifact store requires POSIX
hard links. Use Filestore.

The module runs an immutable Cloud SQL Auth Proxy sidecar in API, worker,
bootstrap, and migration pods. Set both database URLs to
`127.0.0.1:5432`; the chart disables application-level TLS only for that
loopback hop while the proxy authenticates and encrypts the Cloud SQL
connection.
The API Service is annotated for a standalone GKE NEG so GCE ingress has a
container-native backend even when automatic NEG injection is unavailable.
The module trusts two `X-Forwarded-For` hops for the documented GCE load
balancer topology so the pre-authentication limiter keys the originating
client rather than the load balancer.

Create the namespace, both Secrets, and Filestore-backed PVC before applying
this module. The required Secret keys are listed in the
[Helm chart README](../kubernetes/helm/agentic-data-kernel/README.md).
Also create `job_service_account_name` before applying because Helm
pre-install hooks run before chart-managed service accounts. Bind both that
service account and the runtime service account to
`gcp_service_account_email`.

## Deploy

Authenticate with Google Cloud and ensure the current identity can read the
cluster and create Kubernetes resources:

```powershell
gcloud auth application-default login
Copy-Item .\deploy\gcp\terraform.tfvars.example `
  .\deploy\gcp\terraform.tfvars

# Uncomment and set every required value, including image_tag.
tofu -chdir=deploy\gcp init
tofu -chdir=deploy\gcp apply
```

The Helm release runs the runtime-role bootstrap and migration jobs before the
API and worker rollout.
When `ingress_enabled` is true, `ingress_tls_secret_name` is required. For the
GCE ingress controller, also set `kubernetes.io/ingress.allow-http` to
`"false"`.

Remote MCP shares the HTTPS ingress at `/mcp`. Set `mcp_http_enabled = true`
and `mcp_http_public_origin` to the exact external origin. The module keeps
`mcp_http_write_enabled` false by default.
