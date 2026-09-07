# Production Profile

## Architecture

```text
TLS proxy or service mesh
          |
authenticated HTTP or MCP
          |
production kernel
  | scope and purpose checks
  | PostgreSQL tenant transaction
  | real embedding provider
  | encrypted artifact store
  | receipts and idempotency
          |
PostgreSQL 18 + pgvector
          |
separate effect worker
          |
allowlisted HTTPS receivers
```

The runtime role is `agentic_app`. It is not a superuser and does not have
`BYPASSRLS`. Migrations run separately as the PostgreSQL administrator.
External PostgreSQL deployments require pgvector 0.8.0 or newer. The included
Compose profile pins pgvector 0.8.6.

## Choose an image

Production releases are published as:

```text
ghcr.io/jason-doyle/agentic-data-kernel:<version>
```

Set `AGENTIC_DATA_IMAGE` to an exact version in `.env`. The same image runs the
migration command, HTTP service, effect worker, and production MCP process.
Prereleases also receive the moving `next` tag, but production deployments
should not rely on it.

To use the published image:

```powershell
docker compose --profile server pull
docker compose --profile server up --no-build
```

To build the checked-out source instead:

```powershell
docker compose --profile server up --build
```

## Initial setup

Generate local secrets:

```powershell
.\scripts\generate-secrets.ps1
```

Copy `.env.example` to `.env`, replace every placeholder, and configure an
OpenAI-compatible embeddings endpoint.

`DATABASE_SSL` is required. Set it to `require` for managed PostgreSQL and to
`disable` only for local development or an authenticated loopback database
proxy. If the provider CA is not
already in the container's trust store, set `DATABASE_CA_CERT_BASE64` to the
base64 encoding of its PEM CA bundle.
Do not add SSL query parameters such as `sslmode` to `DATABASE_URL` or
`MIGRATION_DATABASE_URL`; use these dedicated settings.

The `prod:*` npm scripts load `.env` through Node's `--env-file` option.

Start PostgreSQL and create the restricted role:

```powershell
docker compose up -d postgres
docker compose run --rm bootstrap
```

Cloud and Kubernetes deployments use the equivalent packaged command:

```powershell
node dist\production\cli.js bootstrap-role
```

From a source checkout, `npm run prod:bootstrap` runs the same command with
`.env`.

It reads `MIGRATION_DATABASE_URL` and `APP_DATABASE_PASSWORD`, then creates or
repairs the fixed `agentic_app` role with no superuser, database-creation,
role-creation, inheritance, or RLS-bypass privileges.
The password must contain 16 to 256 printable ASCII characters without spaces.
Existing `agentic_app` role memberships or object ownership cause bootstrap to
fail rather than preserve privilege-bearing state.

Apply migrations with the administrative connection:

```powershell
npm run prod:migrate
```

Create an API key:

```powershell
node --env-file=.env dist\production\cli.js create-key `
  --tenant example `
  --tenant-name "Example" `
  --principal catalog-agent `
  --scopes data:read,data:write,inventory:admin,orders:write,effects:write `
  --purposes catalog-ingestion,checkout `
  --effect-currency USD `
  --effect-budget 1000
```

The token is shown once. Store it in a secret manager.

## Run

Run the HTTP service and effect worker together from source:

```powershell
docker compose --profile server up --build
```

For a pinned published image, omit `--build` and use the commands in
[Choose an image](#choose-an-image).

The Compose profile publishes only the Caddy TLS endpoint at
`https://localhost:8443`. The Node.js service remains private on the Compose
network. Caddy uses its internal CA for the local profile. Trust or replace that
CA according to your environment before connecting clients.

The `artifact-init` service creates the bind-mounted artifact directory and
assigns it to the non-root application UID before the app and worker start.

Or run them directly:

```powershell
npm run prod:serve
npm run prod:worker
```

## Cloud deployment templates

Validated reference workload templates are available for:

- Kubernetes through Helm;
- Azure Container Apps through Bicep;
- AWS ECS Fargate through OpenTofu;
- Google Kubernetes Engine through OpenTofu and Helm.

They consume existing private PostgreSQL, secret-management, network, TLS, and
shared-filesystem resources rather than placing credentials in infrastructure
state. Read [Deployment Templates](../deploy/README.md) and the shared
[Deployment Contract](../deploy/CONTRACT.md).

## HTTP authentication

Every production API request except liveness, readiness, and metrics requires:

```text
Authorization: Bearer adk.<key-id>.<secret>
X-Agent-Purpose: approved-purpose
```

The intent envelope must contain the same tenant, principal, and purpose as the
authenticated key. A mismatch is rejected.

Production routes, through the TLS proxy:

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health/live` | No | Process liveness |
| `GET /health/ready` | No | Database and migration readiness |
| `GET /metrics` | No | Prometheus text metrics |
| `GET /v1/catalog` | Yes | Production capabilities |
| `POST /v1/execute` | Yes | One scoped Agent Intent operation |
| `POST /mcp` | Yes | Optional stateless Streamable HTTP MCP |

There is no production SQL route.

## MCP

Set:

```text
AGENTIC_DATA_API_KEY
AGENTIC_DATA_PURPOSE
```

Then run:

```powershell
npm run prod:mcp
```

The MCP process authenticates at startup, binds every tool to that identity,
and revalidates revocation, expiry, tenant status, scope, and purpose for every
operation. It does not accept caller-supplied tenant or principal identities.

### Remote Streamable HTTP MCP

The production HTTP service can expose a stateless MCP endpoint at:

```text
POST /mcp
```

It is disabled by default. Enable it only behind the same trusted HTTPS edge as
the production API:

```text
MCP_HTTP_ENABLED=true
MCP_HTTP_PUBLIC_ORIGIN=https://agent-data.example.com
MCP_HTTP_WRITE_ENABLED=false
```

Clients must send on every request:

```text
Authorization: Bearer <ADK API key>
X-Agent-Purpose: <approved-purpose>
```

The public origin must contain only the exact public scheme, hostname, and
optional port. Remote MCP validates the `Host` header and any supplied
`Origin` header before authenticating. Reverse proxies must preserve the
original public `Host`.

Remote MCP is stateless and uses JSON responses rather than a long-lived SSE
session. Authentication, revocation, expiry, tenant state, purpose, and scope
are checked for every request and operation. JSON-RPC batches are rejected so
one HTTP request cannot multiply work behind one rate-limit charge.

With `MCP_HTTP_WRITE_ENABLED=false`, the endpoint advertises only:

```text
search_knowledge
resolve_claims
get_machine
list_effects
explain_trace
```

Setting it to `true` additionally advertises `execute_operation`. Use a
separate, narrowly scoped key and an external review or approval boundary
before exposing write or effect operations.

`GET /mcp` and `DELETE /mcp` are not supported in stateless JSON-response mode.

## Encrypted artifacts

`ARTIFACT_KEYRING` is a JSON object whose values are base64-encoded 32-byte
keys:

```json
{"v1":"base64-key","v2":"base64-key"}
```

`ARTIFACT_CURRENT_KEY_ID` selects the key for new writes. Keep old keys in the
ring until every artifact using them has expired, been deleted, or been
reencrypted.

Artifact files use:

- a random 96-bit nonce;
- AES-256-GCM;
- tenant-derived keys using HKDF-SHA256;
- authenticated metadata binding tenant, artifact ID, media type, and content
  hash;
- atomic hard-link publication from a synced temporary file;
- immutable content-address verification.

Artifact metadata writes are serialized with a database advisory lock. A failed
or interrupted request can leave encrypted ciphertext without metadata. This is
safer than deleting a file another concurrent transaction may reference. An
administrator removes aged orphan files with:

```powershell
node --env-file=.env dist\production\cli.js reconcile-artifacts
```

Reconciliation requires `MIGRATION_DATABASE_URL` and refuses an RLS-restricted
runtime connection.

## Embeddings

The production profile calls:

```text
POST <EMBEDDING_BASE_URL>/embeddings
```

It sends the configured model, input list, and dimensions. Provider errors,
timeouts, invalid result counts, and dimension mismatches fail the operation.
There is no hash-vector fallback.

Configure one active embedding space:

```text
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_VERSION=openai-compatible-v1
EMBEDDING_DIMENSIONS=1536
```

`EMBEDDING_DIMENSIONS` accepts 1 through 2000, the HNSW limit for pgvector's
single-precision `vector` type. Migrations create a matching expression index
such as `assertions_embedding_hnsw_768`.

Every provider result must contain the configured number of finite values.
Zero vectors are rejected because they cannot participate in cosine search.

The database enforces one model, version, and dimension across all assertions.
Once assertions exist, changing any of those values is rejected. A model change
requires an explicit re-embedding migration so vectors from different semantic
spaces are never compared.

Hybrid retrieval first collects bounded vector and full-text candidate sets,
then applies temporal validity, graph scope, and combined-score reranking.
Candidate selection keeps those same validity and graph constraints inside the
indexed scans to preserve current-state and graph-filter behavior.

Tune retrieval with:

```text
SEARCH_CANDIDATE_LIMIT=200
HNSW_EF_SEARCH=100
HNSW_MAX_SCAN_TUPLES=20000
```

Larger values can improve recall under selective tenant, temporal, or graph
filters at the cost of latency and memory. `SEARCH_CANDIDATE_LIMIT` should
remain several times larger than the requested result limit.

Upgrading an existing 1536-dimensional database preserves its vectors and
records their current model and version as the active space. Migration 002
refuses databases that contain multiple spaces or zero vectors. The column
conversion and index replacement require a maintenance window on large
assertion tables.

Artifact plaintext may be sent to the configured provider when an assertion
uses that artifact as evidence. Use an approved private endpoint when the data
must not leave your environment.

## Effects and reconciliation

An effect is created only when:

- the API key has `effects:write`;
- the request purpose is approved;
- the key is active and unexpired;
- the effect amount fits within the remaining budget;
- the target uses HTTPS and its host is allowlisted.

Money values use canonical decimal strings with at most four decimal places.
The API key budget and payment amount must use the same three-letter currency.

Payment requests also provide a provider status URL. After normal delivery
attempts are exhausted, the worker continues status reconciliation rather than
stranding the order and reserved budget.

The worker acquires a database lease and authorization fence while locking the
authorizing key. Revocation that commits before this fence cancels the effect.
Once the fence is committed, retries are permitted only with the same effect ID
and idempotency key because the remote side may already have acted.

The worker rejects private and reserved DNS results, pins the connection to the
validated address, retains TLS verification for the original hostname, and
disables redirects.
Timeouts, retryable responses, and ambiguous acknowledgements become `unknown`.
They are retried with the same idempotency key up to
`EFFECT_MAX_ATTEMPTS`. A receiver must return a stable `providerReference` for
success.

The worker rotates across active tenants between leases. Multiple replicas can
run concurrently because leases use `SKIP LOCKED`, but PostgreSQL connection
capacity must include every replica. On shutdown, outbound requests are
aborted. Ambiguous results remain durable and are reconciled with the original
effect ID and provider idempotency key.

The worker exposes private liveness, readiness, and metrics endpoints on
`WORKER_MONITOR_HOST` and `WORKER_MONITOR_PORT`, defaulting to
`127.0.0.1:4319`.

Public clients cannot submit payment outcomes.

### Generic effects

`request_effect` attaches an effect to an exact non-retail workflow revision
and requires active decision and directive assertions. These bindings are
stored with composite tenant FKs and causal lineage edges. They document why an
effect was requested; API-key scope, purpose, host allowlists, and budget
checks remain the authorization boundary.

Generic effects use the same leases, authorization fences, retry policy, and
status reconciliation as payments. On a terminal result, the worker settles
the reserved budget but does not mutate inventory or workflow state. The agent
must inspect the durable effect and explicitly advance its workflow.

Migration 003 adds generic workflow metadata, authority bindings, and the
tenant-isolated lineage table. Existing retail effects retain the
`retail_order_payment` outcome handler.

Before adding provider-level idempotency enforcement, migration 003 checks
historical effects for duplicate keys within the same tenant and provider
origin. Resolve any reported collision before retrying the migration; the
migration rolls back without changing the schema.

### Timers

`process_timers` is intentionally tenant-scoped and is not an autonomous global
scheduler. Invoke it periodically through an authenticated Agent Intent client
whose key has `workflows:run` for that tenant. Each call locks and processes at
most 100 due timers with `SKIP LOCKED`; continue until the returned array is
empty. Run only one logical scheduler per tenant unless duplicate invocations
are acceptable.

### Rate limiting and proxies

`RATE_LIMIT_PER_MINUTE` is enforced per API process and API key. A separate
pre-authentication limiter uses the resolved client address. Set
`TRUSTED_PROXY_HOPS` to the exact number of trusted proxies that append
`X-Forwarded-For`, and keep the Node.js listener unreachable except through
those proxies. Leave it at `0` for direct connections.

Multiple API replicas multiply the built-in allowance. Production
multi-replica deployments need a shared limiter at the ingress, gateway, or
edge.

## Backup and restore

Create a checksum-manifested backup:

```powershell
docker compose --profile server stop app worker
.\scripts\backup.ps1
```

Restore after stopping application and worker processes:

```powershell
.\scripts\restore.ps1 `
  -BackupDirectory .backups\<timestamp> `
  -ConfirmRestore
```

The database and encrypted artifacts are one recovery unit. Backup manifests
are authenticated with `BACKUP_MANIFEST_KEY`, include the exact database
migration versions and checksums, and must be copied with their signature.
Backup and restore
set a database maintenance flag that every supported writer checks while
holding a transaction lock. The scripts also refuse running Compose app or
worker containers.

## Load smoke test

```powershell
npm run prod:load -- `
  --url https://localhost:8443 `
  --tenant example `
  --principal load-agent `
  --purpose load-test `
  --requests 1000 `
  --concurrency 25
```

The harness reports success count, requests per second, and p50, p95, and p99
latency. It is a smoke tool, not a substitute for sustained workload, fault,
and recovery testing.

## Operational checklist

1. Apply migrations through the administrator connection.
2. Verify `/health/ready`.
3. Confirm the runtime database role is not a superuser and has no
   `BYPASSRLS`.
4. Test two-tenant isolation.
5. Confirm artifact files do not contain plaintext.
6. Verify the embedding endpoint and dimension.
7. Configure effect allowlists and budgets.
8. Start the effect worker.
9. Capture `/metrics` and structured logs.
10. Run a backup and restore drill.
11. Run the authenticated load smoke test.
12. Review `SECURITY.md` before exposing the service.
