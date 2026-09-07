import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let archivePath;
let installDirectory;

try {
  const packOutput = runNpm(["pack", "--json"], {
    cwd: projectRoot,
    capture: true,
  });
  const packResults = JSON.parse(packOutput);
  const packageResult = Array.isArray(packResults)
    ? packResults[0]
    : Object.values(packResults)[0];
  if (!packageResult?.filename || !Array.isArray(packageResult.files)) {
    throw new Error("npm pack did not return a package manifest");
  }

  archivePath = resolve(projectRoot, packageResult.filename);
  const packagedPaths = new Set(
    packageResult.files.map((entry) => entry.path),
  );
  for (const requiredPath of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/agent.js",
    "dist/agent.d.ts",
    "dist/production/index.js",
    "dist/production/index.d.ts",
    "dist/production/agent.js",
    "dist/production/agent.d.ts",
    "dist/production/mcp-http.js",
    "dist/production/mcp-http.d.ts",
    "dist/production/bootstrap.js",
    "dist/production/bootstrap.d.ts",
    "dist/examples/sre-scenario.js",
    "dist/examples/agent-middleware.js",
    "dist/examples/production-agent-middleware.js",
    "migrations/postgres/001_core.sql",
    "migrations/postgres/002_embedding_space.sql",
    "migrations/postgres/003_generic_agency.sql",
    "benchmarks/sre/README.md",
    "benchmarks/sre/baseline-schema.sql",
    "deploy/CONTRACT.md",
    "deploy/azure/main.bicep",
    "deploy/aws/main.tf",
    "deploy/gcp/main.tf",
    "deploy/kubernetes/helm/agentic-data-kernel/Chart.yaml",
    "scripts/validate-deployments.ps1",
    "scripts/backup-common.ps1",
    "docs/AGENT_MIDDLEWARE.md",
    "examples/microsoft-agent-framework/README.md",
    "examples/microsoft-agent-framework/local_stdio.py",
    "examples/microsoft-agent-framework/remote_http.py",
    "examples/microsoft-agent-framework/requirements.txt",
    "examples/microsoft-agent-framework/validation-requirements.txt",
    "examples/azure-sre-agent/README.md",
    "examples/azure-sre-agent/durable-incident-agent.yaml",
    "README.md",
    "LICENSE",
  ]) {
    if (!packagedPaths.has(requiredPath)) {
      throw new Error(`Package is missing ${requiredPath}`);
    }
  }
  for (const forbiddenPath of [
    ".env",
    "Dockerfile",
    "scripts/test-package.mjs",
    "src/index.ts",
  ]) {
    if (packagedPaths.has(forbiddenPath)) {
      throw new Error(`Package unexpectedly contains ${forbiddenPath}`);
    }
  }
  if ([...packagedPaths].some((path) => path.startsWith("dist/test/"))) {
    throw new Error("Package unexpectedly contains compiled tests");
  }
  if (
    [...packagedPaths].some(
      (path) => path.includes("__pycache__") || path.endsWith(".pyc"),
    )
  ) {
    throw new Error("Package unexpectedly contains Python bytecode");
  }

  installDirectory = mkdtempSync(join(tmpdir(), "agentic-data-package-"));
  writeFileSync(
    join(installDirectory, "package.json"),
    JSON.stringify({ name: "agentic-data-package-smoke", private: true }),
  );
  runNpm(
    [
      "install",
      archivePath,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: installDirectory },
  );

  const installedPackage = join(
    installDirectory,
    "node_modules",
    "agentic-data-kernel",
  );
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackage, "package.json"), "utf8"),
  );
  for (const binary of [
    "agentic-data",
    "agentic-data-kernel",
    "agentic-data-prod",
  ]) {
    if (!installedManifest.bin?.[binary]) {
      throw new Error(`Installed package is missing the ${binary} binary`);
    }
  }

  const smokeModule = join(installDirectory, "smoke.mjs");
  writeFileSync(
    smokeModule,
    `import {
      AgentDataMiddleware,
  AgenticKernel,
      KNOWLEDGE_OPERATION_NAMES,
      KnowledgeLayer,
      PACKAGE_VERSION,
      SqliteStore,
      createEmbeddedAgentMiddleware,
      formatTraceExplanation,
    } from "agentic-data-kernel";
import {
  AgentDataHttpError,
  bootstrapRuntimeRole,
  createProductionAgentMiddleware,
  createProductionHttpAgentMiddleware,
  OpenAiCompatibleEmbeddingProvider,
  postgresMigrationDirectory,
} from "agentic-data-kernel/production";
import { existsSync } from "node:fs";
import { join } from "node:path";

const store = new SqliteStore(":memory:");
try {
  const kernel = new AgenticKernel(store);
  if (typeof kernel.catalog !== "function") {
    throw new Error("Root package export is unavailable");
  }
  if (typeof OpenAiCompatibleEmbeddingProvider !== "function") {
    throw new Error("Production package export is unavailable");
  }
  if (typeof bootstrapRuntimeRole !== "function") {
    throw new Error("Runtime role bootstrap export is unavailable");
  }
  if (typeof formatTraceExplanation !== "function") {
    throw new Error("Trace formatter export is unavailable");
  }
  const middleware = createEmbeddedAgentMiddleware(kernel, {
    tenantId: "package-smoke",
    principalId: "package-smoke",
    purpose: "test",
  });
  if (!(middleware instanceof AgentDataMiddleware)) {
    throw new Error("Agent middleware export is unavailable");
  }
  const session = middleware.beginRun({ runId: "package-smoke" });
  if (
    !session
      .modelTools()
      .some((tool) => tool.name === "execute_operation")
  ) {
    throw new Error("Agent middleware model tools are unavailable");
  }
  if (
    typeof createProductionAgentMiddleware !== "function" ||
    typeof createProductionHttpAgentMiddleware !== "function" ||
    typeof AgentDataHttpError !== "function"
  ) {
    throw new Error("Production agent middleware exports are unavailable");
  }
  if (
    !(kernel.knowledge instanceof KnowledgeLayer) ||
    !KNOWLEDGE_OPERATION_NAMES.includes("assert")
  ) {
    throw new Error("Layered API exports are unavailable");
  }
  if (PACKAGE_VERSION !== ${JSON.stringify(installedManifest.version)}) {
    throw new Error("Published runtime version does not match package metadata");
  }
  if (
    !existsSync(join(postgresMigrationDirectory, "001_core.sql")) ||
    !existsSync(join(postgresMigrationDirectory, "002_embedding_space.sql")) ||
    !existsSync(join(postgresMigrationDirectory, "003_generic_agency.sql"))
  ) {
    throw new Error("Packaged PostgreSQL migrations are unavailable");
  }
} finally {
  store.close();
}
`,
  );
  run(process.execPath, ["--no-warnings", smokeModule], {
    cwd: installDirectory,
  });

  const typeSmokeModule = join(installDirectory, "smoke.mts");
  const typeConfig = join(installDirectory, "tsconfig.json");
  writeFileSync(
    typeSmokeModule,
    `import {
      type AgentContextBundle,
      type AgentDataMiddlewareConfig,
      type AgentDataSession,
  AgenticKernel,
      type AgentIntentVersion,
      type KnowledgeOperationName,
      KnowledgeLayer,
      PACKAGE_VERSION,
      SqliteStore,
      formatTraceExplanation,
    } from "agentic-data-kernel";
import {
  type ProductionHttpAgentMiddlewareConfig,
  type ProductionConfig,
  bootstrapRuntimeRole,
  type EmbeddingSpace,
  ProductionDatabase,
  postgresMigrationDirectory,
} from "agentic-data-kernel/production";

const store = new SqliteStore(":memory:");
const kernel: AgenticKernel = new AgenticKernel(store);
const knowledgeLayer: KnowledgeLayer = kernel.knowledge;
const knowledgeOperation: KnowledgeOperationName = "assert";
const protocolVersion: AgentIntentVersion = "1.0";
const packageVersion: string = PACKAGE_VERSION;
const formatter: typeof formatTraceExplanation = formatTraceExplanation;
const databaseType: typeof ProductionDatabase = ProductionDatabase;
const bootstrapType: typeof bootstrapRuntimeRole = bootstrapRuntimeRole;
const migrationPath: string = postgresMigrationDirectory;
const embeddingSpace: EmbeddingSpace = {
  model: "test",
  version: "1",
  dimensions: 768,
};
const middlewareConfig: AgentDataMiddlewareConfig | null = null;
const contextBundle: AgentContextBundle | null = null;
const agentSession: AgentDataSession | null = null;
const httpMiddlewareConfig: ProductionHttpAgentMiddlewareConfig | null = null;
type LegacyProductionConfig = Omit<
  ProductionConfig,
  "mcpHttpEnabled" | "mcpHttpPublicOrigin" | "mcpHttpWriteEnabled"
>;
type LegacyProductionConfigIsCompatible =
  LegacyProductionConfig extends ProductionConfig ? true : never;
const legacyProductionConfigIsCompatible: LegacyProductionConfigIsCompatible =
  true;
void kernel;
void knowledgeLayer;
void knowledgeOperation;
void protocolVersion;
void packageVersion;
void formatter;
void databaseType;
void bootstrapType;
void migrationPath;
void embeddingSpace;
void middlewareConfig;
void contextBundle;
void agentSession;
void httpMiddlewareConfig;
void legacyProductionConfigIsCompatible;
store.close();
`,
  );
  writeFileSync(
    typeConfig,
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2023",
      },
      include: ["smoke.mts"],
    }),
  );
  const typescriptCli = join(
    projectRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  if (!existsSync(typescriptCli)) {
    throw new Error("TypeScript compiler is unavailable");
  }
  run(process.execPath, [typescriptCli, "--project", typeConfig], {
    cwd: installDirectory,
  });

  for (const binary of ["agentic-data-kernel", "agentic-data-prod"]) {
    runNpm(["exec", "--offline", "--", binary, "--help"], {
      cwd: installDirectory,
    });
  }

  console.log(
    `Package smoke test passed for ${installedManifest.name}@${installedManifest.version}`,
  );
} finally {
  if (archivePath) {
    try {
      unlinkSync(archivePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (installDirectory) {
    rmSync(installDirectory, { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is unavailable");
  }
  return run(process.execPath, [npmCli, ...args], options);
}
