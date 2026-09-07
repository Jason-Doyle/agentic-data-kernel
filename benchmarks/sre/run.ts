import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Client } from "pg";
import {
  SyntheticRemediationTransport,
  type ProductionConfig,
} from "../../src/production/index.js";
import { runConventionalBaseline } from "./baseline.js";
import { runKernelVariant } from "./kernel.js";
import {
  assertCorrectness,
  auditQuestions,
  type BenchmarkMeasurement,
} from "./shared.js";

const repetitions = positiveInteger(
  process.env.BENCHMARK_REPETITIONS ?? "3",
);
const publishedRepetitions = 3;
const adminBase =
  process.env.BENCHMARK_DATABASE_URL ??
  required("PRODUCTION_TEST_MIGRATION_DATABASE_URL");
const appBase =
  process.env.BENCHMARK_APP_DATABASE_URL ??
  required("PRODUCTION_TEST_DATABASE_URL");
const control = new Client({
  connectionString: databaseUrlFor(adminBase, "postgres"),
});
const measurements: BenchmarkMeasurement[] = [];
const workspace = mkdtempSync(join(tmpdir(), "agentic-sre-benchmark-"));
let postgresVersion = "";

try {
  await control.connect();
  const version = await control.query<{ server_version: string }>(
    "SHOW server_version",
  );
  postgresVersion = version.rows[0]?.server_version ?? "unknown";
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    measurements.push(
      await runVariant("conventional-postgres", repetition),
      await runVariant("agentic-data-kernel", repetition),
    );
  }
} finally {
  await control.end();
  rmSync(workspace, { recursive: true, force: true });
}

const summary = createSummary(measurements);
console.log(JSON.stringify(summary, null, 2));
if (process.env.BENCHMARK_WRITE_RESULTS === "1") {
  const resultsDirectory = resolve("benchmarks", "sre", "results");
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(
    join(resultsDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(
    join(resultsDirectory, "report.md"),
    renderReport(summary),
  );
}
if (process.argv.includes("--verify-results")) {
  verifyPublishedResults(summary);
}

async function runVariant(
  variant: "conventional-postgres" | "agentic-data-kernel",
  repetition: number,
): Promise<BenchmarkMeasurement> {
  const suffix = `${variant === "agentic-data-kernel" ? "adk" : "pg"}_${Date.now()}_${repetition}`;
  const databaseName = `agentic_bench_${suffix}`;
  const adminUrl = databaseUrlFor(adminBase, databaseName);
  const appUrl = databaseUrlFor(appBase, databaseName);
  const artifactDirectory = join(workspace, databaseName);
  mkdirSync(artifactDirectory, { recursive: true });
  await control.query(`CREATE DATABASE ${databaseName}`);
  try {
    const remediation = new SyntheticRemediationTransport();
    const outcome =
      variant === "conventional-postgres"
        ? await runConventionalBaseline({
            databaseUrl: adminUrl,
            runId: `${repetition}`,
            remediation,
          })
        : await runKernelVariant({
            config: testConfig(appUrl, artifactDirectory),
            migrationConfig: {
              ...testConfig(adminUrl, artifactDirectory),
              databaseUrl: adminUrl,
            },
            runId: `${repetition}`,
            remediation,
          });
    assertCorrectness(outcome, String(repetition));
    const metrics = await databaseMetrics(adminUrl);
    return { repetition, outcome, ...metrics };
  } finally {
    await control.query(
      `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
    );
  }
}

async function databaseMetrics(databaseUrl: string): Promise<{
  operatedTables: number;
  databaseBytes: number;
}> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("VACUUM ANALYZE");
    const result = await client.query<{
      table_count: string;
      total_bytes: string;
    }>(
      `SELECT
         count(*)::TEXT AS table_count,
         COALESCE(sum(pg_total_relation_size(
           quote_ident(schemaname) || '.' || quote_ident(tablename)
         )), 0)::TEXT AS total_bytes
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    return {
      operatedTables: Number(result.rows[0]?.table_count ?? "0"),
      databaseBytes: Number(result.rows[0]?.total_bytes ?? "0"),
    };
  } finally {
    await client.end();
  }
}

function createSummary(
  values: BenchmarkMeasurement[],
  metadata: {
    repetitions: number;
    node: string;
    postgres: string;
    commit: string;
  } = {
    repetitions,
    node: process.version,
    postgres: postgresVersion,
    commit: gitCommit(),
  },
) {
  const byVariant = (variant: BenchmarkMeasurement["outcome"]["variant"]) =>
    values.filter((value) => value.outcome.variant === variant);
  const baseline = byVariant("conventional-postgres");
  const kernel = byVariant("agentic-data-kernel");
  return {
    schemaVersion: 1,
    repetitions: metadata.repetitions,
    environment: {
      node: metadata.node,
      postgres: metadata.postgres,
      commit: metadata.commit,
      sourceHash: benchmarkSourceHash(),
    },
    runs: values,
    correctness: {
      conventionalPostgres: passSummary(
        baseline,
        metadata.repetitions,
      ),
      agenticDataKernel: passSummary(
        kernel,
        metadata.repetitions,
      ),
    },
    applicationSurface: {
      conventionalPostgres: {
        nonblankLines:
          sourceLinesBefore(
            "benchmarks/sre/baseline.ts",
            "async function auditBaseline",
          ) +
          sourceLines(["benchmarks/sre/baseline-schema.sql"]),
        authoredTables: 8,
        operatedTables: median(baseline.map((value) => value.operatedTables)),
      },
      agenticDataKernel: {
        nonblankLines: sourceLinesBefore(
          "benchmarks/sre/kernel.ts",
          "async function auditKernel",
        ),
        authoredTables: 0,
        operatedTables: median(kernel.map((value) => value.operatedTables)),
        scenarioSourceLines: sourceLines([
          "src/production/sre-scenario.ts",
        ]),
        dependencySourceLines: sourceLines(
          listFiles("src").filter(
            (path) =>
              extname(path) === ".ts" &&
              !path.split(/[\\/]/).includes("test"),
          ),
        ),
      },
    },
    benchmarkHarness: {
      nonblankLines:
        sourceLines(
          listFiles("benchmarks/sre").filter(
            (path) =>
              extname(path) === ".ts" &&
              !path.endsWith("baseline.ts") &&
              !path.endsWith("kernel.ts"),
          ),
        ) +
        sourceLinesFrom(
          "benchmarks/sre/baseline.ts",
          "async function auditBaseline",
        ) +
        sourceLinesFrom(
          "benchmarks/sre/kernel.ts",
          "async function auditKernel",
        ),
    },
    databaseBytes: {
      conventionalPostgresMedian: median(
        baseline.map((value) => value.databaseBytes),
      ),
      agenticDataKernelMedian: median(
        kernel.map((value) => value.databaseBytes),
      ),
    },
    runtimeMillisecondsInformational: {
      conventionalPostgresMedian: median(
        baseline.map((value) => value.outcome.durationMs),
      ),
      agenticDataKernelMedian: median(
        kernel.map((value) => value.outcome.durationMs),
      ),
    },
    explanationQuestions: auditQuestions.length,
    claims: {
      correctnessParityRequired: true,
      runtimeSuperiorityClaimed: false,
      processCrashRecoveryMeasured: false,
    },
  };
}

function passSummary(
  values: BenchmarkMeasurement[],
  attempted: number,
) {
  return {
    passed: values.length,
    attempted,
    runIds: values.map((value) => value.outcome.runId),
    deliveryCounts: values.map((value) => value.outcome.deliveryCount),
    reconciliationCounts: values.map(
      (value) => value.outcome.reconciliationCount,
    ),
    recoveryRates: values.map((value) => ({
      before: value.outcome.errorRateBefore,
      after: value.outcome.errorRateAfter,
    })),
    explanationScores: values.map(
      (value) =>
        Object.values(value.outcome.auditAnswers).filter(Boolean).length,
    ),
  };
}

function renderReport(summary: ReturnType<typeof createSummary>): string {
  const baseline = summary.applicationSurface.conventionalPostgres;
  const kernel = summary.applicationSurface.agenticDataKernel;
  return `# SRE Incident Benchmark

Generated from \`summary.json\`.

Source revision: \`${summary.environment.commit}\`

Source hash: \`${summary.environment.sourceHash}\`

## Correctness

Both variants must resolve every run with one delivery and one reconciliation.

| Variant | Passed | Delivery counts | Reconciliation counts | Recovery | Audit score |
| --- | ---: | --- | --- | --- | --- |
| Conventional PostgreSQL | ${summary.correctness.conventionalPostgres.passed}/${summary.repetitions} | ${summary.correctness.conventionalPostgres.deliveryCounts.join(", ")} | ${summary.correctness.conventionalPostgres.reconciliationCounts.join(", ")} | ${formatRecovery(summary.correctness.conventionalPostgres.recoveryRates)} | ${summary.correctness.conventionalPostgres.explanationScores.join(", ")} / ${summary.explanationQuestions} |
| Agentic Data Kernel | ${summary.correctness.agenticDataKernel.passed}/${summary.repetitions} | ${summary.correctness.agenticDataKernel.deliveryCounts.join(", ")} | ${summary.correctness.agenticDataKernel.reconciliationCounts.join(", ")} | ${formatRecovery(summary.correctness.agenticDataKernel.recoveryRates)} | ${summary.correctness.agenticDataKernel.explanationScores.join(", ")} / ${summary.explanationQuestions} |

## Application-owned surface

| Variant | Nonblank app lines | App-authored tables | Operated tables |
| --- | ---: | ---: | ---: |
| Conventional PostgreSQL | ${baseline.nonblankLines} | ${baseline.authoredTables} | ${baseline.operatedTables} |
| Agentic Data Kernel adapter | ${kernel.nonblankLines} | ${kernel.authoredTables} | ${kernel.operatedTables} |

The adapter delegates to the shipped SRE scenario, which contains
${kernel.scenarioSourceLines} nonblank TypeScript source lines inside the
dependency. The full kernel dependency contains ${kernel.dependencySourceLines}
nonblank TypeScript source lines.

The benchmark runner and engine-specific audit verification contain
${summary.benchmarkHarness.nonblankLines} nonblank TypeScript source lines.
They are excluded from both application columns. Dependency and harness code
is not application-authored, but it remains code that must be understood,
operated, or upgraded.

## Database footprint

| Variant | Median bytes |
| --- | ---: |
| Conventional PostgreSQL | ${summary.databaseBytes.conventionalPostgresMedian} |
| Agentic Data Kernel | ${summary.databaseBytes.agenticDataKernelMedian} |

## Informational runtime

| Variant | Median milliseconds |
| --- | ---: |
| Conventional PostgreSQL | ${summary.runtimeMillisecondsInformational.conventionalPostgresMedian.toFixed(2)} |
| Agentic Data Kernel | ${summary.runtimeMillisecondsInformational.agenticDataKernelMedian.toFixed(2)} |

Runtime is not a headline metric. The variants perform different work and this
deterministic smoke benchmark is not a latency study.

## Not claimed

- The benchmark does not claim that PostgreSQL cannot implement safe recovery.
- The benchmark requires correctness parity.
- It does not measure operating-system process crash recovery.
- It does not claim runtime or storage superiority.
- LOC is a structural observation, not a productivity measurement.
- Adapter LOC measures reuse of the shipped SRE scenario, not equivalent
  scenario implementations written from generic primitives.
`;
}

function verifyPublishedResults(
  live: ReturnType<typeof createSummary>,
): void {
  const resultsDirectory = resolve("benchmarks", "sre", "results");
  const summaryPath = join(resultsDirectory, "summary.json");
  const reportPath = join(resultsDirectory, "report.md");
  const published = parsePublishedSummary(
    readFileSync(summaryPath, "utf8"),
  );
  if (published.repetitions !== publishedRepetitions) {
    throw new Error(
      `Published SRE benchmark evidence must contain ${publishedRepetitions} repetitions`,
    );
  }
  const baseline = published.runs.filter(
    (value) => value.outcome.variant === "conventional-postgres",
  );
  const kernel = published.runs.filter(
    (value) => value.outcome.variant === "agentic-data-kernel",
  );
  if (
    !hasExpectedRepetitions(baseline) ||
    !hasExpectedRepetitions(kernel)
  ) {
    throw new Error(
      "Published SRE benchmark evidence must contain unique repetitions per variant",
    );
  }
  for (const measurement of published.runs) {
    assertCorrectness(
      measurement.outcome,
      String(measurement.repetition),
    );
  }
  const expectedHash = benchmarkSourceHash();
  if (published.environment.sourceHash !== expectedHash) {
    throw new Error(
      "Published SRE benchmark evidence is stale; regenerate the results",
    );
  }
  const expectedSummary = createSummary(published.runs, {
    repetitions: published.repetitions,
    node: published.environment.node,
    postgres: published.environment.postgres,
    commit: published.environment.commit,
  });
  if (JSON.stringify(published) !== JSON.stringify(expectedSummary)) {
    throw new Error(
      "Published SRE benchmark aggregates do not match the raw runs",
    );
  }
  if (
    JSON.stringify(deterministicEvidence(published)) !==
    JSON.stringify(deterministicEvidence(live))
  ) {
    throw new Error(
      "Published SRE benchmark evidence does not match the live comparison",
    );
  }
  const expectedReport = normalizeLineEndings(renderReport(published));
  const actualReport = normalizeLineEndings(
    readFileSync(reportPath, "utf8"),
  );
  if (actualReport !== expectedReport) {
    throw new Error(
      "Published SRE benchmark report does not match summary.json",
    );
  }
}

function hasExpectedRepetitions(
  values: BenchmarkMeasurement[],
): boolean {
  const actual = values
    .map((value) => value.repetition)
    .sort((left, right) => left - right);
  return (
    actual.length === publishedRepetitions &&
    actual.every((value, index) => value === index + 1)
  );
}

function deterministicEvidence(
  summary: ReturnType<typeof createSummary>,
) {
  return {
    repetitions: summary.repetitions,
    runs: summary.runs.map((measurement) => {
      const { durationMs: _durationMs, ...outcome } = measurement.outcome;
      return {
        repetition: measurement.repetition,
        outcome,
        operatedTables: measurement.operatedTables,
        databaseBytes: measurement.databaseBytes,
      };
    }),
    correctness: summary.correctness,
    applicationSurface: summary.applicationSurface,
    benchmarkHarness: summary.benchmarkHarness,
    databaseBytes: summary.databaseBytes,
    explanationQuestions: summary.explanationQuestions,
    claims: summary.claims,
  };
}

function formatRecovery(
  values: Array<{ before: number; after: number }>,
): string {
  return values
    .map((value) => `${value.before} -> ${value.after}`)
    .join(", ");
}

function parsePublishedSummary(
  source: string,
): ReturnType<typeof createSummary> {
  const value: unknown = JSON.parse(source);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.repetitions !== "number" ||
    !Array.isArray(value.runs) ||
    !value.runs.every(isBenchmarkMeasurement) ||
    !isRecord(value.environment) ||
    typeof value.environment.node !== "string" ||
    typeof value.environment.postgres !== "string" ||
    typeof value.environment.commit !== "string" ||
    typeof value.environment.sourceHash !== "string"
  ) {
    throw new Error("Published SRE benchmark summary is invalid");
  }
  return value as ReturnType<typeof createSummary>;
}

function isBenchmarkMeasurement(
  value: unknown,
): value is BenchmarkMeasurement {
  if (
    !isRecord(value) ||
    typeof value.repetition !== "number" ||
    !Number.isInteger(value.repetition) ||
    value.repetition < 1 ||
    typeof value.operatedTables !== "number" ||
    !Number.isInteger(value.operatedTables) ||
    value.operatedTables < 0 ||
    typeof value.databaseBytes !== "number" ||
    !Number.isFinite(value.databaseBytes) ||
    value.databaseBytes < 0 ||
    !isRecord(value.outcome)
  ) {
    return false;
  }
  const outcome = value.outcome;
  if (!isRecord(outcome.auditAnswers)) {
    return false;
  }
  const auditAnswers = outcome.auditAnswers;
  return (
    (
      outcome.variant === "conventional-postgres" ||
      outcome.variant === "agentic-data-kernel"
    ) &&
    typeof outcome.runId === "string" &&
    typeof outcome.finalState === "string" &&
    typeof outcome.effectStatus === "string" &&
    typeof outcome.deliveryCount === "number" &&
    Number.isInteger(outcome.deliveryCount) &&
    typeof outcome.reconciliationCount === "number" &&
    Number.isInteger(outcome.reconciliationCount) &&
    typeof outcome.runtimeReloads === "number" &&
    Number.isInteger(outcome.runtimeReloads) &&
    typeof outcome.errorRateBefore === "number" &&
    Number.isFinite(outcome.errorRateBefore) &&
    typeof outcome.errorRateAfter === "number" &&
    Number.isFinite(outcome.errorRateAfter) &&
    typeof outcome.durationMs === "number" &&
    Number.isFinite(outcome.durationMs) &&
    outcome.durationMs >= 0 &&
    Object.keys(auditAnswers).length === auditQuestions.length &&
    auditQuestions.every(
      (question) => typeof auditAnswers[question] === "boolean",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function testConfig(
  databaseUrl: string,
  artifactDirectory: string,
): ProductionConfig {
  return {
    databaseUrl,
    databaseSsl: false,
    databasePoolSize: 10,
    statementTimeoutMs: 30_000,
    authPepper: "benchmark-pepper-with-at-least-thirty-two-characters",
    artifactDirectory,
    artifactKeyring: {
      currentKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 13)]]),
    },
    embeddingBaseUrl: "https://embeddings.example.com/v1",
    embeddingApiKey: "unused",
    embeddingModel: "benchmark",
    embeddingVersion: "1",
    embeddingDimensions: 384,
    embeddingTimeoutMs: 5_000,
    searchCandidateLimit: 100,
    hnswEfSearch: 100,
    hnswMaxScanTuples: 20_000,
    effectAllowedHosts: new Set(),
    effectTimeoutMs: 5_000,
    effectLeaseSeconds: 30,
    effectMaxAttempts: 1,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    maxBodyBytes: 1_000_000,
    rateLimitPerMinute: 1_000,
    trustedProxyHops: 0,
    shutdownTimeoutMs: 10_000,
    workerMonitorHost: "127.0.0.1",
    workerMonitorPort: 4319,
    mcpHttpEnabled: false,
    mcpHttpWriteEnabled: false,
  };
}

function sourceLines(paths: string[]): number {
  return paths.reduce(
    (total, path) => total + nonblankLines(readFileSync(resolve(path), "utf8")),
    0,
  );
}

function sourceLinesBefore(path: string, marker: string): number {
  const source = readFileSync(resolve(path), "utf8");
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Source marker was not found in ${path}`);
  }
  return nonblankLines(source.slice(0, markerIndex));
}

function sourceLinesFrom(path: string, marker: string): number {
  const source = readFileSync(resolve(path), "utf8");
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Source marker was not found in ${path}`);
  }
  return nonblankLines(source.slice(markerIndex));
}

function nonblankLines(source: string): number {
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function listFiles(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      paths.push(join(entry.parentPath, entry.name));
    }
  }
  return paths;
}

function benchmarkSourceHash(): string {
  const paths = [
    "package.json",
    "package-lock.json",
    "docker-compose.yml",
    ...listFiles("benchmarks/sre").filter((path) =>
      [".sql", ".ts"].includes(extname(path)),
    ),
    ...listFiles("migrations/postgres").filter(
      (path) => extname(path) === ".sql",
    ),
    ...listFiles("src").filter(
      (path) =>
        extname(path) === ".ts" &&
        !path.split(/[\\/]/).includes("test"),
    ),
  ].map((path) => path.replaceAll("\\", "/")).sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    digest.update(
      normalizeLineEndings(readFileSync(resolve(path), "utf8")),
    );
    digest.update("\0");
  }
  return digest.digest("hex");
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function gitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function databaseUrlFor(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("BENCHMARK_REPETITIONS must be an integer from 1 to 20");
  }
  return parsed;
}
