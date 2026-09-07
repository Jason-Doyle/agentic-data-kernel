# Threat Model

## Protected assets

- tenant records and assertions;
- artifact plaintext and encryption keys;
- API tokens and authentication pepper;
- embedding-provider credentials;
- inventory, order, budget, and effect state;
- execution receipts and provenance;
- migration and backup integrity.

## Trust boundaries

| Boundary | Untrusted input | Enforcement |
| --- | --- | --- |
| HTTP edge | Headers, JSON, request size | Bearer authentication, purpose, scope, schema, rate limit |
| MCP stdio process | Tool arguments | Process-bound API key identity and operation schemas |
| MCP HTTP edge | Host, Origin, headers, JSON-RPC, tool arguments | Explicit enablement, exact public origin, Bearer identity, purpose, rate limit, read-only default |
| PostgreSQL | Application queries | Non-superuser role, forced RLS, tenant transaction context |
| Artifact disk | Filesystem readers and corrupted bytes | AES-GCM, HKDF tenant key, content hash, strict paths |
| Embedding provider | Remote response and availability | Timeout, schema validation, dimension validation, no fallback |
| Effect receiver | DNS, HTTP response, ambiguous delivery | Host allowlist, public-address check, no redirect, idempotency key |
| Backup media | Corruption or mismatched components | SHA-256 manifest and joint database/artifact recovery |

Remote MCP rejects JSON-RPC batches so each accepted HTTP request contains at
most one protocol message and consumes one rate-limit unit.

## Primary threats and controls

### Tenant impersonation

The server ignores caller authority claims unless they exactly match the
authenticated key. PostgreSQL RLS applies the verified tenant ID within every
transaction.

### Remote MCP rebinding or credential misuse

Remote MCP is disabled by default and requires an exact configured public
origin. The server rejects unexpected `Host` values and rejects supplied
cross-origin requests before API-key authentication. Every request requires
the Bearer API key and approved purpose; no cookie authentication is used.
Write-capable `execute_operation` discovery is separately disabled by default.

### Stolen API key

Tokens are high entropy, never stored in plaintext, purpose constrained, scope
constrained, expirable, revocable, and effect-budget constrained. Rotation
requires creating a new key and revoking the old key.

### Artifact disclosure

Plaintext is never stored in PostgreSQL or artifact files. Search text excludes
raw artifact content. Embeddings remain sensitive derived data and rely on
database controls.

### Prompt or memory poisoning

Retrieved evidence is data, not policy. Agent operations still pass schema,
scope, purpose, budget, and deterministic state checks. A retrieved assertion
cannot grant authority.

### Embedding space confusion

Vectors from different models, model revisions, or dimensions are not compared.
The database stores one active embedding configuration, validates every
assertion against it, and denies runtime-role changes to that configuration.
Changing the space after assertions exist requires an explicit re-embedding
migration.

### Forged payment success

The public intent API rejects payment outcome operations. Only the effect worker
can finalize an effect after an authenticated, allowlisted, idempotent delivery.

### Forged remediation authority

Generic effects require active decision and directive assertions from the same
tenant. The database stores those bindings and FK-backed lineage, while API-key
scope, purpose, allowlisted targets, and budget checks remain authoritative.
Generic workflow operations cannot modify the reserved retail workflow type.

### SSRF

Effect URLs require HTTPS, an explicit hostname allowlist, no embedded
credentials, no redirects, and public DNS results. DNS is checked for every
attempt, and the HTTP connection is pinned to the validated address while TLS
verifies the configured hostname.

### Replay and duplicate delivery

Intent idempotency keys are bound to request hashes. Effect IDs and
idempotency keys remain stable across retries. Conflicting reuse is rejected.

### Credential revocation race

The worker locks the authorizing key and effect while creating an authorization
fence. Revocation before the fence cancels the effect. After the fence, retries
remain permitted because the external side may already have acted.

### Migration tampering

Applied migrations store SHA-256 checksums. A changed applied migration blocks
startup migration rather than silently changing history.

### Backup substitution

Backup manifests hash both database and artifact archives. Restore refuses
checksum mismatches. A database maintenance lock is held while coordinated
backup or restore runs, and supported writers refuse mutations during that
window.

## Residual risks

- A compromised application process can access decrypted artifacts and
  credentials available to that process.
- A malicious approved embedding provider receives evidence plaintext.
- An allowlisted effect host can still behave maliciously.
- Process-local rate limiting does not coordinate multiple replicas.
- Availability and regional disaster recovery depend on the PostgreSQL and
  storage deployment selected by the operator.
