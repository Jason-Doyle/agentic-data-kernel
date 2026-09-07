import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  agentOperationSchema,
  lineageEndpointSchema,
} from "../ir.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { productionCatalog } from "./catalog.js";
import type { ProductionKernel } from "./kernel.js";
import {
  AGENT_INTENT_VERSION,
  PACKAGE_VERSION,
} from "../version.js";

export interface ProductionMcpServerOptions {
  includeExecuteOperation?: boolean;
}

export function createProductionMcpServer(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  options: ProductionMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "agentic-data-kernel-production",
    version: PACKAGE_VERSION,
  });
  server.registerResource(
    "agentic-data-production-catalog",
    "agentic-data://production/catalog",
    {
      title: "Agentic Data Production Catalog",
      description: "Authenticated production operations and guarantees",
      mimeType: "application/json",
    },
    async (uri) => {
      await kernel.revalidatePrincipal(principal);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              productionCatalog(kernel.embeddingSpace()),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  if (options.includeExecuteOperation !== false) {
    server.registerTool(
      "execute_operation",
      {
        title: "Execute Authenticated Operation",
        description:
          "Execute one operation as the API key principal and receive a durable receipt.",
        inputSchema: {
          operation: agentOperationSchema,
          idempotencyKey: z.string().trim().min(1).optional(),
        },
      },
      async ({ operation, idempotencyKey }) =>
        toolResult(
          await kernel.execute(principal, {
            protocolVersion: AGENT_INTENT_VERSION,
            requestId: randomUUID(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            principal: {
              tenantId: principal.tenantId,
              principalId: principal.principalId,
              purpose: principal.purpose,
            },
            operation,
          }),
        ),
    );
  }
  server.registerTool(
    "search_knowledge",
    {
      title: "Search Knowledge",
      description: "Run an authenticated read-only hybrid search.",
      inputSchema: {
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
    async (operation) =>
      toolResult(
        await kernel.searchReadOnly(principal, {
          op: "search",
          ...operation,
        }),
      ),
  );
  server.registerTool(
    "resolve_claims",
    {
      title: "Resolve Claims",
      description: "Read known, unknown, or conflicting assertions.",
      inputSchema: {
        subjectEntityId: z.string().trim().min(1),
        predicate: z.string().trim().min(1),
        policy: z
          .enum(["none", "latest", "highest_authority"])
          .default("none"),
      },
      annotations: { readOnlyHint: true },
    },
    async (operation) =>
      toolResult(
        await kernel.resolveReadOnly(principal, {
          op: "resolve",
          ...operation,
        }),
      ),
  );
  server.registerTool(
    "explain_trace",
    {
      title: "Explain Durable Trace",
      description:
        "Traverse authenticated causal lineage around a durable record.",
      inputSchema: {
        target: lineageEndpointSchema,
        maxDepth: z.number().int().min(0).max(8).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, maxDepth }) =>
      toolResult(
        await kernel.explainReadOnly(
          principal,
          target,
          maxDepth,
        ),
      ),
  );

  server.registerTool(
    "get_machine",
    {
      title: "Get Durable Machine",
      description: "Read an authenticated workflow instance.",
      inputSchema: {
        instanceId: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId }) =>
      toolResult(await kernel.getMachineReadOnly(principal, instanceId)),
  );
  server.registerTool(
    "list_effects",
    {
      title: "List Durable Effects",
      description:
        "Read authenticated effect state with bounded cursor pagination.",
      inputSchema: {
        instanceId: z.string().trim().min(1).optional(),
        afterEffectId: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId, afterEffectId, limit }) =>
      toolResult(
        await kernel.listEffectsReadOnly(principal, {
          op: "list_effects",
          ...(instanceId ? { instanceId } : {}),
          ...(afterEffectId ? { afterEffectId } : {}),
          limit: limit ?? 100,
        }),
      ),
  );
  return server;
}

export async function startProductionMcpServer(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
): Promise<McpServer> {
  await kernel.assertRuntimeRoleSafe();
  const server = createProductionMcpServer(kernel, principal);
  await server.connect(new StdioServerTransport());
  console.error("Authenticated Agentic Data MCP server running on stdio");
  return server;
}

function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
