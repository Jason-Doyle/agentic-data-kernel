# Agent Middleware

Agentic Data Kernel can sit between an agent host and its model as a durable
knowledge, workflow, and effect middleware.

```text
user, event, or scheduler
          |
          v
agent host / orchestration loop
  |                     |
  | model request       | Agent Intent 1.0
  v                     v
language model     Agentic Data Middleware
                         |
                         +-- context compilation
                         +-- model-visible semantic tools
                         +-- bound tenant, principal, and purpose
                         +-- idempotent operation execution
                         +-- durable turn artifacts and receipts
                         |
                         v
                 Agentic Data Kernel
                   |           |
                   v           v
              PostgreSQL   effect worker
                               |
                               v
                         external systems
```

The model reasons. The host owns the model loop. The middleware prepares
bounded context and translates model tool calls into authenticated Agent
Intent operations. The kernel owns durable state, invariants, receipts, and
external-effect recovery.

## Choose an integration mode

| Mode | Use when |
| --- | --- |
| Direct MCP | The model host already supports MCP and only needs kernel tools over stdio or HTTPS |
| Embedded middleware | A local or single-process agent uses the SQLite profile |
| In-process production middleware | The agent runs beside a configured `ProductionKernel` |
| HTTP production middleware | The agent host calls a separately deployed production API |

Direct MCP is the smallest integration. The middleware API adds lifecycle
features around the same Agent Intent operations:

- a host-bound identity that model arguments cannot replace;
- standard JSON Schema tool definitions;
- context compilation before a model call;
- idempotent tool-call dispatch;
- durable recording of approved turn content.

## Embedded agent

```ts
import {
  AgenticKernel,
  SqliteStore,
  createEmbeddedAgentMiddleware,
} from "agentic-data-kernel";

const store = new SqliteStore(".data/agent.db");
const kernel = new AgenticKernel(store);

const middleware = createEmbeddedAgentMiddleware(kernel, {
  tenantId: "operations",
  principalId: "incident-agent",
  purpose: "incident-response",
});

const session = middleware.beginRun({
  runId: "run:checkout-1001",
  taskId: "incident:checkout-1001",
  conversationId: "conversation:checkout-1001",
});
```

`beginRun` binds host metadata to one middleware session. It does not create a
workflow automatically. When the task needs durable state transitions, the
agent creates a workflow explicitly through `execute_operation`.
The host can read the bound run metadata with `session.runInfo()`.
Run, task, conversation, turn, call, request, and middleware idempotency
identifiers reject control characters and are bounded in length.

Run the complete embedded example:

```powershell
npm run build
npm run example:agent
```

## Prepare a model request

```ts
const modelInput = await session.prepareModelInput({
  query: "why is checkout failing?",
  resolutions: [
    {
      subjectEntityId: "service:checkout",
      predicate: "primary_cause",
      policy: "highest_authority",
    },
  ],
  workflow: {
    instanceId: "incident:checkout-1001",
  },
  effects: {
    instanceId: "incident:checkout-1001",
    limit: 10,
  },
  traces: [
    {
      target: {
        type: "workflow_revision",
        instanceId: "incident:checkout-1001",
        revision: 3,
      },
      maxDepth: 4,
    },
  ],
  maxCharacters: 24_000,
});
```

The result contains:

```ts
modelInput.context.modelContext;      // bounded JSON text for the model
modelInput.context.sections;          // complete structured host-side results
modelInput.context.includedReceiptIds; // complete evidence shown to the model
modelInput.context.partialReceiptIds;  // evidence shown only as a preview
modelInput.context.omittedReceiptIds;  // fetched but omitted from model context
modelInput.context.truncated;         // whether modelContext was clipped
modelInput.tools;                     // framework-neutral JSON Schema tools
```

Context compilation executes ordinary read operations. It therefore preserves
tenant isolation, temporal semantics, conflict results, and durable receipts.
The defaults cap search and effect results at 10 and model context at 24,000
characters. Per-call context can be capped from 1,000 through 100,000
characters.

When structured context exceeds the model limit, the host still receives the
complete `sections` array. `modelContext` retains every section header and
receipt ID, gives sections a `complete`, `truncated`, or `omitted` status, and
allocates bounded previews before using remaining space for complete results.
If section metadata alone cannot fit, context compilation fails explicitly
instead of silently dropping provenance.

## Give the tools to a model

`modelTools()` returns these semantic tools:

```text
search_knowledge
resolve_claims
get_machine
list_effects
explain_trace
execute_operation
```

Each definition contains:

```ts
{
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}
```

For a provider using function-style tools, adapt them without changing their
schemas:

```ts
const tools = session.modelTools().map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}));
```

The middleware does not depend on a model vendor or agent framework. The host
can map these definitions into any provider's equivalent tool format.

## Execute model tool calls

```ts
const toolResult = await session.invokeTool({
  callId: modelToolCall.id,
  name: modelToolCall.name,
  arguments: modelToolCall.arguments,
});

modelToolCall.respond(toolResult.modelContent);
```

`callId` becomes part of the envelope idempotency identity. Replaying the same
call with the same arguments returns the original durable result and receipt.
Reusing it for different content is rejected.

Tool calls, direct host operations, and turn records use separate hashed
idempotency namespaces. A model-supplied logical key cannot collide with
middleware-owned turn persistence.

The host-bound principal is inserted into the Agent Intent envelope by the
middleware. Model arguments never include:

```text
tenantId
principalId
purpose
API key
```

`execute_operation` accepts one typed Agent Intent operation and an optional
logical idempotency key. By default, model-visible operations include entity and assertion writes,
knowledge reads, generic workflows, controlled effects, retail reservation
and payment requests, machine reads, and effect reads.

Administrative or provider-owned operations are excluded by default:

```text
put_artifact
seed_inventory
record_effect_outcome
record_payment_outcome
process_timers
```

Raw artifact writes remain host-owned so a model cannot forge middleware turn
artifacts. The host can call `session.execute(...)` for controlled evidence
ingestion, while `recordTurn(...)` uses the internal artifact path.

Applications can only narrow the model surface further:

```ts
const middleware = createEmbeddedAgentMiddleware(kernel, principal, {
  allowedOperations: [
    "search",
    "resolve",
    "get_machine",
    "list_effects",
    "explain",
  ],
});
```

The tool catalog removes semantic tools whose underlying operation is not
allowed. Attempts to add operations outside the safe model allowlist fail
during middleware construction. The kernel still performs its normal
authorization and state checks.

`session.execute(...)` is a host API and is not included in model tool
arguments. It can be used for trusted ingestion and administration when the
bound principal has the required authority.

## Record an approved turn

After the host decides which content should be durable:

```ts
const recorded = await session.recordTurn({
  turnId: "turn-7",
  input: {
    role: "user",
    content: "Investigate the checkout regression",
  },
  output: {
    role: "assistant",
    content: "The latest deployment is the selected hypothesis.",
  },
  contextReceiptIds: modelInput.context.includedReceiptIds,
  toolCalls: [
    {
      name: "resolve_claims",
      arguments: {
        subjectEntityId: "service:checkout",
        predicate: "primary_cause",
      },
      result: selectedCause,
      receiptId: resolutionReceiptId,
    },
  ],
  metadata: {
    model: "configured-by-host",
  },
});
```

The turn is stored as an immutable
`application/vnd.agentic-data.agent-turn+json` artifact with a deterministic
identifier:

```text
agent-turn:<hash of tenant, principal, run, and turn>
```

Exact retries replay idempotently. Different content under the same run and
turn is rejected. Including principal identity prevents independent agents in
one tenant from colliding on the same run and turn labels.

Turn content defaults to a 1,000,000-character limit and can be configured from
1,000 through 10,000,000 characters with `maxTurnCharacters`.

Do not persist hidden chain-of-thought, credentials, or unreviewed sensitive
provider payloads. `recordTurn` stores only the JSON explicitly supplied by the
host. Use `sensitivity` and `retentionPolicy` to apply deployment-specific
handling.

`beginRun({ metadata })` is transient host state and is not persisted.
Use `beginRun({ durableMetadata })` only for run metadata that should be copied
into every recorded turn.

Turn artifacts are an audit record, not an automatic conversational-memory
feed. The host continues to manage its recent message window. Facts that
should influence future retrieval must be promoted deliberately into typed
assertions, with source artifacts and lineage when applicable. This prevents
every model utterance from silently becoming trusted long-term memory.

## Production in-process adapter

An agent running in the same process as the production kernel uses an already
authenticated principal:

```ts
import {
  createProductionAgentMiddleware,
} from "agentic-data-kernel/production";

const middleware = createProductionAgentMiddleware(
  runtime.kernel,
  authenticatedPrincipal,
  {
    allowedOperations: [
      "search",
      "resolve",
      "assert",
      "create_workflow",
      "advance_workflow",
      "request_effect",
      "get_machine",
      "list_effects",
      "explain",
    ],
  },
);
```

Every operation revalidates the API key, tenant status, expiry, purpose, and
scope through `ProductionKernel`. The model cannot replace the authenticated
principal.

## Production HTTP adapter

An external agent host can use the deployed API without implementing Agent
Intent envelopes itself:

```ts
import {
  createProductionHttpAgentMiddleware,
} from "agentic-data-kernel/production";

const middleware = createProductionHttpAgentMiddleware({
  baseUrl: "https://agent-data.example.com",
  apiKey: process.env.AGENTIC_DATA_API_KEY!,
  principal: {
    tenantId: "operations",
    principalId: "incident-agent",
    purpose: "incident-response",
  },
});

const session = middleware.beginRun({
  runId: "run:checkout-1001",
});
```

The adapter sends the API key only in the HTTP authorization header and sends
the purpose in `X-Agent-Purpose`. It rejects plaintext non-loopback HTTP and
redirects. Responses are streamed through a byte limit, requests have a
deadline, and successful responses must match the requested protocol,
operation, principal, result hash, and receipt. Production TLS and CA trust
follow the host's Fetch API configuration.

HTTP controls:

```ts
createProductionHttpAgentMiddleware({
  // ...
  requestTimeoutMs: 30_000,
  maxResponseBytes: 10_000_000,
});
```

Run the production example after configuring the normal production
environment:

```powershell
npm run example:production-agent
```

Optional environment variables:

```text
AGENTIC_DATA_QUERY
AGENTIC_DATA_RUN_ID
AGENTIC_DATA_TASK_ID
AGENTIC_DATA_CONVERSATION_ID
AGENTIC_DATA_INSTANCE_ID
```

## Direct MCP

If the model host already supports MCP, it can use the embedded or production
stdio process, or the optional production Streamable HTTP endpoint at `/mcp`.
MCP is the model-visible transport; the middleware API is the host-side
lifecycle layer.

Use direct MCP when the host already handles context assembly and durable turn
recording. Use the middleware when those behaviors should be consistent across
model vendors and agent frameworks.

See the runnable
[Microsoft Agent Framework](../examples/microsoft-agent-framework) and
[Azure SRE Agent](../examples/azure-sre-agent) examples.

## External effects

The agent must not treat an ordinary model tool call as proof that an external
operation completed.

For high-impact actions:

1. the model requests `request_effect` or `request_payment`;
2. the kernel commits the authorized effect intent and receipt;
3. the effect worker performs the external call;
4. an ambiguous outcome becomes `unknown` or `reconciling`;
5. a later agent turn reads `list_effects`;
6. the worker reconciles provider state using the original idempotency key;
7. the agent advances its workflow only after reading the durable outcome.

This keeps provider retries, process restarts, and model retries from creating
duplicate external actions.

## Host responsibilities

The middleware intentionally does not:

- invoke a language model;
- decide which model provider to use;
- persist hidden model reasoning;
- automatically trust model-generated assertions;
- define an application's workflow transition policy;
- schedule tenant timer sweeps;
- run effect workers;
- replace edge rate limiting or secret management.

The host owns the model loop and decides which generated content becomes
durable. Agentic Data Kernel supplies the stateful, constrained, explainable
data plane beneath that loop.
