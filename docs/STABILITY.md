# Stability and Compatibility

Version 1.0.0 defines the stable public contract for Agentic Data Kernel.

## Supported runtime scope

The stable PostgreSQL profile supports:

- Node.js 22.19 or newer in the Node 22 and Node 24 LTS lines;
- Linux `amd64` and `arm64` containers;
- PostgreSQL 18 with pgvector 0.8 or newer and pgcrypto;
- one PostgreSQL primary;
- one or more API replicas behind a trusted TLS gateway and shared rate
  limiter;
- one or more effect workers using database leases;
- a shared POSIX filesystem supporting hard links and fsync;
- offline, forward-only database migrations;
- the documented Kubernetes, Azure, AWS, and GCP workload templates.

The embedded SQLite profile is a stable local-development interface. It is not
supported as a network production service.

## Public API

The stable API consists of:

- documented exports from `agentic-data-kernel`;
- documented exports from `agentic-data-kernel/production`;
- Agent Intent protocol 1.0 operations and results;
- the production HTTP routes and MCP tools;
- CLI commands and documented environment variables;
- PostgreSQL migration filenames, order, and checksums;
- documented deployment-template inputs.

Files or symbols not exported by the package entry points are internal.

Remote Streamable HTTP MCP is an optional production route. It is disabled by
default, uses stateless JSON responses, authenticates every request, and
advertises read-only tools unless writes are explicitly enabled.

Breaking changes to the stable API require a new major version. Additive
operations, optional fields, and backwards-compatible deployment inputs may
ship in a minor version. Fixes that preserve the contract ship in a patch
version.

## Agent Intent compatibility

Protocol `1.0` is the stable default. Protocol `0.1` remains accepted
throughout the 1.x release line for existing alpha clients.

Legacy `list_effects` calls that omit pagination continue to return the full
matching set. New clients should use `afterEffectId` and `limit`.

An idempotency key is scoped by tenant, principal, and protocol request
content. Exact retries return the original durable result and receipt while
the outer response uses the current call's `requestId`.

## Database compatibility

Released migration files are immutable. Runtime startup requires the exact
known migration set and checksums and rejects missing, changed, or newer
schemas.

Migrations are forward-only and may require downtime. A database cannot be
downgraded by deploying an older container. Rollback requires restoring the
coordinated, signed database and artifact backup created before migration.

The supported stable upgrade origin is `0.3.0-alpha.5`.

## Reference deployment boundaries

Cloud modules deploy application workloads into existing landing zones. Cloud
accounts, private networks, managed PostgreSQL policy, secret stores, TLS
certificates, storage classes, DNS, backups, and provider quotas remain
operator responsibilities.

Tenant timer invocation and a shared edge rate limiter for multi-replica API
deployments also remain operator responsibilities.

No commercial SLA or managed-service commitment is included.
