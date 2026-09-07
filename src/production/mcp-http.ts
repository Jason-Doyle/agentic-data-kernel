import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import {
  AuthorizationError,
  type AuthenticatedPrincipal,
} from "./auth.js";
import type { ProductionKernel } from "./kernel.js";
import { createProductionMcpServer } from "./mcp.js";

export function assertProductionMcpHttpRequestAllowed(
  request: IncomingMessage,
  publicOrigin: string,
): void {
  const expected = new URL(publicOrigin);
  const host = request.headers.host?.trim().toLowerCase();
  if (!host || host !== expected.host.toLowerCase()) {
    throw new AuthorizationError(
      "Remote MCP Host header is not allowed",
    );
  }
  const origin = request.headers.origin;
  if (origin) {
    let suppliedOrigin: string;
    try {
      suppliedOrigin = new URL(origin).origin;
    } catch {
      throw new AuthorizationError(
        "Remote MCP Origin header is invalid",
      );
    }
    if (suppliedOrigin !== expected.origin) {
      throw new AuthorizationError(
        "Remote MCP Origin header is not allowed",
      );
    }
  }
}

export async function handleProductionMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  includeExecuteOperation: boolean,
  logger: Logger,
): Promise<void> {
  const server = createProductionMcpServer(kernel, principal, {
    includeExecuteOperation,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= server.close().catch((error: unknown) => {
      logger.warn(
        {
          error:
            error instanceof Error ? error.message : "Unknown MCP close error",
        },
        "Remote MCP request cleanup failed",
      );
    });
    return closing;
  };
  response.once("finish", () => {
    void close();
  });
  response.once("close", () => {
    void close();
  });
  transport.onerror = (error) => {
    logger.warn(
      { error: error.message },
      "Remote MCP transport reported an error",
    );
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    await close();
    throw error;
  }
}
