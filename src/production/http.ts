import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Logger } from "pino";
import { KernelError } from "../kernel.js";
import {
  AuthenticationError,
  AuthorizationError,
  authenticateToken,
  type AuthenticatedPrincipal,
} from "./auth.js";
import { productionCatalog } from "./catalog.js";
import {
  configuredEmbeddingSpace,
  type ProductionConfig,
} from "./config.js";
import {
  MaintenanceModeError,
  type ProductionDatabase,
} from "./database.js";
import type { ProductionKernel } from "./kernel.js";
import type { MetricsRegistry } from "./metrics.js";
import { embeddingSpaceStatus } from "./embedding-space.js";
import { assertRuntimeRoleSafe } from "./bootstrap.js";
import {
  assertProductionMcpHttpRequestAllowed,
  handleProductionMcpHttpRequest,
} from "./mcp-http.js";

export interface ProductionHttpDependencies {
  config: ProductionConfig;
  database: ProductionDatabase;
  kernel: ProductionKernel;
  metrics: MetricsRegistry;
  logger: Logger;
}

export function resolveClientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxyHops: number,
): string {
  const remote = remoteAddress ?? "unknown";
  if (trustedProxyHops <= 0) {
    return remote;
  }
  const value = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;
  if (!value) {
    return remote;
  }
  const addresses = value
    .split(",")
    .map((address) => address.trim())
    .filter((address) => isIP(address) !== 0);
  return addresses[addresses.length - trustedProxyHops] ?? remote;
}

export async function startProductionHttpServer({
  config,
  database,
  kernel,
  metrics,
  logger,
}: ProductionHttpDependencies): Promise<import("node:http").Server> {
  await assertRuntimeRoleSafe(database);
  const limiter = new FixedWindowRateLimiter(config.rateLimitPerMinute);
  const anonymousLimiter = new FixedWindowRateLimiter(
    Math.max(config.rateLimitPerMinute * 5, 1_000),
  );
  const server = createServer(
    {
      requestTimeout: 15_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16_384,
    },
    async (request, response) => {
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    const started = performance.now();
    setSecurityHeaders(response, requestId);
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${config.host}:${config.port}`,
      );
      if (request.method === "GET" && url.pathname === "/health/live") {
        sendJson(response, 200, { status: "ok", requestId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        const healthy = await database.health();
        const migration = await database.query<{ applied: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM agentic.schema_migrations
             WHERE version = '003'
           ) AS applied`,
        );
        const migrationsApplied = migration.rows[0]?.applied === true;
        const embeddingStatus = migrationsApplied
          ? await embeddingSpaceStatus(
              database,
              configuredEmbeddingSpace(config),
            )
          : null;
        const ready =
          healthy && migrationsApplied && embeddingStatus?.ready === true;
        sendJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          requestId,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        sendText(response, 200, metrics.render(), "text/plain; version=0.0.4");
        return;
      }

      const remoteAddress = resolveClientAddress(
        request.socket.remoteAddress,
        request.headers["x-forwarded-for"],
        config.trustedProxyHops,
      );
      if (!anonymousLimiter.consume(remoteAddress)) {
        response.setHeader("retry-after", "60");
        sendJson(response, 429, {
          error: { code: "rate_limited", message: "Rate limit exceeded" },
          requestId,
        });
        return;
      }
      const remoteMcpRequest =
        config.mcpHttpEnabled === true && url.pathname === "/mcp";
      if (remoteMcpRequest) {
        if (!config.mcpHttpPublicOrigin) {
          throw new Error(
            "Remote MCP is enabled without a public origin",
          );
        }
        assertProductionMcpHttpRequestAllowed(
          request,
          config.mcpHttpPublicOrigin,
        );
      }

      const principal = await authenticateRequest(
        request,
        database,
        config,
      );
      if (!limiter.consume(principal.keyId)) {
        response.setHeader("retry-after", "60");
        sendJson(response, 429, {
          error: { code: "rate_limited", message: "Rate limit exceeded" },
          requestId,
          },
        );
        return;
      }

      if (remoteMcpRequest) {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          sendJson(response, 405, {
            jsonrpc: "2.0",
            error: {
              code: -32_000,
              message: "Method not allowed.",
            },
            id: null,
          });
          return;
        }
        if (request.method === "POST") {
          requireJsonContentType(request);
        }
        const body = await readJsonBody(request, config.maxBodyBytes);
        if (Array.isArray(body)) {
          sendJson(response, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32_600,
              message: "JSON-RPC batches are not supported.",
            },
            id: null,
          });
          return;
        }
        await handleProductionMcpHttpRequest(
          request,
          response,
          body,
          kernel,
          principal,
          config.mcpHttpWriteEnabled === true,
          logger,
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        sendJson(
          response,
          200,
          productionCatalog(configuredEmbeddingSpace(config)),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/execute") {
        requireJsonContentType(request);
        const body = await readJsonBody(request, config.maxBodyBytes);
        const execution = await kernel.execute(principal, body);
        sendJson(response, 200, execution);
        return;
      }
      sendJson(response, 404, {
        error: { code: "not_found", message: "Route not found" },
        requestId,
      });
    } catch (error) {
      const mapped = mapError(error);
      metrics.increment("agentic_http_errors_total", {
        code: mapped.code,
      });
      logger.warn(
        {
          requestId,
          code: mapped.code,
          status: mapped.status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Request failed",
      );
      sendJson(response, mapped.status, {
        error: { code: mapped.code, message: mapped.message },
        requestId,
      });
    } finally {
      metrics.observe(
        "agentic_http_duration_ms",
        performance.now() - started,
        {
          method:
            request.method === "GET" || request.method === "POST"
              ? request.method
              : "OTHER",
        },
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function authenticateRequest(
  request: IncomingMessage,
  database: ProductionDatabase,
  config: ProductionConfig,
): Promise<AuthenticatedPrincipal> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AuthenticationError("A Bearer API key is required");
  }
  const purpose = request.headers["x-agent-purpose"]?.toString().trim();
  if (!purpose || purpose.length > 128) {
    throw new AuthorizationError("A valid X-Agent-Purpose header is required");
  }
  return authenticateToken(
    database,
    config,
    header.slice("Bearer ".length),
    purpose,
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new KernelError("invalid_input", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new KernelError("invalid_input", "A JSON body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new KernelError("invalid_input", "Request body is not valid JSON");
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new KernelError(
      "invalid_input",
      "Content-Type must be application/json",
    );
  }
}

function setSecurityHeaders(
  response: ServerResponse,
  requestId: string,
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-request-id", requestId);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  sendText(
    response,
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8",
  );
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function mapError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof AuthenticationError) {
    return { status: 401, code: "authentication_failed", message: error.message };
  }
  if (error instanceof AuthorizationError) {
    return { status: 403, code: "authorization_failed", message: error.message };
  }
  if (error instanceof MaintenanceModeError) {
    return {
      status: 503,
      code: "maintenance",
      message: "Writes are temporarily paused for maintenance",
    };
  }
  if (error instanceof KernelError) {
    switch (error.code) {
      case "invalid_input":
      case "unsafe_query":
        return { status: 400, code: error.code, message: error.message };
      case "not_found":
        return { status: 404, code: error.code, message: error.message };
      case "conflict":
        return { status: 409, code: error.code, message: error.message };
      case "unauthorized":
        return { status: 403, code: error.code, message: error.message };
    }
  }
  return {
    status: 500,
    code: "internal_error",
    message: "The request could not be completed",
  };
}

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { minute: number; count: number }>();

  public constructor(private readonly limit: number) {}

  public consume(key: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const existing = this.windows.get(key);
    if (!existing || existing.minute !== minute) {
      this.windows.set(key, { minute, count: 1 });
      this.prune(minute);
      return true;
    }
    if (existing.count >= this.limit) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  private prune(currentMinute: number): void {
    if (this.windows.size < 10_000) {
      return;
    }
    for (const [key, value] of this.windows) {
      if (value.minute < currentMinute - 1) {
        this.windows.delete(key);
      }
    }
  }
}
