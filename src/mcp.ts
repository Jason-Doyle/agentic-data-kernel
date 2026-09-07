import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { AgenticKernel } from "./kernel.js";
import {
  executeIntent,
  intentEnvelopeSchema,
  lineageEndpointSchema,
  type AgentOperation,
} from "./ir.js";
import {
  AGENT_INTENT_VERSION,
  PACKAGE_VERSION,
} from "./version.js";

const principalFields = {
  tenantId: z.string().trim().min(1),
  principalId: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
};

export function createMcpServer(kernel: AgenticKernel): McpServer {
  const server = new McpServer({
    name: "agentic-data-kernel",
    version: PACKAGE_VERSION,
  });

  server.registerResource(
    "agentic-data-catalog",
    "agentic-data://catalog",
    {
      title: "Agentic Data Kernel Catalog",
      description: "Supported operations, epistemic kinds, and guarantees",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(kernel.catalog(), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "execute_intent",
    {
      title: "Execute Agent Intent",
      description:
        "Validate and execute one Agent Intent operation with an execution receipt.",
      inputSchema: {
        envelope: intentEnvelopeSchema,
      },
    },
    async ({ envelope }) => toolResult(executeIntent(kernel, envelope)),
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search Knowledge",
      description:
        "Run hybrid lexical/vector retrieval with optional graph and epistemic filters.",
      inputSchema: {
        ...principalFields,
        text: z.string().trim().min(1),
        predicate: z.string().trim().min(1).optional(),
        kind: z
          .enum([
            "observation",
            "reported_fact",
            "inference",
            "prediction",
            "hypothesis",
            "decision",
            "directive",
            "experience",
          ])
          .optional(),
        relatedToEntityId: z.string().trim().min(1).optional(),
        maxGraphDepth: z.number().int().min(0).max(8).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      toolResult(
        kernel.search(args.tenantId, {
          text: args.text,
          predicate: args.predicate,
          kind: args.kind,
          relatedToEntityId: args.relatedToEntityId,
          maxGraphDepth: args.maxGraphDepth,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    "resolve_claims",
    {
      title: "Resolve Claims",
      description:
        "Return known, unknown, conflicted, or policy-resolved assertions.",
      inputSchema: {
        ...principalFields,
        subjectEntityId: z.string().trim().min(1),
        predicate: z.string().trim().min(1),
        policy: z
          .enum(["none", "latest", "highest_authority"])
          .default("none"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      toolResult(
        kernel.resolve(
          args.tenantId,
          args.subjectEntityId,
          args.predicate,
          args.policy,
        ),
      ),
  );

  server.registerTool(
    "explain_trace",
    {
      title: "Explain Durable Trace",
      description:
        "Traverse typed causal lineage around an artifact, assertion, workflow revision, or effect.",
      inputSchema: {
        ...principalFields,
        target: lineageEndpointSchema,
        maxDepth: z.number().int().min(0).max(8).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      toolResult(
        kernel.explain(
          args.tenantId,
          args.target,
          args.maxDepth,
        ),
      ),
  );

  server.registerTool(
    "reserve_inventory",
    {
      title: "Reserve Inventory",
      description:
        "Create an idempotent inventory reservation and durable retail-order state.",
      inputSchema: {
        ...principalFields,
        orderId: z.string().trim().min(1),
        sku: z.string().trim().min(1),
        location: z.string().trim().min(1),
        quantity: z.number().int().positive(),
        holdSeconds: z.number().int().positive().max(86_400),
        idempotencyKey: z.string().trim().min(1),
      },
    },
    async (args) =>
      toolResult(
        executeIntent(
          kernel,
          envelope(
            args,
            {
              op: "reserve_inventory",
              orderId: args.orderId,
              sku: args.sku,
              location: args.location,
              quantity: args.quantity,
              holdSeconds: args.holdSeconds,
              idempotencyKey: args.idempotencyKey,
            },
            args.idempotencyKey,
          ),
        ),
      ),
  );

  server.registerTool(
    "get_machine",
    {
      title: "Get Durable Machine",
      description: "Read the current state of a durable workflow instance.",
      inputSchema: {
        ...principalFields,
        instanceId: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      toolResult(
        kernel.getMachineRecord(args.tenantId, args.instanceId),
      ),
  );

  return server;
}

export async function startMcpServer(kernel: AgenticKernel): Promise<McpServer> {
  const server = createMcpServer(kernel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agentic Data Kernel MCP server running on stdio");
  return server;
}

function envelope(
  principal: {
    tenantId: string;
    principalId: string;
    purpose: string;
  },
  operation: AgentOperation,
  idempotencyKey?: string,
): object {
  return {
    protocolVersion: AGENT_INTENT_VERSION,
    requestId: randomUUID(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    principal: {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      purpose: principal.purpose,
    },
    operation,
  };
}

function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
