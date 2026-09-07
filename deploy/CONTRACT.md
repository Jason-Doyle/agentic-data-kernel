# Deployment Contract

Every deployment template must preserve the same runtime and security
invariants.

## Workloads

Run four independent workloads from the same immutable image:

| Workload | Command | Lifecycle |
| --- | --- | --- |
| Runtime role bootstrap | `node dist/production/cli.js bootstrap-role` | One shot before migrations |
| Database migration | `node dist/production/cli.js migrate` | One shot before API and worker rollout |
| API | `node dist/production/cli.js serve` | Long running, port 4318 |
| Effect worker | `node dist/production/cli.js worker` | Long running, no ingress |

The bootstrap and migration workloads are idempotent. Migrations use a
PostgreSQL advisory lock and checksum every applied migration.

## PostgreSQL

The database must provide:

- PostgreSQL 18;
- pgvector 0.8 or newer;
- `pgcrypto`;
- an administrative migration identity with `CREATEROLE` and permission to
  install the required extensions;
- a fixed `agentic_app` login created by `bootstrap-role`;
- encrypted connections and private network access;
- backups and point-in-time recovery appropriate to the environment.

The runtime role is always configured as:

```text
LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
```

When `agentic_app` already exists, a non-superuser bootstrap identity must also
hold `ADMIN OPTION` on that role. A managed-service administrator or
superuser-equivalent identity is the simplest bootstrap and migration
credential.

## Secrets

Cloud secret stores or externally managed Kubernetes Secrets must provide:

| Name | Consumer |
| --- | --- |
| `DATABASE_URL` | API and worker, using `agentic_app` |
| `MIGRATION_DATABASE_URL` | Bootstrap and migration, using the administrative identity |
| `APP_DATABASE_PASSWORD` | Bootstrap job |
| `DATABASE_CA_CERT_BASE64` | Optional PEM trust bundle for managed PostgreSQL |
| `AUTH_PEPPER` | API and worker |
| `ARTIFACT_KEYRING` | API and worker |
| `EMBEDDING_API_KEY` | API and worker |

API and worker identities must not be able to read
`MIGRATION_DATABASE_URL` or `APP_DATABASE_PASSWORD`. Use separate runtime and
administrative secrets and cloud identities.

If a non-superuser bootstrap identity manages `agentic_app`, its PostgreSQL 18
membership must use `ADMIN TRUE, INHERIT FALSE, SET FALSE`. Privilege-bearing
memberships are rejected.

`APP_DATABASE_PASSWORD` must contain 16 to 256 printable ASCII characters
without spaces. The bootstrap command derives a SCRAM-SHA-256 verifier
client-side so the plaintext password is not sent as a SQL bind value.

`ARTIFACT_CURRENT_KEY_ID` and `ARTIFACT_KEYRING` must identify a 32-byte
base64-encoded encryption key. Secret values must not be committed to values
files, Bicep parameter files, OpenTofu variables, logs, or outputs.
Every template exposes the current key ID separately so rotations can add a
new key to the keyring before switching new writes.

Set `DATABASE_SSL=require`. When the managed PostgreSQL certificate chain is
not present in the container's system trust store, provide its PEM CA bundle
as base64 through `DATABASE_CA_CERT_BASE64`.
Do not add `sslmode`, `sslrootcert`, or other SSL query parameters to database
URLs; the runtime rejects URL-level SSL settings so they cannot weaken the
configured verification policy.

An authenticated database proxy running in the same pod is the exception. In
that profile, the application may use `DATABASE_SSL=disable` only for a
loopback connection while the proxy performs encrypted, authenticated
upstream transport.

## Artifact filesystem

The encrypted artifact store uses:

- exclusive temporary-file creation;
- file `fsync`;
- atomic hard-link creation;
- concurrent reads and writes;
- recursive listing and deletion.

All API and worker replicas must mount the same filesystem at
`ARTIFACT_DIR`, normally `/var/lib/agentic-data/artifacts`. The filesystem must
support hard links within one mount and be writable by UID and GID `10001`.

Compatible examples include Azure Files NFS, Amazon EFS, Google Cloud
Filestore, and suitable Kubernetes ReadWriteMany volumes. Object-storage FUSE
drivers are not supported unless they document equivalent hard-link and
durability semantics.

## Networking

- Expose only the API.
- Remote MCP shares the API listener at `/mcp`; expose it only when
  `MCP_HTTP_ENABLED=true` and `MCP_HTTP_PUBLIC_ORIGIN` exactly matches the
  trusted public HTTPS origin.
- Terminate TLS at the managed ingress or load balancer.
- Set `TRUSTED_PROXY_HOPS` to the exact number of trusted forwarding hops and
  prevent direct access to the Node.js listener.
- Keep PostgreSQL and artifact storage private.
- Set `HOST=0.0.0.0` and `PORT=4318` for the API container.
- Apply platform-specific egress controls for PostgreSQL, DNS, the embedding
  endpoint, and effect destinations. Standard Kubernetes NetworkPolicy cannot
  filter HTTPS by hostname.
- Configure `EFFECT_ALLOWED_HOSTS` explicitly.
- Keep `MCP_HTTP_WRITE_ENABLED=false` for read-only agent integrations.

## Health and rollout

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- Worker liveness, readiness, and metrics: port 4319 on the private network
- Run bootstrap and migrations before increasing API or worker replicas.
- Use immutable image tags or digests.
- Restart workloads after rotating environment-injected secrets.

The API rate limiter is process-local. Horizontal replicas multiply the
effective aggregate request allowance, so multi-replica deployments require a
shared ingress or gateway limiter.
