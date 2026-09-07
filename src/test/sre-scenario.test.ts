import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import type { ProductionConfig } from "../production/config.js";
import { ProductionDatabase } from "../production/database.js";
import {
  runSreScenario,
  SyntheticRemediationTransport,
} from "../production/sre-scenario.js";

const databaseUrl = process.env.PRODUCTION_TEST_DATABASE_URL;
const migrationDatabaseUrl =
  process.env.PRODUCTION_TEST_MIGRATION_DATABASE_URL;

test("synthetic remediation validates delivery and reconciliation identity", async () => {
  const transport = new SyntheticRemediationTransport();
  await assert.rejects(
    transport.deliver({
      effectId: "effect:invalid",
      authorizationFence: "fence:invalid",
      idempotencyKey: "rollback-api-v42-test",
      targetUrl: "https://deployments.example.com/wrong",
      request: { service: "checkout-api", deployment: "api-v42" },
    }),
    /invalid rollback/,
  );
  assert.equal(transport.deliveryCount, 0);

  await transport.deliver({
    effectId: "effect:test",
    authorizationFence: "fence:test",
    idempotencyKey: "rollback-api-v42-test",
    targetUrl: "https://deployments.example.com/rollback",
    request: { service: "checkout-api", deployment: "api-v42" },
  });
  await assert.rejects(
    transport.reconcile({
      effectId: "effect:test",
      authorizationFence: "fence:wrong",
      idempotencyKey: "rollback-api-v42-test",
      statusUrl: "https://deployments.example.com/status/rollback",
    }),
    /was not applied/,
  );
  assert.equal(transport.reconciliationCount, 0);

  const result = await transport.reconcile({
    effectId: "effect:test",
    authorizationFence: "fence:test",
    idempotencyKey: "rollback-api-v42-test",
    statusUrl: "https://deployments.example.com/status/rollback",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(transport.deliveryCount, 1);
  assert.equal(transport.reconciliationCount, 1);
  assert.equal(transport.errorRate, 0.03);
});

test(
  "flagship SRE scenario survives restart and ambiguous remediation",
  { skip: !databaseUrl || !migrationDatabaseUrl },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(migrationDatabaseUrl);
    const runId = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `agentic_sre_${runId}`;
    const artifactDirectory = mkdtempSync(
      join(tmpdir(), "agentic-sre-scenario-"),
    );
    const control = new Client({
      connectionString: databaseUrlFor(migrationDatabaseUrl, "postgres"),
    });
    let controlConnected = false;
    let databaseCreated = false;
    try {
      await control.connect();
      controlConnected = true;
      await control.query(`CREATE DATABASE ${databaseName}`);
      databaseCreated = true;
      const config = testConfig(
        databaseUrlFor(databaseUrl, databaseName),
        artifactDirectory,
      );
      const result = await runSreScenario({
        config,
        migrationConfig: {
          ...config,
          databaseUrl: databaseUrlFor(
            migrationDatabaseUrl,
            databaseName,
          ),
        },
        runId,
      });
      assert.equal(result.finalState, "resolved");
      assert.equal(result.terminal, true);
      assert.equal(result.effectStatus, "succeeded");
      assert.equal(result.resolutionStatus, "resolved_with_conflict");
      assert.equal(result.deliveryCount, 1);
      assert.equal(result.reconciliationCount, 1);
      assert.equal(result.agentRestarts, 2);
      assert.equal(result.errorRateBefore, 0.42);
      assert.equal(result.errorRateAfter, 0.03);
      assert.ok(result.traceNodeCount >= 10);
      assert.ok(result.traceEdgeCount >= 10);
      assert.match(result.explanation, /deployment\.rollback effect succeeded/);
      assert.match(result.explanation, /attempt 1: unknown/);
      assert.match(result.explanation, /attempt 2: succeeded/);
      assert.match(result.explanation, /decision remediation/);
      assert.match(result.explanation, /observation error_rate/);

      const database = new ProductionDatabase({
        ...config,
        databaseUrl: databaseUrlFor(
          migrationDatabaseUrl,
          databaseName,
        ),
      });
      try {
        const workflow = await database.query<{
          state: string;
          revision: string;
          terminal: boolean;
        }>(
          `SELECT state, revision::TEXT AS revision, terminal
           FROM agentic.machine_instances
           WHERE tenant_id = $1 AND instance_id = $2`,
          [result.tenantId, result.workflowId],
        );
        assert.deepEqual(workflow.rows[0], {
          state: "resolved",
          revision: "5",
          terminal: true,
        });
        const effect = await database.query<{
          status: string;
          attempt_count: number;
          reconciliation_count: number;
          decision_assertion_id: string;
          policy_assertion_id: string;
        }>(
          `SELECT
             status,
             attempt_count,
             reconciliation_count,
             decision_assertion_id,
             policy_assertion_id
           FROM agentic.effect_intents
           WHERE tenant_id = $1 AND effect_id = $2`,
          [result.tenantId, result.effectId],
        );
        assert.equal(effect.rows[0]?.status, "succeeded");
        assert.equal(effect.rows[0]?.attempt_count, 1);
        assert.equal(effect.rows[0]?.reconciliation_count, 1);
        assert.equal(
          effect.rows[0]?.decision_assertion_id,
          result.decisionAssertionId,
        );
        const attempts = await database.query<{ count: string }>(
          `SELECT count(*)::TEXT AS count
           FROM agentic.effect_attempts
           WHERE tenant_id = $1 AND effect_id = $2`,
          [result.tenantId, result.effectId],
        );
        assert.equal(attempts.rows[0]?.count, "2");
        const lineage = await database.query<{ relation: string }>(
          `SELECT relation
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
           ORDER BY relation`,
          [result.tenantId],
        );
        for (const relation of [
          "authorizes",
          "contradicts",
          "evidence_for",
          "governs",
          "produces",
          "supports",
          "verifies",
        ]) {
          assert.ok(
            lineage.rows.some((edge) => edge.relation === relation),
            `Expected ${relation} lineage`,
          );
        }
        const verification = await database.query<{
          kind: string;
          object_json: { value?: number };
        }>(
          `SELECT kind, object_json
           FROM agentic.assertions
           WHERE tenant_id = $1 AND assertion_id = $2`,
          [result.tenantId, result.verificationAssertionId],
        );
        assert.equal(verification.rows[0]?.kind, "observation");
        assert.equal(verification.rows[0]?.object_json.value, 0.03);
      } finally {
        await database.close();
      }
    } finally {
      if (databaseCreated) {
        await control.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
      if (controlConnected) {
        await control.end();
      }
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

function testConfig(
  databaseUrlValue: string,
  artifactDirectory: string,
): ProductionConfig {
  return {
    databaseUrl: databaseUrlValue,
    databaseSsl: false,
    databasePoolSize: 10,
    statementTimeoutMs: 30_000,
    authPepper: "sre-scenario-pepper-with-at-least-thirty-two-characters",
    artifactDirectory,
    artifactKeyring: {
      currentKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 11)]]),
    },
    embeddingBaseUrl: "https://embeddings.example.com/v1",
    embeddingApiKey: "unused-by-synthetic-provider",
    embeddingModel: "sre-scenario",
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

function databaseUrlFor(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
