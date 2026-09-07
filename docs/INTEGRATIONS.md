# Integrations

The repository includes runnable examples for the library, HTTP API, MCP,
Microsoft Agent Framework, Azure SRE Agent, embedding providers, effect
receivers, and the retail workflow.

## Install

Install the stable package:

```powershell
npm install agentic-data-kernel
```

Pin an exact version in applications and production deployments.

## Example index

| Integration | File | Command |
| --- | --- | --- |
| Embedded agent middleware | `examples/integrations/agent-middleware.ts` | `npm run example:agent` |
| Local TypeScript library | `examples/integrations/local-library.ts` | `npm run example:library` |
| MCP client | `examples/integrations/mcp-client.ts` | `npm run example:mcp` |
| Authenticated production HTTP | `examples/integrations/production-http.ts` | `npm run example:production-http` |
| Production HTTP agent middleware | `examples/integrations/production-agent-middleware.ts` | `npm run example:production-agent` |
| Microsoft Agent Framework | `examples/microsoft-agent-framework` | Python, stdio or Streamable HTTP MCP |
| Azure SRE Agent | `examples/azure-sre-agent` | Remote MCP connector and custom agent |
| Production retail workflow | `examples/integrations/production-retail.ts` | `npm run example:production-retail` |
| Flagship SRE scenario | `examples/integrations/sre-scenario.ts` | `npm run example:sre` |
| Embedding provider | `examples/integrations/embedding-provider.ts` | `npm run example:embedding` |
| Embedding protocol helper | `examples/integrations/mock-embedding-server.ts` | `npm run example:mock-embeddings` |
| Effect receiver contract | `examples/integrations/mock-effect-receiver.ts` | `npm run example:mock-effects` |

Build and type-check all TypeScript examples:

```powershell
npm run build
```

## Local TypeScript library

The local library example imports the package entry point, creates an embedded
SQLite store, writes two conflicting product assertions, and resolves them.

```powershell
npm run example:library
```

Core pattern:

```ts
import {
  AgenticKernel,
  SqliteStore,
  executeIntent,
} from "agentic-data-kernel";

const store = new SqliteStore(".data/app.db");
const kernel = new AgenticKernel(store);

const result = executeIntent(kernel, {
  protocolVersion: "1.0",
  requestId: "product-1",
  idempotencyKey: "product-1",
  principal: {
    tenantId: "catalog",
    principalId: "import-service",
    purpose: "catalog-import",
  },
  operation: {
    op: "put_entity",
    entity: {
      entityId: "product:1",
      entityType: "product",
      canonicalName: "Trail Camera",
    },
  },
});
```

The SQLite profile is intended for local and single-process use.

## Agent middleware

The embedded middleware example demonstrates the full host lifecycle:

1. bind a principal and begin an agent run;
2. expose framework-neutral JSON Schema tools;
3. compile bounded knowledge and resolution context;
4. execute model-style tool calls through Agent Intent;
5. store approved turn input, output, tool results, and receipt references.

```powershell
npm run example:agent
```

The production HTTP adapter uses the same lifecycle while binding the API key
outside model-visible arguments:

```powershell
npm run example:production-agent
```

See [Agent Middleware](AGENT_MIDDLEWARE.md) for the complete architecture,
security boundaries, and model-provider mapping.

## MCP client

An MCP client can launch the published embedded server directly:

```json
{
  "mcpServers": {
    "agentic-data": {
      "command": "npx",
      "args": [
        "--yes",
        "agentic-data-kernel@1.2.0",
        "mcp",
        "--db",
        ".data/agentic.db"
      ]
    }
  }
}
```

On Windows, clients that do not resolve command shims may require `npx.cmd`.
Pin an exact package version when reproducibility matters.

The MCP example starts the development MCP process over stdio, creates a
service entity, stores an ownership assertion, and resolves it through the
`resolve_claims` tool.

```powershell
npm run example:mcp
```

Use `npm run prod:mcp` when the client needs authenticated PostgreSQL-backed
state. The production MCP process binds one API key and purpose at startup, so
tools do not accept caller-supplied tenant or principal identities.

Production HTTP can also expose stateless Streamable HTTP MCP at `/mcp`.
Remote MCP is disabled and read-only by default. See
[Production Profile](PRODUCTION.md#remote-streamable-http-mcp).

## Microsoft agent integrations

- [Microsoft Agent Framework](../examples/microsoft-agent-framework) includes
  Python examples for local stdio MCP and authenticated production Streamable
  HTTP MCP.
- [Azure SRE Agent](../examples/azure-sre-agent) includes connector setup,
  selected read-only tools, a custom incident-context agent, and an optional
  reviewed write mode.

These are community integration examples rather than Microsoft-supported
product integrations.

## Authenticated production HTTP

Set:

```text
AGENTIC_DATA_BASE_URL=https://localhost:8443
AGENTIC_DATA_API_KEY=<token>
AGENTIC_DATA_TENANT_ID=<tenant>
AGENTIC_DATA_PRINCIPAL_ID=<principal>
AGENTIC_DATA_PURPOSE=<approved-purpose>
```

For the local Caddy profile, trust its internal CA or set `NODE_EXTRA_CA_CERTS`
to the exported root certificate.

Run:

```powershell
npm run example:production-http
```

The example reads the authenticated catalog, creates an entity, and prints only
the profile and receipt ID. It does not print the API token.

## Embedding providers

The PostgreSQL profile expects an OpenAI-compatible embeddings endpoint.

Set:

```text
EMBEDDING_BASE_URL=https://provider.example/v1
EMBEDDING_API_KEY=<provider-key>
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_VERSION=openai-compatible-v1
EMBEDDING_DIMENSIONS=1536
```

Run:

```powershell
npm run example:embedding
```

The example prints the model, vector dimensions, and finite-value check without
printing the vector.

`EMBEDDING_VERSION` identifies the semantic space independently of the provider
protocol. Change it when a provider changes model weights or preprocessing
without changing the model name.

Dimensions are configurable from 1 to 2000, matching pgvector's HNSW limit for
single-precision vectors. The model must actually return the configured number
of finite values. Zero vectors are rejected because cosine distance is
undefined for them.

### Development protocol helper

`mock-embedding-server.ts` implements the request and response shape with
deterministic feature vectors:

```powershell
npm run example:mock-embeddings
```

This helper validates integration plumbing. It is not a semantic embedding
model and must not be used as a production fallback.

## Effect receivers

An effect receiver must support:

### Delivery

```http
POST /capture
Idempotency-Key: payment-order-1001
X-Agentic-Effect-Id: effect_...
X-Agentic-Authorization-Fence: ...
Content-Type: application/json
```

Successful response:

```json
{
  "status": "succeeded",
  "providerReference": "provider-transaction-123"
}
```

The same idempotency key must return the same external result.

The contract applies to both retail payments and generic effects such as
deployment rollback. Generic requests carry the operation-specific JSON from
`request_effect`; receivers should not infer authority from that payload.
Authority remains in the kernel's key, purpose, policy binding, and
authorization fence.

### Status reconciliation

```http
GET /status/payment-order-1001
Idempotency-Key: payment-order-1001
X-Agentic-Effect-Id: effect_...
X-Agentic-Authorization-Fence: ...
```

Responses:

```json
{"status":"pending"}
```

```json
{
  "status": "succeeded",
  "providerReference": "provider-transaction-123"
}
```

```json
{"status":"failed"}
```

The included receiver example uses an in-memory result map. With no TLS
variables it binds to `http://127.0.0.1:8092` for local contract checks:

```powershell
npm run example:mock-effects
```

For staging, provide:

```text
TLS_CERT_PATH=<certificate>
TLS_KEY_PATH=<private-key>
PORT=8444
```

```powershell
npm run example:mock-effects
```

The production worker rejects private and reserved destination addresses.
Expose the receiver through an approved public or private service endpoint that
meets the deployment's network policy. Do not weaken the worker's address
checks to reach the local helper.

## Production retail workflow

The retail integration creates product and inventory state, reserves an item,
creates a payment effect, and waits for the worker to terminalize the order.

In addition to the production HTTP variables, set:

```text
PAYMENT_TARGET_URL=https://payments.example.com/capture
PAYMENT_STATUS_BASE_URL=https://payments.example.com
```

Run:

```powershell
npm run example:production-retail
```

The API key needs:

```text
data:read
data:write
inventory:admin
orders:write
effects:write
```

Its approved purpose must match `AGENTIC_DATA_PURPOSE`, and its effect budget
must cover `149.98` in `USD`.

## Flagship SRE scenario

The SRE scenario runs directly against the production PostgreSQL profile with
deterministic telemetry, embeddings, and remediation adapters:

```powershell
npm run example:sre
```

It creates a dedicated tenant, preserves contradictory hypotheses, selects a
remediation, simulates an applied rollback with a timed-out response, restarts
the runtime, reconciles provider state, and stores verification. Full setup and
expected output are in [SRE_SCENARIO.md](SRE_SCENARIO.md). Run it against a
dedicated empty database because it uses an explicitly synthetic embedding
space. The command also renders the effect-centered causal explanation.

## Custom effect transports

Applications can integrate an existing SDK instead of HTTP by implementing
`EffectTransport`:

```ts
import type {
  EffectTransport,
} from "agentic-data-kernel/production";

const transport: EffectTransport = {
  async deliver(effect) {
    // Call the provider with effect.idempotencyKey.
    return {
      status: "succeeded",
      responseStatus: 200,
      outcome: { providerReference: "provider-id" },
    };
  },
  async reconcile(effect) {
    // Read provider state by the same idempotency key.
    return {
      status: "unknown",
      responseStatus: 200,
      outcome: { status: "pending" },
    };
  },
};
```

The transport must preserve idempotency and return `unknown` when it cannot
prove whether the external side acted.

## Framework adapters

Agent frameworks should integrate at the operation boundary rather than bypass
the kernel:

1. map framework identity to one API key and approved purpose;
2. discover tools through MCP or the catalog endpoint;
3. submit typed operations;
4. preserve receipt IDs with task traces;
5. treat retrieved artifacts as data, not instructions;
6. let the effect worker own external side-effect retries.

This pattern applies to workflow engines, support assistants, coding tools,
operations agents, and custom orchestrators.
