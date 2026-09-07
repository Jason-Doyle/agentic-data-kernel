# Agentic Data Kernel

> **Author note, 2 September 2026, Jason Doyle**
>
> This project began as a feature forked from a private project and is now
> maintained independently as open source. The documentation is heavily AI
> assisted and may contain errors. Verify important behavior against the
> implementation, tests, and current release before using it in production.

[![CI](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/codeql.yml/badge.svg)](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/agentic-data-kernel?label=npm)](https://www.npmjs.com/package/agentic-data-kernel)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An agent-first persistence layer for durable knowledge, workflows, and
controlled external effects.

Most databases are good at storing current application state. Long-running
agents also need to preserve:

- what was known at a particular time;
- which evidence supported or contradicted it;
- why a decision was authorized;
- which workflow revision produced an external action;
- whether a timed-out action happened;
- how later reconciliation and verification changed the outcome.

Agentic Data Kernel provides those semantics over SQLite for local development
and PostgreSQL for production. It is not a new storage engine, a replacement
for SQL, or a claim that PostgreSQL cannot implement the same behavior. It is a
shared contract for patterns that agentic applications otherwise rebuild as
application-specific tables, workflow code, lineage queries, and effect
recovery logic.

## Proof before platform

The flagship scenario starts with a checkout service at a 42 percent error
rate and ends only after a rollback is durably reconciled and monitoring
observes recovery to 3 percent.

```text
alert
  -> source-backed observations
  -> competing hypotheses
  -> confidence revision
  -> conflict-preserving resolution
  -> decision + governing policy
  -> authorized rollback
  -> timeout after provider apply
  -> runtime restart
  -> provider reconciliation
  -> verification observation
  -> resolved incident
```

The deterministic run closes and recreates runtime objects twice. The rollback
is applied once, its first result is `unknown`, and the next runtime reconciles
the provider state instead of delivering again.

```json
{
  "finalState": "resolved",
  "effectStatus": "succeeded",
  "resolutionStatus": "resolved_with_conflict",
  "deliveryCount": 1,
  "reconciliationCount": 1,
  "agentRestarts": 2,
  "errorRateBefore": 0.42,
  "errorRateAfter": 0.03,
  "traceNodeCount": 16,
  "traceEdgeCount": 19
}
```

From a source checkout, prepare `.env` using the
[Production Profile](docs/PRODUCTION.md#initial-setup), then run:

```powershell
npm install
npm run build
docker compose up -d postgres
docker compose run --rm bootstrap
npm run example:sre
```

See [Flagship SRE Scenario](docs/SRE_SCENARIO.md) for setup, records, and
boundaries.

## The causal trace

`explain` traverses explicitly stored lineage around an artifact, assertion,
workflow revision, or effect. Effect traces include delivery and
reconciliation attempts. Artifact plaintext is excluded.

An abridged rollback trace looks like this. Live output also includes record
values, durable references, and attempt timestamps.

```text
Trace: effect_...

Nodes:
[0] deployment.rollback effect succeeded
  attempt 1: unknown
  attempt 2: succeeded HTTP 200
  [1] decision remediation
  [1] directive incident_remediation_policy
    [2] hypothesis primary_cause
      [3] observation deployed_version
      [3] observation database_cpu_change
      [3] observation error_rate
  [1] observation error_rate

Links:
  assertion:decision --authorizes--> effect_...
  assertion:policy --governs--> effect_...
  workflow:incident@3 --produces--> effect_...
  effect_... --verifies--> assertion:verification
```

The same trace is available as bounded structured JSON through TypeScript,
Agent Intent, HTTP, MCP, and both CLIs. See
[Explain and Trace](docs/EXPLAIN.md).

## Comparative result

The repository implements the incident twice:

1. a competent conventional PostgreSQL application with durable attempts,
   idempotency, reconciliation, lineage, and audit data;
2. a thin adapter that reuses the shipped Agentic Data Kernel scenario.

Correctness is required to tie. CI reruns both variants three times and rejects
stale or inconsistent published evidence.

| Measure | Conventional PostgreSQL | Agentic Data Kernel |
| --- | ---: | ---: |
| Correct runs | 3/3 | 3/3 |
| Delivery count per run | 1 | 1 |
| Reconciliation count per run | 1 | 1 |
| Durable audit answers | 9/9 | 9/9 |
| Observed recovery | 0.42 to 0.03 | 0.42 to 0.03 |
| Application-owned nonblank lines | 317 | 43 |
| Application-authored tables | 8 | 0 |
| Total operated tables | 8 | 18 |
| Median database footprint | 540,672 bytes | 1,572,864 bytes |
| Informational median runtime | 50.75 ms | 898.69 ms |

The result is deliberately not presented as a universal win:

- PostgreSQL matches the kernel on correctness.
- The smaller adapter reuses 930 lines of shipped scenario code and a 16,424
  line dependency. It is not an equal from-scratch implementation comparison.
- The kernel operates more tables, uses more storage, and takes substantially
  longer in this deterministic smoke run.
- Runtime is informational because the variants perform different work. This
  is not a latency benchmark.
- The test reloads database-backed runtime objects. It does not simulate an
  operating-system process crash.

Read the [methodology](benchmarks/sre/README.md), the
[generated report](benchmarks/sre/results/report.md), and the
[raw evidence](benchmarks/sre/results/summary.json).

## Programming model

The API is divided into explicit layers while retaining one compatible Agent
Intent protocol.

| Layer | Responsibility |
| --- | --- |
| Knowledge | Entities, immutable evidence, bitemporal assertions, uncertainty, resolution, retrieval, lineage, and explanation |
| Agency | Guarded workflow revisions, controlled effects, idempotency, attempts, reconciliation, and receipts |
| Retail compatibility | Existing inventory reservation, payment, and order-expiry behavior |

The embedded TypeScript API exposes the layers directly:

```ts
import { AgenticKernel, SqliteStore } from "agentic-data-kernel";

const store = new SqliteStore(".data/app.db");
const kernel = new AgenticKernel(store);

const service = kernel.knowledge.putEntity(
  {
    tenantId: "example",
    principalId: "monitor",
    purpose: "incident-response"
  },
  {
    entityId: "service:checkout",
    entityType: "service",
    canonicalName: "Checkout API"
  }
);

const workflow = kernel.agency.createWorkflow(
  {
    tenantId: "example",
    principalId: "responder",
    purpose: "incident-response"
  },
  {
    instanceId: "incident:1001",
    workflowType: "incident_response",
    initialState: "alerted",
    data: { service: service.entityId }
  }
);
```

Existing top-level methods and all Agent Intent operation names remain
available. TypeScript and HTTP clients submit the same typed envelope, and the
embedded CLI accepts it from a file:

```json
{
  "protocolVersion": "1.0",
  "requestId": "observe-1001",
  "idempotencyKey": "observe-1001",
  "principal": {
    "tenantId": "example",
    "principalId": "monitor",
    "purpose": "incident-response"
  },
  "operation": {
    "op": "assert",
    "assertion": {
      "subjectEntityId": "service:checkout",
      "predicate": "error_rate",
      "object": {
        "type": "number",
        "value": 0.42
      },
      "kind": "observation",
      "sourceArtifactId": "artifact:alert-1001"
    }
  }
}
```

MCP tools accept typed operation fields and bind them to the authenticated
process identity. The production CLI provides administration, worker,
reconciliation, load, and explain commands rather than a general envelope
execution command.

See the [API Reference](docs/API.md).

### Agent middleware

Agentic Data Kernel can be used as lifecycle middleware between an agent host
and its model. The host receives bounded durable context and JSON Schema tools;
model tool calls are translated into identity-bound Agent Intent operations,
and approved turns can be recorded as durable artifacts that are encrypted by
the production profile.

```ts
const session = createEmbeddedAgentMiddleware(kernel, principal).beginRun({
  runId: "run:incident-1001",
});

const { context, tools } = await session.prepareModelInput({
  query: "why is checkout failing?",
  workflow: { instanceId: "incident:1001" },
});
```

Production agents can bind an authenticated `ProductionKernel` principal or
use the remote HTTP adapter. Direct MCP remains available when the model host
already owns context assembly and turn lifecycle. See
[Agent Middleware](docs/AGENT_MIDDLEWARE.md).

Runnable integrations are included for
[Microsoft Agent Framework](examples/microsoft-agent-framework) and
[Azure SRE Agent](examples/azure-sre-agent). The former demonstrates local
stdio and production Streamable HTTP MCP. The latter configures ADK as a
durable incident-context connector and custom SRE specialist.

## When it fits

Use Agentic Data Kernel when several of these are true:

- source disagreement and later correction must remain inspectable;
- valid time and system time both matter;
- decisions and external actions need evidence and policy lineage;
- workflows must resume safely after a restart;
- provider timeouts can leave an action in an unknown state;
- tenant, purpose, budget, and effect authority must be enforced below
  application prompts;
- agents need bounded, machine-readable causal context.

It is probably the wrong tool for simple CRUD, append-only analytics, cache
workloads, or systems where minimum write latency and minimum schema footprint
matter more than durable agency semantics.

## Install and run

The current stable release is `1.2.0`. Pin an exact version in production.

```powershell
npm install agentic-data-kernel@1.2.0
npx --yes agentic-data-kernel@1.2.0 example --db .data\example.db
```

Package entry points and commands:

| Interface | Entry point |
| --- | --- |
| Embedded TypeScript | `agentic-data-kernel` |
| PostgreSQL TypeScript | `agentic-data-kernel/production` |
| Embedded CLI | `agentic-data` or `agentic-data-kernel` |
| Production CLI | `agentic-data-prod` |
| MCP | `agentic-data-kernel mcp`, `agentic-data-prod mcp`, or production `POST /mcp` |
| HTTP | `POST /v1/execute` |

Source checkout:

```powershell
npm install
npm run build
npm test
npm run example
```

Integration examples cover the TypeScript library, MCP, authenticated HTTP,
production retail, the SRE scenario, embedding providers, and effect
receivers. See [Integrations](docs/INTEGRATIONS.md).

## Production profile

The production profile uses PostgreSQL 18, pgvector, forced row-level
security, scoped and purpose-bound API keys, encrypted artifact storage,
configurable embedding spaces, effect budgets, authorization fences,
reconciliation workers, metrics, backups, and Caddy TLS.

```powershell
.\scripts\generate-secrets.ps1
Copy-Item .env.example .env
```

Replace every placeholder in `.env` with the generated values, database
passwords, and embedding-provider configuration before continuing:

```powershell
$env:AGENTIC_DATA_IMAGE = "ghcr.io/jason-doyle/agentic-data-kernel:1.2.0"
docker compose --profile server pull
docker compose --profile server up --no-build
```

PostgreSQL remains the transactional storage engine. The kernel supplies the
agent-facing data model, invariants, and interfaces. See
[Production Profile](docs/PRODUCTION.md) and
[Threat Model](docs/THREAT_MODEL.md).

### Cloud deployment templates

The package includes validated reference workloads for:

| Platform | Template |
| --- | --- |
| Kubernetes | Helm |
| Azure Container Apps | Bicep |
| AWS ECS Fargate | OpenTofu |
| Google Kubernetes Engine | OpenTofu plus Helm |

The templates require existing private PostgreSQL, secret stores, network
controls, TLS, and shared filesystems. They intentionally do not place
generated credentials in Bicep parameters or OpenTofu state. See
[Deployment Templates](deploy/README.md).

## Architecture

```text
TypeScript / HTTP / MCP / CLI
              |
      Agent Intent validation
              |
 identity + scope + purpose + budget
              |
   +----------+-----------+
   |                      |
Knowledge layer       Agency layer
evidence              workflow revisions
assertions             authorized effects
resolution             attempts and receipts
retrieval              reconciliation
lineage                verification
   |                      |
   +----------+-----------+
              |
 retail compatibility adapter
              |
 SQLite development profile
              or
 PostgreSQL + pgvector + RLS
```

## Stable support and boundaries

- Version 1.x supports the bounded production profile documented in
  [Stability and Compatibility](docs/STABILITY.md).
- Production targets one PostgreSQL primary.
- The default rate limiter is process-local.
- One embedding model, version, and dimension is active per deployment.
- Indexed vector dimensions are limited to 2000.
- Changing an embedding space after assertions exist requires explicit
  re-embedding.
- Generic workflow transition policy remains application-owned.
- Effect receivers must honor idempotency keys.
- The SRE telemetry, embeddings, and remediation provider are synthetic.
- Projection epochs, multi-operation plans, and context-package optimization
  are not implemented.

See [Benefits and Tradeoffs](docs/TRADEOFFS.md) for a fuller fit assessment.

## Documentation

- [API reference](docs/API.md)
- [Flagship SRE scenario](docs/SRE_SCENARIO.md)
- [Explain and trace](docs/EXPLAIN.md)
- [SRE benchmark](benchmarks/sre/README.md)
- [Benefits and tradeoffs](docs/TRADEOFFS.md)
- [Use cases](docs/USE_CASES.md)
- [Integration guide](docs/INTEGRATIONS.md)
- [Production profile](docs/PRODUCTION.md)
- [Stability and compatibility](docs/STABILITY.md)
- [Upgrade and rollback](docs/UPGRADING.md)
- [Production runbooks](docs/RUNBOOKS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Release process](docs/RELEASING.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
