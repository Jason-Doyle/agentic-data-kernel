# Security

## Supported versions

| Version | Security support |
| --- | --- |
| 1.x | Supported |
| 0.x | Unsupported after 1.0.0 |

## Supported profiles

The PostgreSQL production profile is the only profile intended for deployment
outside a developer workstation.

The embedded SQLite server is a local development tool. It is restricted to
loopback, has caller-asserted identity, and must not be exposed through a proxy
or container port.

## Reporting vulnerabilities

Use GitHub private vulnerability reporting for:

<https://github.com/Jason-Doyle/agentic-data-kernel/security/advisories/new>

Do not include credentials, customer data, or exploit details in a public
issue.

## Production security requirements

- Run the application with the non-superuser `agentic_app` database role.
- Run `bootstrap-role` before migrations and require runtime role verification
  at startup.
- Reserve the PostgreSQL superuser connection for migrations, backup, and
  restore.
- Terminate TLS at a trusted reverse proxy or service mesh. The included
  Compose profile uses Caddy and does not publish the Node.js listener.
- Set `TRUSTED_PROXY_HOPS` to the exact trusted forwarding chain and prevent
  direct access around it.
- Store API keys, the authentication pepper, artifact keys, database
  passwords, and embedding-provider credentials in a secret manager.
- Keep embedding model, version, and dimensions aligned with the database
  configuration. The runtime role can read but cannot alter that configuration.
- Treat decision and directive assertions as audit bindings, not standalone
  authorization. Generic effects still require scoped keys, approved purposes,
  allowlisted HTTPS targets, and available budgets.
- Keep the artifact keyring available for every key ID referenced by retained
  artifacts.
- Configure a narrow `EFFECT_ALLOWED_HOSTS` list.
- Do not grant `effects:reconcile` to ordinary API clients.
- Restrict `/metrics` and health endpoints at the network layer when operational
  metadata is considered sensitive.
- Keep remote MCP disabled unless needed. When enabled, configure its exact
  public HTTPS origin, preserve the public Host header at the proxy, and keep
  write tools disabled unless a narrowly scoped identity and approval boundary
  are in place.
- Back up the PostgreSQL database and encrypted artifact directory together.
- Sign backup manifests with `BACKUP_MANIFEST_KEY` stored outside the backup
  location.
- Reject backups whose signed migration versions and checksums do not exactly
  match the restoring runtime.
- Test restore procedures before relying on a backup.

## Security properties

- API tokens are high-entropy values stored only as peppered scrypt-derived
  hashes.
- Tenant and principal identity come from the authenticated API key.
- PostgreSQL forced row-level security enforces tenant isolation.
- Every operation requires a scope and an approved purpose.
- Raw SQL is not exposed by the production HTTP or MCP interfaces.
- Artifact plaintext is encrypted with AES-256-GCM before it reaches disk.
- Per-tenant encryption keys are derived from a versioned master-key ring.
- Embedding failures are surfaced and never fall back silently.
- Payment outcomes cannot be supplied through the public intent API.
- Effect delivery requires an allowlisted HTTPS host and rejects private or
  reserved DNS results. The connection is pinned to the validated address while
  TLS still verifies the original hostname.
- Effect budgets are reserved transactionally before an effect is created.
- A durable authorization fence defines whether an effect crossed the dispatch
  boundary before credential revocation.
- A database maintenance lock pauses all supported writers during coordinated
  backup and restore.

## Known boundaries

- Embeddings can contain sensitive information and remain protected by database
  access controls rather than artifact encryption.
- The default rate limiter is process-local. Multi-replica deployments need a
  shared edge or gateway limiter.
- TLS terminates at Caddy or another trusted proxy rather than in Node.js.
- One PostgreSQL primary is assumed by the included Compose profile.
- External effect receivers must honor the supplied idempotency key for
  effectively-once behavior.
- CodeQL uploads results to GitHub code scanning for the public repository.
