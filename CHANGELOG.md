# Changelog

## Unreleased

## 1.2.0

- Added authenticated, read-only-by-default Streamable HTTP MCP for remote
  agent hosts, with exact public-origin validation and per-request identity
  checks.
- Added validated Microsoft Agent Framework and Azure SRE Agent integration
  examples.

## 1.1.0

- Added framework-neutral agent middleware with bounded context compilation,
  model-facing JSON Schema tools, identity-bound Agent Intent dispatch,
  durable turn recording, and embedded, in-process production, and HTTP
  adapters.

## 1.0.0

- Declared Agent Intent 1.0 and the documented TypeScript, HTTP, MCP, CLI,
  migration, and deployment surfaces stable. Protocol 0.1 remains accepted
  throughout 1.x.
- Added per-operation credential, tenant, purpose, and scope revalidation,
  explicit tenant predicates, strict runtime-role verification, explicit
  database TLS mode, redirect-free embeddings, and bounded query timeouts.
- Hardened effect execution with tenant-fair leasing, authorization fences,
  abort propagation, expired-dispatch reconciliation, worker health endpoints,
  and crash-after-provider-apply recovery coverage.
- Added signed coordinated backups, exact migration-manifest verification,
  artifact integrity reconciliation, filesystem durability barriers, and
  documented restore-only rollback after migrations begin.
- Added cumulative Prometheus histograms, worker liveness metrics, bounded
  timer processing, effect pagination, and graceful process shutdown.
- Added validated Helm, Azure Container Apps, AWS ECS Fargate, and GKE
  deployment paths with retained storage and separate runtime and
  administrative secrets.
- Added stable compatibility, upgrade, rollback, runbook, package, SBOM,
  provenance, benchmark, and release gates.

## 0.3.0-alpha.5

- Added validated Helm, Azure Bicep, AWS OpenTofu, and GCP OpenTofu deployment
  templates with one shared security and runtime contract.
- Added an idempotent `bootstrap-role` production command for cloud migration
  workflows.
- Rebuilt the README around the agent-first thesis, SRE proof, causal trace,
  comparative evidence, measured costs, and explicit fit boundaries.

## 0.3.0-alpha.4

- Added typed Knowledge and Agency operation layers to the embedded API and
  operation catalogs.
- Moved retail Agent Intent dispatch behind a compatibility adapter without
  removing or renaming existing operations.

## 0.3.0-alpha.3

- Added a reproducible SRE comparison between a competent conventional
  PostgreSQL implementation and the kernel scenario.
- Added correctness parity gates, engine-neutral audit questions, application
  surface measurements, database footprint, and raw generated results.
- Added injectable SRE remediation transports with validated delivery and
  reconciliation identity.

## 0.3.0-alpha.2

- Added bounded causal explanation graphs with structured and human-readable
  TypeScript, Agent Intent, HTTP, MCP, and CLI surfaces.
- Added sanitized artifact nodes and effect-attempt details to trace output.

## 0.3.0-alpha.1

- Added generic durable workflows with optimistic revision and state guards.
- Added FK-backed causal lineage across artifacts, assertions, workflow
  revisions, and effects.
- Added decision- and policy-bound generic effects that reuse authorization,
  budgets, leases, retries, and reconciliation without invoking retail
  finalization.
- Added a deterministic SRE scenario covering contradictory evidence,
  confidence revision, explicit resolution, restart, ambiguous remediation,
  idempotent reconciliation, and final verification.

## 0.2.0-alpha.2

- Made the PostgreSQL embedding model, version, and indexed dimensions
  deployment-configurable up to 2000 dimensions.
- Reworked hybrid search to retrieve bounded HNSW and full-text candidates
  before temporal, graph, and combined-score reranking.
- Added database enforcement for one active embedding space and upgrade-safe
  migration of existing 1536-dimensional assertions.

## 0.2.0-alpha.1

- Added a PostgreSQL 18 and pgvector production profile.
- Added forced tenant row-level security with a non-superuser runtime role.
- Added scoped, purpose-bound API keys with peppered scrypt-derived hashes.
- Added encrypted immutable artifact storage with key rotation support.
- Added OpenAI-compatible 1536-dimensional embeddings without silent fallback.
- Added authenticated HTTP and MCP production interfaces.
- Added budgeted effect intents, authorization fences, DNS-pinned HTTPS
  delivery, unknown outcomes, and provider status reconciliation.
- Added checksum-verified migrations and database-controlled temporal ordering.
- Added coordinated backup and restore with maintenance locking and checksums.
- Added metrics, structured logs, a TLS Caddy edge, load tooling, and
  production integration tests.
- Added runnable library, MCP, HTTP, embedding, effect receiver, and retail
  integration examples.
- Added API, integration, use case, support, contribution, and community
  documentation.
- Added an adoption guide covering demonstrated benefits, unproven benefits,
  operational costs, alternatives, and poor-fit scenarios.
- Added Node and PostgreSQL CI, CodeQL analysis, and dependency update
  configuration.
- Added npm, GHCR, and GitHub release artifacts with package and container
  smoke tests.

## 0.1.0

- Added the embedded SQLite development kernel.
- Added bitemporal assertions, conflict resolution, hybrid retrieval, durable
  retail order state, local HTTP, MCP, CLI, and project documentation.
