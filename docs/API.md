# API Reference

## Interfaces

| Interface | Profile | Entry point |
| --- | --- | --- |
| TypeScript library | Development | `agentic-data-kernel` |
| TypeScript production library | PostgreSQL | `agentic-data-kernel/production` |
| CLI | Development | `agentic-data` |
| CLI | PostgreSQL | `agentic-data-prod` |
| HTTP | Development | `POST /v1/execute` |
| HTTP | PostgreSQL | `POST /v1/execute` |
| MCP | Development | `agentic-data-kernel mcp` |
| MCP | PostgreSQL | `agentic-data-prod mcp` |
| MCP | PostgreSQL remote | `POST /mcp` when explicitly enabled |
| Agent middleware | Development | `createEmbeddedAgentMiddleware` |
| Agent middleware | PostgreSQL in-process | `createProductionAgentMiddleware` |
| Agent middleware | PostgreSQL HTTP | `createProductionHttpAgentMiddleware` |

## Agent middleware

The framework-neutral middleware binds a host-supplied principal, compiles
bounded durable context, returns model-facing JSON Schema tools, translates
tool calls into Agent Intent 1.0 envelopes, and records approved turns as
immutable artifacts.

Core lifecycle:

```text
create middleware
  -> beginRun
  -> prepareModelInput
  -> model invocation owned by host
  -> invokeTool
  -> recordTurn
```

The model never supplies tenant, principal, purpose, or API-key fields. See
[Agent Middleware](AGENT_MIDDLEWARE.md) for embedded, in-process production,
remote HTTP, and direct MCP integration patterns.

## Intent envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "unique-request-id",
  "idempotencyKey": "stable-retry-key",
  "principal": {
    "tenantId": "tenant",
    "principalId": "service",
    "purpose": "approved-purpose"
  },
  "operation": {}
}
```

`requestId` identifies one call. `idempotencyKey` identifies one logical
operation across retries within a tenant and principal. Reusing a key with
different operation content in that scope is rejected. Another principal has a
separate idempotency namespace.

On replay, the outer response contains the current call's `requestId`; the
durable receipt retains the original request ID.

In the PostgreSQL profile, the supplied principal must exactly match the
authenticated API key.

## Operation layers

Agent Intent keeps one backward-compatible operation union and one execution
endpoint. Operations are now grouped into three explicit layers:

| Layer | Responsibility |
| --- | --- |
| Knowledge | Entities, artifacts, temporal assertions, resolution, retrieval, lineage, and explanation |
| Agency | Generic workflows, controlled effects, workflow reads, and effect reads |
| Retail compatibility | Inventory reservation, payment, order expiry, and existing retail workflow behavior |

The embedded TypeScript API exposes these as `kernel.knowledge`,
`kernel.agency`, and `kernel.retail`. Existing methods such as
`kernel.assert(...)`, `kernel.createWorkflow(...)`, and
`kernel.reserveInventory(...)` remain available with unchanged behavior.
`kernel.agency.getMachine(...)` returns either a generic workflow or retail
order record, while `kernel.retail.getOrder(...)` requires a retail order.

The PostgreSQL, HTTP, MCP, and CLI profiles continue to use the same Agent
Intent envelope. `GET /v1/catalog` now reports the layer for each available
operation. No operation name was removed or renamed.

## Operations

| Operation | Layer | Scope | Description |
| --- | --- | --- | --- |
| `put_entity` | Knowledge | `data:write` | Create or update an entity identity |
| `put_artifact` | Knowledge | `data:write` | Store immutable source evidence |
| `assert` | Knowledge | `data:write` | Add or supersede a typed temporal assertion |
| `resolve` | Knowledge | `data:read` | Return known, unknown, conflicting, or policy-selected values |
| `search` | Knowledge | `data:read` | Run hybrid retrieval with optional graph filters |
| `add_lineage` | Knowledge | `data:write` | Add a typed causal link between durable records |
| `explain` | Knowledge | `data:read` | Traverse bounded typed causal lineage |
| `create_workflow` | Agency | `workflows:run` | Create a non-retail durable workflow |
| `advance_workflow` | Agency | `workflows:run` | Commit a guarded workflow transition |
| `request_effect` | Agency | `effects:write` | Request an authorized generic external effect |
| `get_machine` | Agency | `data:read` | Read current workflow state |
| `list_effects` | Agency | `data:read` | Read effect state |
| `seed_inventory` | Retail compatibility | `inventory:admin` | Create initial inventory for a SKU and location |
| `reserve_inventory` | Retail compatibility | `orders:write` | Reserve stock and start an order workflow |
| `request_payment` | Retail compatibility | `effects:write` | Reserve effect budget and create a payment intent |
| `process_timers` | Retail compatibility | `workflows:run` | Process retail reservation timers using database server time |

`record_payment_outcome` exists only in the development profile. The production
profile accepts terminal effect state only from the effect worker.

`record_effect_outcome` is the development-profile equivalent for generic
effects. It is rejected by the production API and MCP surface.

`list_effects` accepts optional `afterEffectId` and `limit` fields. `limit`
must be from 1 through 100. Supplying a cursor without a limit uses 100.
Omitting both fields preserves the unbounded behavior used by protocol 0.1
clients. New callers should always paginate.

## Generic workflows

`create_workflow` stores a caller-defined workflow type, initial state, JSON
data, revision 1, and an append-only history record. The reserved
`retail_order` type cannot be created or changed through generic operations.

`advance_workflow` requires both the expected revision and expected state. It
increments the revision exactly once and can mark the workflow terminal.
Terminal workflows cannot transition again.

The application owns each generic workflow's allowed state graph and grants
`workflows:run` only to principals allowed to enact it. The kernel enforces
revision, state, terminality, history, tenancy, and retail isolation rather
than interpreting domain transition policy.

## Generic effects

`request_effect` requires:

- a non-retail workflow and exact originating revision;
- active `decision` and `directive` assertions from the same tenant;
- an HTTPS target and status URL accepted by production network policy;
- an `effects:write` key with the current purpose;
- sufficient budget when a non-zero budget amount is supplied.

The effect worker owns delivery, retry, unknown-outcome reconciliation, and
budget settlement. A generic effect never commits inventory or changes the
workflow automatically. The agent advances the workflow only after reading the
durable effect outcome.

Provider idempotency keys are bound to one request hash within a tenant and
provider origin. Exact retries return the existing effect; reuse for a
different target path, payload, workflow, decision, policy, or budget is
rejected before additional budget can be reserved.

## Causal lineage

`add_lineage` accepts these endpoint types:

```text
artifact
assertion
workflow_revision
effect
```

Relations are:

```text
evidence_for
supports
contradicts
governs
authorizes
produces
verifies
```

Endpoints are tenant-scoped and FK validated. `authorizes` requires a decision,
`governs` requires a directive, and `verifies` targets an observation.
Creating an assertion with a source artifact automatically records
`evidence_for`. Generic effect creation automatically records decision,
policy, and workflow-revision links.

## Explain

`explain` accepts an artifact, assertion, workflow revision, or effect target
and a maximum depth from 0 through 8. It returns typed nodes, explicit lineage
edges, sanitized records, and a `truncated` flag. Artifact plaintext is never
included. See [Explain and Trace](EXPLAIN.md).

## Typed values

```text
string
number with optional unit
boolean
timestamp
entity reference
JSON
```

Example:

```json
{
  "type": "number",
  "value": 4.8,
  "unit": "kg"
}
```

## Epistemic kinds

```text
observation
reported_fact
inference
prediction
hypothesis
decision
directive
experience
```

Kinds identify how a value entered the system. They do not grant authority.

## Strength types

| Type | Meaning |
| --- | --- |
| `none` | No confidence semantics supplied |
| `rank` | Preferred, normal, or deprecated |
| `probability` | Calibrated probability with optional definition |
| `interval` | Numeric uncertainty interval |
| `evidence_count` | Supporting and considered evidence counts |

Retrieval similarity is returned separately and is never treated as
probability.

## Resolution

Policies:

- `none`
- `latest`
- `highest_authority`

Statuses:

- `known`
- `unknown`
- `conflicted`
- `resolved_with_conflict`

`resolved_with_conflict` preserves the non-selected candidates.

## Search

Search can combine:

- text;
- vector similarity;
- predicate and epistemic-kind filters;
- perspective;
- valid time and system time;
- a related entity and maximum graph depth.

The PostgreSQL profile stores provider vectors in pgvector. The development
profile uses deterministic feature vectors for local behavior only.

The PostgreSQL profile retrieves bounded vector and lexical candidate sets
through HNSW and full-text indexes before calculating final combined scores.
Temporal, status, tenant, optional field, and graph constraints remain inside
candidate selection so bounded retrieval does not reintroduce stale or
out-of-scope rows.

## Retail compatibility workflow

Retail operations remain supported behind the compatibility adapter while the
generic Agency layer stays independent of retail order invariants.

```text
new -> reserved -> payment_pending -> confirmed
                 \-> failed
reserved -> cancelled
```

`reserve_inventory` requires:

```json
{
  "op": "reserve_inventory",
  "orderId": "1001",
  "sku": "camera-1",
  "location": "store-1",
  "quantity": 1,
  "holdSeconds": 600,
  "idempotencyKey": "reserve-1001"
}
```

`request_payment` uses an exact decimal string:

```json
{
  "op": "request_payment",
  "instanceId": "order:1001",
  "amount": "149.98",
  "currency": "USD",
  "paymentTarget": "https://payments.example.com/capture",
  "paymentStatusUrl": "https://payments.example.com/status/payment-1001",
  "idempotencyKey": "payment-1001"
}
```

## HTTP

Production requests require:

```text
Authorization: Bearer <token>
X-Agent-Purpose: <approved-purpose>
Content-Type: application/json
```

Routes:

```text
GET  /health/live
GET  /health/ready
GET  /metrics
GET  /v1/catalog
POST /v1/execute
POST /mcp
```

The production API does not expose SQL. `/mcp` is disabled by default and
requires a Bearer API key plus `X-Agent-Purpose` on every protocol request.
Its default remote tool set is `search_knowledge`, `resolve_claims`,
`get_machine`, `list_effects`, and `explain_trace`. Enabling
`MCP_HTTP_WRITE_ENABLED` additionally exposes `execute_operation`; normal
scope, purpose, tenant, budget, and workflow checks still apply.

## Errors

| HTTP status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_input` | Schema, type, time, or value validation failed |
| `401` | `authentication_failed` | API key is missing or invalid |
| `403` | `authorization_failed` | Purpose or scope is not allowed |
| `403` | `unauthorized` | Operation-specific authority failed |
| `404` | `not_found` | Required entity, artifact, workflow, or route is absent |
| `409` | `conflict` | State, idempotency, inventory, or immutability conflict |
| `429` | `rate_limited` | Request rate exceeded |
| `503` | `maintenance` | Coordinated backup or restore paused writes |

Internal errors return a generic message and request ID.

## Versioning

The stable envelope version is `1.0`. Version `0.1` remains accepted throughout
the 1.x release line for existing alpha clients. New required fields or changed
operation semantics require a new protocol version. Additive optional fields
may remain within the current version when existing behavior is preserved.

See [Stability and Compatibility](STABILITY.md).
