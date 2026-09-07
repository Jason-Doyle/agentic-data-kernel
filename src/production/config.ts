import * as z from "zod/v4";
import { isIP } from "node:net";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_VERSION,
  MAX_INDEXED_VECTOR_DIMENSIONS,
  type EmbeddingSpace,
} from "./embeddings.js";

const optionalEnvironmentValue = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z.string().min(1).optional(),
);
const optionalUrlEnvironmentValue = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z.string().url().optional(),
);

const baseSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(["disable", "require"]),
  DATABASE_CA_CERT_BASE64: optionalEnvironmentValue,
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(30_000),
});

const serverObjectSchema = baseSchema.extend({
  AUTH_PEPPER: z.string().min(32),
  ARTIFACT_KEYRING: z.string().min(1),
  ARTIFACT_CURRENT_KEY_ID: z.string().trim().min(1),
  ARTIFACT_DIR: z.string().trim().min(1).default(".data/artifacts"),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_EMBEDDING_MODEL),
  EMBEDDING_VERSION: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_EMBEDDING_VERSION),
  EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INDEXED_VECTOR_DIMENSIONS)
    .default(DEFAULT_EMBEDDING_DIMENSIONS),
  EMBEDDING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  SEARCH_CANDIDATE_LIMIT: z.coerce
    .number()
    .int()
    .min(20)
    .max(5_000)
    .default(200),
  HNSW_EF_SEARCH: z.coerce.number().int().min(1).max(1_000).default(100),
  HNSW_MAX_SCAN_TUPLES: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(20_000),
  EFFECT_ALLOWED_HOSTS: z.string().default(""),
  EFFECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  EFFECT_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30),
  EFFECT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4318),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_000_000)
    .default(1_000_000),
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(600),
  TRUSTED_PROXY_HOPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(5)
    .default(0),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  WORKER_MONITOR_HOST: z.string().trim().min(1).default("127.0.0.1"),
  WORKER_MONITOR_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(4319),
  MCP_HTTP_ENABLED: z.stringbool().default(false),
  MCP_HTTP_PUBLIC_ORIGIN: optionalUrlEnvironmentValue,
  MCP_HTTP_WRITE_ENABLED: z.stringbool().default(false),
});
const serverSchema = serverObjectSchema.superRefine((value, context) => {
  if (
    value.EFFECT_LEASE_SECONDS * 1_000 <
    value.EFFECT_TIMEOUT_MS + 5_000
  ) {
    context.addIssue({
      code: "custom",
      path: ["EFFECT_LEASE_SECONDS"],
      message:
        "EFFECT_LEASE_SECONDS must exceed EFFECT_TIMEOUT_MS by at least 5 seconds",
    });
  }
  if (value.MCP_HTTP_ENABLED && !value.MCP_HTTP_PUBLIC_ORIGIN) {
    context.addIssue({
      code: "custom",
      path: ["MCP_HTTP_PUBLIC_ORIGIN"],
      message:
        "MCP_HTTP_PUBLIC_ORIGIN is required when MCP_HTTP_ENABLED is true",
    });
  }
  if (!value.MCP_HTTP_ENABLED && value.MCP_HTTP_WRITE_ENABLED) {
    context.addIssue({
      code: "custom",
      path: ["MCP_HTTP_WRITE_ENABLED"],
      message:
        "MCP_HTTP_WRITE_ENABLED requires MCP_HTTP_ENABLED",
    });
  }
  if (value.MCP_HTTP_PUBLIC_ORIGIN) {
    const origin = new URL(value.MCP_HTTP_PUBLIC_ORIGIN);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      (origin.pathname !== "" && origin.pathname !== "/")
    ) {
      context.addIssue({
        code: "custom",
        path: ["MCP_HTTP_PUBLIC_ORIGIN"],
        message:
          "MCP_HTTP_PUBLIC_ORIGIN must contain only scheme, host, and optional port",
      });
    }
    if (
      origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["MCP_HTTP_PUBLIC_ORIGIN"],
        message:
          "MCP_HTTP_PUBLIC_ORIGIN must use HTTPS except for loopback development",
      });
    }
  }
});

export interface DatabaseConfig {
  databaseUrl: string;
  databaseSsl: boolean;
  databaseCaCertificate?: string;
  databasePoolSize: number;
  statementTimeoutMs: number;
}

export interface ArtifactKeyringConfig {
  currentKeyId: string;
  keys: Map<string, Buffer>;
}

export interface ProductionConfig extends DatabaseConfig {
  authPepper: string;
  artifactDirectory: string;
  artifactKeyring: ArtifactKeyringConfig;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  embeddingTimeoutMs: number;
  searchCandidateLimit: number;
  hnswEfSearch: number;
  hnswMaxScanTuples: number;
  effectAllowedHosts: Set<string>;
  effectTimeoutMs: number;
  effectLeaseSeconds: number;
  effectMaxAttempts: number;
  host: string;
  port: number;
  logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  trustedProxyHops: number;
  shutdownTimeoutMs: number;
  workerMonitorHost: string;
  workerMonitorPort: number;
  mcpHttpEnabled?: boolean;
  mcpHttpPublicOrigin?: string;
  mcpHttpWriteEnabled?: boolean;
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const parsed = parse(baseSchema, environment);
  const databaseCaCertificate = parseDatabaseCaCertificate(
    parsed.DATABASE_CA_CERT_BASE64,
  );
  return {
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === "require",
    ...(databaseCaCertificate ? { databaseCaCertificate } : {}),
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    statementTimeoutMs: parsed.DATABASE_STATEMENT_TIMEOUT_MS,
  };
}

export function loadMigrationDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return loadDatabaseConfig({
    ...environment,
    DATABASE_URL:
      environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL,
  });
}

export function loadEmbeddingSpaceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingSpace {
  const parsed = parse(
    z.object({
      EMBEDDING_MODEL: serverObjectSchema.shape.EMBEDDING_MODEL,
      EMBEDDING_VERSION: serverObjectSchema.shape.EMBEDDING_VERSION,
      EMBEDDING_DIMENSIONS: serverObjectSchema.shape.EMBEDDING_DIMENSIONS,
    }),
    environment,
  );
  return {
    model: parsed.EMBEDDING_MODEL,
    version: parsed.EMBEDDING_VERSION,
    dimensions: parsed.EMBEDDING_DIMENSIONS,
  };
}

export function loadProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
  const parsed = parse(serverSchema, environment);

  const artifactKeyring = parseArtifactKeyring(
    parsed.ARTIFACT_KEYRING,
    parsed.ARTIFACT_CURRENT_KEY_ID,
  );
  const effectAllowedHosts = new Set(
    parsed.EFFECT_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  const databaseCaCertificate = parseDatabaseCaCertificate(
    parsed.DATABASE_CA_CERT_BASE64,
  );

  return {
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === "require",
    ...(databaseCaCertificate ? { databaseCaCertificate } : {}),
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    statementTimeoutMs: parsed.DATABASE_STATEMENT_TIMEOUT_MS,
    authPepper: parsed.AUTH_PEPPER,
    artifactDirectory: parsed.ARTIFACT_DIR,
    artifactKeyring,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingVersion: parsed.EMBEDDING_VERSION,
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    embeddingTimeoutMs: parsed.EMBEDDING_TIMEOUT_MS,
    searchCandidateLimit: parsed.SEARCH_CANDIDATE_LIMIT,
    hnswEfSearch: parsed.HNSW_EF_SEARCH,
    hnswMaxScanTuples: parsed.HNSW_MAX_SCAN_TUPLES,
    effectAllowedHosts,
    effectTimeoutMs: parsed.EFFECT_TIMEOUT_MS,
    effectLeaseSeconds: parsed.EFFECT_LEASE_SECONDS,
    effectMaxAttempts: parsed.EFFECT_MAX_ATTEMPTS,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    maxBodyBytes: parsed.MAX_BODY_BYTES,
    rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
    trustedProxyHops: parsed.TRUSTED_PROXY_HOPS,
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
    workerMonitorHost: parsed.WORKER_MONITOR_HOST,
    workerMonitorPort: parsed.WORKER_MONITOR_PORT,
    mcpHttpEnabled: parsed.MCP_HTTP_ENABLED,
    ...(parsed.MCP_HTTP_PUBLIC_ORIGIN
      ? {
          mcpHttpPublicOrigin: new URL(
            parsed.MCP_HTTP_PUBLIC_ORIGIN,
          ).origin,
        }
      : {}),
    mcpHttpWriteEnabled: parsed.MCP_HTTP_WRITE_ENABLED,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return (
    isIP(normalized) === 4 &&
    normalized.split(".")[0] === "127"
  );
}

function parseDatabaseCaCertificate(
  encoded: string | undefined,
): string | undefined {
  if (!encoded) {
    return undefined;
  }
  const certificate = Buffer.from(encoded, "base64").toString("utf8");
  if (
    !certificate.includes("-----BEGIN CERTIFICATE-----") ||
    !certificate.includes("-----END CERTIFICATE-----")
  ) {
    throw new Error(
      "DATABASE_CA_CERT_BASE64 must decode to a PEM certificate bundle",
    );
  }
  return certificate;
}

export function configuredEmbeddingSpace(
  config: Pick<
    ProductionConfig,
    "embeddingModel" | "embeddingVersion" | "embeddingDimensions"
  >,
): EmbeddingSpace {
  return {
    model: config.embeddingModel,
    version: config.embeddingVersion,
    dimensions: config.embeddingDimensions,
  };
}

function parse<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv,
): T {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid production configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function parseArtifactKeyring(
  raw: string,
  currentKeyId: string,
): ArtifactKeyringConfig {
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ARTIFACT_KEYRING must be a JSON object");
  }
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ARTIFACT_KEYRING:\n${z.prettifyError(parsed.error)}`);
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed.data)) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`Artifact key ${keyId} must decode to exactly 32 bytes`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(currentKeyId)) {
    throw new Error(
      `ARTIFACT_CURRENT_KEY_ID ${currentKeyId} is not present in ARTIFACT_KEYRING`,
    );
  }
  return { currentKeyId, keys };
}
