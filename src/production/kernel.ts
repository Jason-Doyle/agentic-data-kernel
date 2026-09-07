import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { toSql as vectorToSql } from "pgvector";
import type { PoolClient, QueryResultRow } from "pg";
import {
  jsonResult,
  KernelError,
  operationEvidence,
} from "../kernel.js";
import {
  normalizeTraceDepth,
  summarizeTraceJson,
  traceEndpointKey,
} from "../explain.js";
import {
  isAgencyOperation,
  isKnowledgeOperation,
  isRetailCompatibilityOperation,
  type AgencyOperation,
  type KnowledgeOperation,
  type RetailCompatibilityOperation,
} from "../layers.js";
import {
  parseIntentEnvelope,
  type AgentOperation,
  type IntentExecutionResult,
} from "../ir.js";
import type {
  AssertionRecord,
  EffectRecord,
  EpistemicKind,
  InventoryRecord,
  JsonValue,
  LineageEdgeRecord,
  LineageEndpoint,
  LineageRelation,
  MachineRecord,
  MachineState,
  OrderData,
  ResolutionPolicy,
  ResolutionResult,
  SearchHit,
  Strength,
  TraceExplanation,
  TraceNode,
  TypedValue,
  WorkflowRecord,
} from "../types.js";
import {
  normalizeIsoTimestamp,
  sha256,
  stableStringify,
  toJsonValue,
  typedValueText,
} from "../util.js";
import type { EncryptedArtifactStore, StoredArtifact } from "./artifacts.js";
import { assertRuntimeRoleSafe } from "./bootstrap.js";
import {
  operationScope,
  revalidatePrincipal as revalidateAuthenticatedPrincipal,
  requireScope,
  type AuthenticatedPrincipal,
} from "./auth.js";
import type { ProductionConfig } from "./config.js";
import type { ProductionDatabase } from "./database.js";
import {
  embeddingSpace as describeEmbeddingSpace,
  type EmbeddingProvider,
  type EmbeddingSpace,
  validateEmbeddingVector,
} from "./embeddings.js";
import type { MetricsRegistry } from "./metrics.js";
import { buildHybridSearchQuery } from "./search.js";

interface AssertionRow extends QueryResultRow {
  tenant_id: string;
  assertion_id: string;
  subject_entity_id: string;
  predicate: string;
  object_json: TypedValue;
  kind: string;
  perspective: string;
  valid_from: Date;
  valid_to: Date | null;
  system_from: Date;
  system_to: Date | null;
  strength_json: Strength;
  authority: number;
  status: string;
  source_artifact_id: string | null;
  basis_json: JsonValue | null;
  supersedes_assertion_id: string | null;
  created_by: string;
}

interface EntityRow extends QueryResultRow {
  tenant_id: string;
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  created_at: Date;
}

interface ArtifactRow extends QueryResultRow {
  tenant_id: string;
  artifact_id: string;
  content_hash: string;
  media_type: string;
  storage_key: string;
  encryption_key_id: string;
  source_identity: string;
  observed_at: Date;
  sensitivity: string;
  retention_policy: string;
  status: string;
  created_at: Date;
}

interface InventoryRow extends QueryResultRow {
  tenant_id: string;
  sku: string;
  location: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  version: string | number;
  updated_at: Date;
}

interface MachineRow extends QueryResultRow {
  tenant_id: string;
  instance_id: string;
  machine_type: string;
  state: string;
  data_json: OrderData;
  revision: string | number;
  terminal: boolean;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowRow extends QueryResultRow {
  tenant_id: string;
  instance_id: string;
  machine_type: string;
  state: string;
  data_json: JsonValue;
  revision: string | number;
  terminal: boolean;
  created_at: Date;
  updated_at: Date;
}

interface EffectRow extends QueryResultRow {
  tenant_id: string;
  effect_id: string;
  instance_id: string;
  originating_revision: string | number;
  effect_name: string;
  effect_type: string;
  outcome_handler: string;
  target_url: string;
  status_url: string;
  request_json: JsonValue;
  idempotency_key: string;
  decision_assertion_id: string | null;
  policy_assertion_id: string | null;
  provider_namespace: string;
  request_hash: string;
  authorizing_key_id: string;
  budget_amount: string;
  currency: string;
  status: string;
  attempt_count: number;
  outcome_json: JsonValue | null;
  created_at: Date;
  updated_at: Date;
}

interface LineageRow extends QueryResultRow {
  tenant_id: string;
  edge_id: string;
  relation: string;
  from_artifact_id: string | null;
  from_assertion_id: string | null;
  from_instance_id: string | null;
  from_revision: string | number | null;
  from_effect_id: string | null;
  to_artifact_id: string | null;
  to_assertion_id: string | null;
  to_instance_id: string | null;
  to_revision: string | number | null;
  to_effect_id: string | null;
  created_by: string;
  created_at: Date;
}

interface TraceHistoryRow extends QueryResultRow {
  tenant_id: string;
  instance_id: string;
  revision: string | number;
  event_id: string;
  transition_name: string;
  prior_state: string;
  new_state: string;
  data_json: JsonValue;
  created_at: Date;
  machine_type: string;
}

interface TraceAttemptRow extends QueryResultRow {
  effect_id: string;
  attempt_number: number;
  status: string;
  response_status: number | null;
  outcome_json: JsonValue | null;
  created_at: Date;
  total_count: string;
}

interface EffectRequestIdentity {
  instanceId: string;
  originatingRevision?: number;
  effectName: string;
  effectType: string;
  target: string;
  statusUrl: string;
  request: JsonValue;
  amount: string;
  currency: string;
  decisionAssertionId: string | null;
  policyAssertionId: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  result_json: IntentExecutionResult;
}

interface PreparedAssertion {
  persistedSearchText: string;
  embedding: number[];
}

interface PreparedArtifact {
  stored: StoredArtifact;
  artifactId: string;
}

export class ProductionKernel {
  private readonly activeEmbeddingSpace: EmbeddingSpace;

  public constructor(
    private readonly database: ProductionDatabase,
    private readonly artifactStore: EncryptedArtifactStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: Pick<
      ProductionConfig,
      | "effectAllowedHosts"
      | "searchCandidateLimit"
      | "hnswEfSearch"
      | "hnswMaxScanTuples"
    >,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {
    this.activeEmbeddingSpace = describeEmbeddingSpace(embeddings);
  }

  public embeddingSpace(): EmbeddingSpace {
    return { ...this.activeEmbeddingSpace };
  }

  public async revalidatePrincipal(
    principal: AuthenticatedPrincipal,
  ): Promise<AuthenticatedPrincipal> {
    return this.database.withTenantTransaction(principal, (client) =>
      revalidateAuthenticatedPrincipal(client, principal),
    );
  }

  public async assertRuntimeRoleSafe(): Promise<void> {
    await assertRuntimeRoleSafe(this.database);
  }

  public async execute(
    principal: AuthenticatedPrincipal,
    input: unknown,
  ): Promise<IntentExecutionResult> {
    const envelope = parseIntentEnvelope(input);
    verifyEnvelopePrincipal(principal, envelope.principal);
    if (
      envelope.operation.op === "record_payment_outcome" ||
      envelope.operation.op === "record_effect_outcome"
    ) {
      throw new KernelError(
        "unauthorized",
        "Effect outcomes are accepted only from the effect worker",
      );
    }
    const activePrincipal = await this.revalidatePrincipal(principal);
    requireScope(
      activePrincipal,
      operationScope(envelope.operation.op),
    );

    const requestHash = sha256(
      stableStringify(
        envelope.protocolVersion === "0.1"
          ? {
              principal: envelope.principal,
              operation: envelope.operation,
            }
          : {
              protocolVersion: envelope.protocolVersion,
              principal: envelope.principal,
              operation: envelope.operation,
            },
      ),
    );
    const operationKey = envelope.idempotencyKey ?? envelope.requestId;
    const started = performance.now();
    const existing = await this.database.withTenantTransaction(
      activePrincipal,
      async (client) => {
        const validatedPrincipal =
          await revalidateAuthenticatedPrincipal(client, activePrincipal);
        requireScope(
          validatedPrincipal,
          operationScope(envelope.operation.op),
        );
        await this.lockIdempotency(
          client,
          validatedPrincipal,
          operationKey,
        );
        return this.getIdempotency(
          client,
          validatedPrincipal,
          operationKey,
          requestHash,
        );
      },
    );
    if (existing) {
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "ok",
      });
      this.metrics.observe(
        "agentic_intent_duration_ms",
        performance.now() - started,
        { operation: envelope.operation.op },
      );
      return {
        ...existing,
        requestId: envelope.requestId,
        idempotentReplay: true,
      };
    }
    const preparedArtifact =
      envelope.operation.op === "put_artifact"
        ? await this.prepareArtifact(activePrincipal, envelope.operation)
        : null;
    const preparedAssertion =
      envelope.operation.op === "assert"
        ? await this.prepareAssertion(activePrincipal, envelope.operation)
        : null;
    let searchEmbedding: number[] | null = null;
    if (envelope.operation.op === "search") {
      searchEmbedding = (await this.embeddings.embed([
        envelope.operation.text,
      ]))[0] ?? null;
      if (!searchEmbedding) {
        throw new Error("Embedding provider returned no search vector");
      }
      validateEmbeddingVector(
        searchEmbedding,
        this.activeEmbeddingSpace.dimensions,
      );
    }

    try {
      const execution = await this.database.withTenantWriteTransaction(
        activePrincipal,
        async (client) => {
          const validatedPrincipal =
            await revalidateAuthenticatedPrincipal(
              client,
              activePrincipal,
            );
          requireScope(
            validatedPrincipal,
            operationScope(envelope.operation.op),
          );
          await this.lockIdempotency(
            client,
            validatedPrincipal,
            operationKey,
          );
          const replay = await this.getIdempotency(
            client,
            validatedPrincipal,
            operationKey,
            requestHash,
          );
          if (replay) {
            return {
              ...replay,
              requestId: envelope.requestId,
              idempotentReplay: true,
            };
          }

          const rawResult = await this.executeOperation(
            client,
            validatedPrincipal,
            envelope.operation,
            preparedArtifact,
            preparedAssertion,
            searchEmbedding,
          );
          const result = jsonResult(rawResult);
          const evidenceManifest = operationEvidence(rawResult);
          const receipt = await this.recordReceipt(
            client,
            validatedPrincipal,
            envelope.requestId,
            envelope.operation.op,
            result,
            evidenceManifest,
          );
          const response: IntentExecutionResult = {
            protocolVersion: envelope.protocolVersion,
            requestId: envelope.requestId,
            status: "ok",
            operation: envelope.operation.op,
            result,
            receipt,
            idempotentReplay: false,
          };
          await client.query(
            `INSERT INTO agentic.idempotency_results (
               tenant_id, principal_id, operation_key, request_hash, result_json
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              validatedPrincipal.tenantId,
              validatedPrincipal.principalId,
              operationKey,
              requestHash,
              response,
            ],
          );
          return response;
        },
        envelope.operation.op === "explain"
          ? "REPEATABLE READ"
          : "READ COMMITTED",
      );
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "ok",
      });
      return execution;
    } catch (error) {
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "error",
      });
      throw error;
    } finally {
      this.metrics.observe(
        "agentic_intent_duration_ms",
        performance.now() - started,
        { operation: envelope.operation.op },
      );
    }
  }

  public async searchReadOnly(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "search" }>,
  ): Promise<SearchHit[]> {
    const activePrincipal = await this.revalidatePrincipal(principal);
    requireScope(activePrincipal, "data:read");
    const embedding = (await this.embeddings.embed([operation.text]))[0];
    if (!embedding) {
      throw new Error("Embedding provider returned no search vector");
    }
    validateEmbeddingVector(
      embedding,
      this.activeEmbeddingSpace.dimensions,
    );
    return this.database.withTenantTransaction(
      activePrincipal,
      async (client) => {
        const active = await revalidateAuthenticatedPrincipal(
          client,
          activePrincipal,
        );
        requireScope(active, "data:read");
        return this.search(
          client,
          active.tenantId,
          operation,
          embedding,
        );
      },
    );
  }

  public async resolveReadOnly(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "resolve" }>,
  ): Promise<ResolutionResult> {
    return this.database.withTenantTransaction(
      principal,
      async (client) => {
        const active = await revalidateAuthenticatedPrincipal(
          client,
          principal,
        );
        requireScope(active, "data:read");
        return this.resolve(client, active.tenantId, operation);
      },
    );
  }

  public async explainReadOnly(
    principal: AuthenticatedPrincipal,
    target: LineageEndpoint,
    maxDepth = 4,
  ): Promise<TraceExplanation> {
    return this.database.withTenantTransaction(
      principal,
      async (client) => {
        const active = await revalidateAuthenticatedPrincipal(
          client,
          principal,
        );
        requireScope(active, "data:read");
        return this.explainTrace(
          client,
          active.tenantId,
          target,
          maxDepth,
        );
      },
      "REPEATABLE READ",
    );
  }

  public async getMachineReadOnly(
    principal: AuthenticatedPrincipal,
    instanceId: string,
  ): Promise<MachineRecord | WorkflowRecord> {
    return this.database.withTenantTransaction(
      principal,
      async (client) => {
        const active = await revalidateAuthenticatedPrincipal(
          client,
          principal,
        );
        requireScope(active, "data:read");
        return this.getMachineRecord(
          client,
          active.tenantId,
          instanceId,
        );
      },
    );
  }

  public async listEffectsReadOnly(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "list_effects" }> = {
      op: "list_effects",
    },
  ): Promise<EffectRecord[]> {
    return this.database.withTenantTransaction(
      principal,
      async (client) => {
        const active = await revalidateAuthenticatedPrincipal(
          client,
          principal,
        );
        requireScope(active, "data:read");
        return this.listEffects(
          client,
          active.tenantId,
          operation,
        );
      },
    );
  }

  private async prepareArtifact(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_artifact" }>,
  ): Promise<PreparedArtifact> {
    const artifactId =
      operation.artifact.artifactId ??
      `artifact_${sha256(
        principal.tenantId,
        operation.artifact.sourceIdentity,
        sha256(operation.artifact.content),
      ).slice(0, 24)}`;
    const stored = await this.artifactStore.put(
      principal.tenantId,
      artifactId,
      operation.artifact.mediaType,
      operation.artifact.content,
    );
    return { stored, artifactId };
  }

  private async prepareAssertion(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "assert" }>,
  ): Promise<PreparedAssertion> {
    const context = await this.database.withTenantTransaction(
      principal,
      async (client) => {
        const entityResult = await client.query<EntityRow>(
          `SELECT * FROM agentic.entities
           WHERE tenant_id = $1 AND entity_id = $2`,
          [principal.tenantId, operation.assertion.subjectEntityId],
        );
        const entity = entityResult.rows[0];
        if (!entity) {
          throw new KernelError("not_found", "Assertion subject was not found");
        }

        let sourceIdentity = "";
        let artifactContent = "";
        if (operation.assertion.sourceArtifactId) {
          const artifactResult = await client.query<ArtifactRow>(
            `SELECT * FROM agentic.artifacts
             WHERE tenant_id = $1 AND artifact_id = $2 AND status = 'active'`,
            [principal.tenantId, operation.assertion.sourceArtifactId],
          );
          const artifact = artifactResult.rows[0];
          if (!artifact) {
            throw new KernelError(
              "not_found",
              "Assertion source artifact was not found",
            );
          }
          sourceIdentity = artifact.source_identity;
          artifactContent = await this.artifactStore.get({
            tenantId: artifact.tenant_id,
            artifactId: artifact.artifact_id,
            mediaType: artifact.media_type,
            contentHash: artifact.content_hash,
            storageKey: artifact.storage_key,
            encryptionKeyId: artifact.encryption_key_id,
          });
        }
        return {
          entityName: entity.canonical_name,
          sourceIdentity,
          artifactContent,
        };
      },
    );

    const perspective = operation.assertion.perspective ?? "organization";
    const persistedSearchText = [
      context.entityName,
      operation.assertion.predicate.replaceAll("_", " "),
      typedValueText(operation.assertion.object),
      operation.assertion.kind.replaceAll("_", " "),
      perspective,
      context.sourceIdentity,
    ].join(" ");
    const embeddingText = `${persistedSearchText} ${context.artifactContent.slice(
      0,
      Math.max(0, 100_000 - persistedSearchText.length - 1),
    )}`;
    if (persistedSearchText.length > 100_000) {
      throw new KernelError(
        "invalid_input",
        "Assertion metadata exceeds the embedding input limit",
      );
    }
    const embedding = (await this.embeddings.embed([embeddingText]))[0];
    if (!embedding) {
      throw new Error("Embedding provider returned no assertion vector");
    }
    validateEmbeddingVector(
      embedding,
      this.activeEmbeddingSpace.dimensions,
    );
    return { persistedSearchText, embedding };
  }

  private async executeOperation(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: AgentOperation,
    preparedArtifact: PreparedArtifact | null,
    preparedAssertion: PreparedAssertion | null,
    searchEmbedding: number[] | null,
  ): Promise<unknown> {
    if (isKnowledgeOperation(operation)) {
      return this.executeKnowledgeOperation(
        client,
        principal,
        operation,
        preparedArtifact,
        preparedAssertion,
        searchEmbedding,
      );
    }
    if (isAgencyOperation(operation)) {
      return this.executeAgencyOperation(client, principal, operation);
    }
    if (isRetailCompatibilityOperation(operation)) {
      return this.executeRetailCompatibilityOperation(
        client,
        principal,
        operation,
      );
    }
    return assertNever(operation);
  }

  private async executeKnowledgeOperation(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: KnowledgeOperation,
    preparedArtifact: PreparedArtifact | null,
    preparedAssertion: PreparedAssertion | null,
    searchEmbedding: number[] | null,
  ): Promise<unknown> {
    switch (operation.op) {
      case "put_entity":
        return this.putEntity(client, principal, operation);
      case "put_artifact":
        if (!preparedArtifact) {
          throw new Error("Artifact preparation was not completed");
        }
        return this.putArtifact(client, principal, operation, preparedArtifact);
      case "assert":
        if (!preparedAssertion) {
          throw new Error("Assertion preparation was not completed");
        }
        return this.putAssertion(
          client,
          principal,
          operation,
          preparedAssertion,
        );
      case "resolve":
        return this.resolve(
          client,
          principal.tenantId,
          operation,
        );
      case "search":
        if (!searchEmbedding) {
          throw new Error("Search embedding was not prepared");
        }
        return this.search(
          client,
          principal.tenantId,
          operation,
          searchEmbedding,
        );
      case "add_lineage":
        return this.addLineage(client, principal, operation);
      case "explain":
        return this.explainTrace(
          client,
          principal.tenantId,
          operation.target,
          operation.maxDepth ?? 4,
        );
      default:
        return assertNever(operation);
    }
  }

  private async executeAgencyOperation(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: AgencyOperation,
  ): Promise<unknown> {
    switch (operation.op) {
      case "create_workflow":
        return this.createWorkflow(client, principal, operation);
      case "advance_workflow":
        return this.advanceWorkflow(client, principal, operation);
      case "request_effect":
        return this.requestEffect(client, principal, operation);
      case "record_effect_outcome":
        throw new KernelError(
          "unauthorized",
          "Effect outcomes are accepted only from the effect worker",
        );
      case "get_machine":
        return this.getMachineRecord(
          client,
          principal.tenantId,
          operation.instanceId,
        );
      case "list_effects":
        return this.listEffects(
          client,
          principal.tenantId,
          operation,
        );
      default:
        return assertNever(operation);
    }
  }

  private async executeRetailCompatibilityOperation(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: RetailCompatibilityOperation,
  ): Promise<unknown> {
    switch (operation.op) {
      case "seed_inventory":
        return this.seedInventory(client, principal, operation);
      case "reserve_inventory":
        return this.reserveInventory(client, principal, operation);
      case "request_payment":
        return this.requestPayment(client, principal, operation);
      case "record_payment_outcome":
        return this.recordPaymentOutcome(client, principal, operation);
      case "process_timers":
        return this.processTimers(client, principal, operation.asOf);
      default:
        return assertNever(operation);
    }
  }

  private async putEntity(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_entity" }>,
  ): Promise<JsonValue> {
    const result = await client.query<EntityRow>(
      `INSERT INTO agentic.entities (
         tenant_id, entity_id, entity_type, canonical_name
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, entity_id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         canonical_name = EXCLUDED.canonical_name
       RETURNING *`,
      [
        principal.tenantId,
        operation.entity.entityId,
        operation.entity.entityType,
        operation.entity.canonicalName,
      ],
    );
    const row = requiredRow(result.rows[0], "Entity was not persisted");
    return {
      tenantId: row.tenant_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      canonicalName: row.canonical_name,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async putArtifact(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_artifact" }>,
    prepared: PreparedArtifact,
  ): Promise<JsonValue> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`artifact\u001f${principal.tenantId}\u001f${prepared.artifactId}`],
    );
    const existing = await client.query<ArtifactRow>(
      `SELECT * FROM agentic.artifacts
       WHERE tenant_id = $1 AND artifact_id = $2
       FOR UPDATE`,
      [principal.tenantId, prepared.artifactId],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (
        prior.content_hash !== prepared.stored.contentHash ||
        prior.media_type !== operation.artifact.mediaType ||
        prior.source_identity !== operation.artifact.sourceIdentity
      ) {
        throw new KernelError(
          "conflict",
          `Artifact ${prepared.artifactId} is immutable`,
        );
      }
      return artifactMetadata(prior);
    }

    const observedAt = normalizeIsoTimestamp(
      operation.artifact.observedAt ?? new Date().toISOString(),
      "observedAt",
    );
    const result = await client.query<ArtifactRow>(
      `INSERT INTO agentic.artifacts (
         tenant_id, artifact_id, content_hash, media_type, storage_key,
         encryption_key_id, source_identity, observed_at, sensitivity,
         retention_policy, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING *`,
      [
        principal.tenantId,
        prepared.artifactId,
        prepared.stored.contentHash,
        operation.artifact.mediaType,
        prepared.stored.storageKey,
        prepared.stored.encryptionKeyId,
        operation.artifact.sourceIdentity,
        observedAt,
        operation.artifact.sensitivity ?? "internal",
        operation.artifact.retentionPolicy ?? "project",
      ],
    );
    return artifactMetadata(
      requiredRow(result.rows[0], "Artifact metadata was not persisted"),
    );
  }

  private async putAssertion(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "assert" }>,
    prepared: PreparedAssertion,
  ): Promise<AssertionRecord> {
    const input = operation.assertion;
    const perspective = input.perspective ?? "organization";
    const validFrom = normalizeIsoTimestamp(
      input.validFrom ?? new Date().toISOString(),
      "validFrom",
    );
    const validTo = input.validTo
      ? normalizeIsoTimestamp(input.validTo, "validTo")
      : null;
    if (validTo && validTo <= validFrom) {
      throw new KernelError(
        "invalid_input",
        "validTo must be later than validFrom",
      );
    }
    const strength = input.strength ?? { type: "none" };
    const assertionId = input.assertionId ?? `assertion_${randomUUID()}`;

    if (input.object.type === "entity") {
      const objectEntity = await client.query(
        `SELECT 1 FROM agentic.entities
         WHERE tenant_id = $1 AND entity_id = $2`,
        [principal.tenantId, input.object.value],
      );
      if (objectEntity.rowCount !== 1) {
        throw new KernelError("not_found", "Assertion object entity was not found");
      }
    }
    if (input.sourceArtifactId) {
      const artifact = await client.query(
        `SELECT 1 FROM agentic.artifacts
         WHERE tenant_id = $1 AND artifact_id = $2 AND status = 'active'`,
        [principal.tenantId, input.sourceArtifactId],
      );
      if (artifact.rowCount !== 1) {
        throw new KernelError(
          "not_found",
          "Assertion source artifact was not found",
        );
      }
    }

    const timeResult = await client.query<{ system_time: Date }>(
      "SELECT agentic.next_system_time() AS system_time",
    );
    const systemTime = requiredRow(
      timeResult.rows[0],
      "System time allocation failed",
    ).system_time;

    if (input.supersedesAssertionId) {
      const priorResult = await client.query<AssertionRow>(
        `SELECT * FROM agentic.assertions
         WHERE tenant_id = $1 AND assertion_id = $2
         FOR UPDATE`,
        [principal.tenantId, input.supersedesAssertionId],
      );
      const prior = requiredRow(
        priorResult.rows[0],
        "Superseded assertion was not found",
      );
      if (prior.system_to !== null) {
        throw new KernelError("conflict", "Assertion is already closed");
      }
      if (
        prior.subject_entity_id !== input.subjectEntityId ||
        prior.predicate !== input.predicate ||
        prior.perspective !== perspective
      ) {
        throw new KernelError(
          "conflict",
          "A superseding assertion must keep subject, predicate, and perspective",
        );
      }
      await client.query(
        `UPDATE agentic.assertions
         SET system_to = $1
         WHERE tenant_id = $2 AND assertion_id = $3`,
        [systemTime, principal.tenantId, input.supersedesAssertionId],
      );
    }

    const result = await client.query<AssertionRow>(
      `INSERT INTO agentic.assertions (
         tenant_id, assertion_id, subject_entity_id, predicate,
         object_type, object_json, object_key, object_entity_id, kind,
         perspective, valid_from, valid_to, system_from, strength_type,
         strength_json, authority, status, source_artifact_id, basis_json,
         supersedes_assertion_id, search_text, embedding, embedding_model,
         embedding_version, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22::vector, $23, $24, $25
       )
       RETURNING *`,
      [
        principal.tenantId,
        assertionId,
        input.subjectEntityId,
        input.predicate,
        input.object.type,
        input.object,
        stableStringify(input.object),
        input.object.type === "entity" ? input.object.value : null,
        input.kind,
        perspective,
        validFrom,
        validTo,
        systemTime,
        strength.type,
        strength,
        input.authority ?? 50,
        input.status ?? "active",
        input.sourceArtifactId ?? null,
        input.basis === undefined ? null : stableStringify(input.basis),
        input.supersedesAssertionId ?? null,
        prepared.persistedSearchText,
        vectorToSql(prepared.embedding),
        this.activeEmbeddingSpace.model,
        this.activeEmbeddingSpace.version,
        principal.principalId,
      ],
    );
    const row = requiredRow(result.rows[0], "Assertion was not persisted");
    if (input.sourceArtifactId) {
      await this.insertLineage(client, principal, {
        relation: "evidence_for",
        from: {
          type: "artifact",
          artifactId: input.sourceArtifactId,
        },
        to: { type: "assertion", assertionId },
      });
    }
    return mapAssertion(row);
  }

  private async resolve(
    client: PoolClient,
    tenantId: string,
    operation: Extract<AgentOperation, { op: "resolve" }>,
  ): Promise<ResolutionResult> {
    const current = await currentSystemTime(client);
    const systemAt = normalizeIsoTimestamp(
      operation.systemAt ?? current,
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      operation.validAt ?? systemAt,
      "validAt",
    );
    const values: unknown[] = [
      tenantId,
      operation.subjectEntityId,
      operation.predicate,
      systemAt,
      validAt,
    ];
    const perspectiveClause = operation.perspective
      ? `AND perspective = $${values.push(operation.perspective)}`
      : "";
    const result = await client.query<AssertionRow>(
      `SELECT * FROM agentic.assertions
       WHERE tenant_id = $1
         AND subject_entity_id = $2
         AND predicate = $3
         AND system_from <= $4
         AND (system_to IS NULL OR system_to > $4)
         AND valid_from <= $5
         AND (valid_to IS NULL OR valid_to > $5)
         AND status NOT IN ('quarantined', 'deleted')
         ${perspectiveClause}
       ORDER BY authority DESC, system_from DESC`,
      values,
    );
    const candidates = result.rows.map(mapAssertion);
    return resolveCandidates(
      candidates,
      operation.policy,
      validAt,
      systemAt,
    );
  }

  private async search(
    client: PoolClient,
    tenantId: string,
    operation: Extract<AgentOperation, { op: "search" }>,
    embedding: number[],
  ): Promise<SearchHit[]> {
    const current = await currentSystemTime(client);
    const systemAt = normalizeIsoTimestamp(
      operation.systemAt ?? current,
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      operation.validAt ?? systemAt,
      "validAt",
    );
    const resultLimit = operation.limit ?? 20;
    const candidateLimit = Math.max(
      this.config.searchCandidateLimit,
      Math.min(5_000, resultLimit * 4),
    );
    const efSearch = Math.max(
      this.config.hnswEfSearch,
      Math.min(1_000, candidateLimit),
    );
    await client.query(
      `SELECT
         set_config('hnsw.iterative_scan', 'strict_order', TRUE),
         set_config('hnsw.ef_search', $1, TRUE),
         set_config('hnsw.max_scan_tuples', $2, TRUE)`,
      [String(efSearch), String(this.config.hnswMaxScanTuples)],
    );
    const query = buildHybridSearchQuery({
      tenantId,
      ...this.activeEmbeddingSpace,
      embedding,
      operation,
      systemAt,
      validAt,
      candidateLimit,
      resultLimit,
    });
    const result = await client.query<
      AssertionRow & {
        lexical_score: number;
        vector_score: number;
        combined_score: number;
        graph_distance: number | null;
      }
    >(query);
    return result.rows.map((row) => ({
      assertion: mapAssertion(row),
      lexicalScore: roundScore(row.lexical_score),
      vectorScore: roundScore(row.vector_score),
      combinedScore: roundScore(row.combined_score),
      graphDistance: row.graph_distance,
    }));
  }

  private async createWorkflow(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "create_workflow" }>,
  ): Promise<WorkflowRecord> {
    if (operation.workflowType === "retail_order") {
      throw new KernelError(
        "invalid_input",
        "retail_order is reserved for the retail workflow",
      );
    }
    if (operation.instanceId.startsWith("order:")) {
      throw new KernelError(
        "invalid_input",
        "The order: identifier namespace is reserved for retail workflows",
      );
    }
    const time = await nextSystemTime(client);
    const result = await client.query<WorkflowRow>(
      `INSERT INTO agentic.machine_instances (
         tenant_id, instance_id, machine_type, state, data_json, revision,
         terminal, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 1, FALSE, $6, $6)
       ON CONFLICT (tenant_id, instance_id) DO NOTHING
       RETURNING *`,
      [
        principal.tenantId,
        operation.instanceId,
        operation.workflowType,
        operation.initialState,
        stableStringify(operation.data),
        time,
      ],
    );
    const created = result.rows[0];
    if (!created) {
      throw new KernelError(
        "conflict",
        `Workflow ${operation.instanceId} already exists`,
      );
    }
    await this.appendHistory(
      client,
      principal.tenantId,
      operation.instanceId,
      1,
      "create_workflow",
      "uninitialized",
      operation.initialState,
      operation.data,
      time,
    );
    return mapWorkflow(created);
  }

  private async advanceWorkflow(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "advance_workflow" }>,
  ): Promise<WorkflowRecord> {
    const workflow = await this.getWorkflow(
      client,
      principal.tenantId,
      operation.instanceId,
      true,
    );
    if (workflow.terminal) {
      throw new KernelError(
        "conflict",
        `Workflow ${workflow.instanceId} is terminal`,
      );
    }
    if (
      workflow.revision !== operation.expectedRevision ||
      workflow.state !== operation.expectedState
    ) {
      throw new KernelError(
        "conflict",
        `Workflow ${workflow.instanceId} changed before ${operation.transitionName}`,
      );
    }
    const nextRevision = workflow.revision + 1;
    const time = await nextSystemTime(client);
    const result = await client.query<WorkflowRow>(
      `UPDATE agentic.machine_instances
       SET state = $1, data_json = $2, revision = $3, terminal = $4,
           updated_at = $5
       WHERE tenant_id = $6 AND instance_id = $7
         AND revision = $8 AND state = $9
         AND terminal = FALSE AND machine_type <> 'retail_order'
       RETURNING *`,
      [
        operation.toState,
        stableStringify(operation.data),
        nextRevision,
        operation.terminal ?? false,
        time,
        principal.tenantId,
        workflow.instanceId,
        operation.expectedRevision,
        operation.expectedState,
      ],
    );
    const updated = requiredRow(
      result.rows[0],
      "Workflow transition was not committed",
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      workflow.instanceId,
      nextRevision,
      operation.transitionName,
      workflow.state,
      operation.toState,
      operation.data,
      time,
    );
    return mapWorkflow(updated);
  }

  private async requestEffect(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "request_effect" }>,
  ): Promise<EffectRecord> {
    validateEffectTarget(operation.target, this.config.effectAllowedHosts);
    if (!operation.statusUrl) {
      throw new KernelError(
        "invalid_input",
        "statusUrl is required in the production profile",
      );
    }
    validateEffectTarget(operation.statusUrl, this.config.effectAllowedHosts);
    const keyResult = await client.query<{ effect_budget_currency: string }>(
      `SELECT effect_budget_currency
       FROM agentic_auth.api_keys
       WHERE key_id = $1 AND tenant_id = $2`,
      [principal.keyId, principal.tenantId],
    );
    const keyCurrency = requiredRow(
      keyResult.rows[0],
      "Effect authorization key was not found",
    ).effect_budget_currency;
    const amount = operation.budgetAmount ?? "0";
    const currency = operation.currency ?? keyCurrency;
    const providerNamespace = effectProviderNamespace(operation.target);
    const requestIdentity: EffectRequestIdentity = {
      instanceId: operation.instanceId,
      originatingRevision: operation.expectedRevision,
      effectName: operation.effectName,
      effectType: operation.effectType,
      target: operation.target,
      statusUrl: operation.statusUrl,
      request: operation.request,
      amount,
      currency,
      decisionAssertionId: operation.decisionAssertionId,
      policyAssertionId: operation.policyAssertionId,
    };
    const requestHash = effectRequestHash(principal, requestIdentity);
    const replay = await this.lockEffectIdempotency(
      client,
      principal,
      providerNamespace,
      operation.idempotencyKey,
      requestIdentity,
      requestHash,
    );
    if (replay) {
      return mapEffect(replay);
    }
    const workflow = await this.getWorkflow(
      client,
      principal.tenantId,
      operation.instanceId,
      true,
    );
    if (workflow.terminal) {
      throw new KernelError(
        "conflict",
        `Workflow ${workflow.instanceId} is terminal`,
      );
    }
    if (workflow.revision !== operation.expectedRevision) {
      throw new KernelError(
        "conflict",
        `Workflow ${workflow.instanceId} revision changed`,
      );
    }
    const time = await nextSystemTime(client);
    await this.requireCurrentAssertionKind(
      client,
      principal.tenantId,
      operation.decisionAssertionId,
      "decision",
      time,
    );
    await this.requireCurrentAssertionKind(
      client,
      principal.tenantId,
      operation.policyAssertionId,
      "directive",
      time,
    );
    const budget = await client.query(
      `UPDATE agentic_auth.api_keys
       SET effect_budget_reserved = effect_budget_reserved + $1
       WHERE key_id = $2
         AND tenant_id = $3
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND ('*' = ANY(purposes) OR $4 = ANY(purposes))
         AND effect_budget_spent + effect_budget_reserved + $1
           <= effect_budget_limit
         AND effect_budget_currency = $5`,
      [
        amount,
        principal.keyId,
        principal.tenantId,
        principal.purpose,
        currency,
      ],
    );
    if (budget.rowCount !== 1) {
      throw new KernelError(
        "unauthorized",
        "Effect authorization expired, was revoked, or exceeded its budget",
      );
    }
    const effectId = deterministicId(
      "effect",
      principal.tenantId,
      workflow.instanceId,
      String(workflow.revision),
      operation.effectName,
    );
    const result = await client.query<EffectRow>(
      `INSERT INTO agentic.effect_intents (
         tenant_id, effect_id, instance_id, originating_revision,
         effect_name, effect_type, outcome_handler, target_url, status_url,
         request_json, idempotency_key, authorizing_key_id, purpose,
         budget_amount, currency, decision_assertion_id,
         policy_assertion_id, provider_namespace, request_hash,
         status, attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'none', $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, 'planned', 0, $19
       )
       RETURNING *`,
      [
        principal.tenantId,
        effectId,
        workflow.instanceId,
        workflow.revision,
        operation.effectName,
        operation.effectType,
        operation.target,
        operation.statusUrl,
        stableStringify(operation.request),
        operation.idempotencyKey,
        principal.keyId,
        principal.purpose,
        amount,
        currency,
        operation.decisionAssertionId,
        operation.policyAssertionId,
        providerNamespace,
        requestHash,
        time,
      ],
    );
    const effectEndpoint: LineageEndpoint = { type: "effect", effectId };
    await this.insertLineage(client, principal, {
      relation: "authorizes",
      from: {
        type: "assertion",
        assertionId: operation.decisionAssertionId,
      },
      to: effectEndpoint,
    });
    await this.insertLineage(client, principal, {
      relation: "governs",
      from: {
        type: "assertion",
        assertionId: operation.policyAssertionId,
      },
      to: effectEndpoint,
    });
    await this.insertLineage(client, principal, {
      relation: "produces",
      from: {
        type: "workflow_revision",
        instanceId: workflow.instanceId,
        revision: workflow.revision,
      },
      to: effectEndpoint,
    });
    return mapEffect(
      requiredRow(result.rows[0], "Effect intent was not persisted"),
    );
  }

  private async addLineage(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "add_lineage" }>,
  ): Promise<LineageEdgeRecord> {
    return this.insertLineage(client, principal, operation);
  }

  private async explainTrace(
    client: PoolClient,
    tenantId: string,
    root: LineageEndpoint,
    requestedDepth: number,
  ): Promise<TraceExplanation> {
    const maxDepth = normalizeTraceDepth(requestedDepth);
    let frontier: LineageEndpoint[] = [root];
    const queued = new Set([traceEndpointKey(root)]);
    const includedEdges = new Map<string, LineageEdgeRecord>();
    const nodes: TraceNode[] = [];
    let truncated = false;

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const loaded = await this.loadTraceNodes(
        client,
        tenantId,
        frontier,
        depth,
      );
      nodes.push(...loaded.nodes);
      if (loaded.truncated) {
        truncated = true;
      }
      if (depth >= maxDepth || includedEdges.size >= 2_000) {
        if (includedEdges.size >= 2_000) {
          truncated = true;
        }
        continue;
      }
      const edgeResult = await this.lineageForEndpoints(
        client,
        tenantId,
        frontier,
      );
      if (edgeResult.truncated) {
        truncated = true;
      }
      const nextFrontier: LineageEndpoint[] = [];
      for (const edge of edgeResult.edges) {
        if (includedEdges.has(edge.edgeId)) {
          continue;
        }
        if (includedEdges.size >= 2_000) {
          truncated = true;
          break;
        }
        const newNeighbors = [edge.from, edge.to].filter(
          (neighbor) => !queued.has(traceEndpointKey(neighbor)),
        );
        if (queued.size + newNeighbors.length > 500) {
          truncated = true;
          continue;
        }
        includedEdges.set(edge.edgeId, edge);
        for (const neighbor of newNeighbors) {
          const key = traceEndpointKey(neighbor);
          queued.add(key);
          nextFrontier.push(neighbor);
        }
      }
      frontier = nextFrontier;
    }

    return {
      root,
      maxDepth,
      truncated,
      nodes: nodes.sort(
        (left, right) =>
          left.depth - right.depth ||
          traceEndpointKey(left.ref).localeCompare(
            traceEndpointKey(right.ref),
          ),
      ),
      edges: [...includedEdges.values()].sort((left, right) =>
        left.edgeId.localeCompare(right.edgeId),
      ),
    };
  }

  private async lineageForEndpoints(
    client: PoolClient,
    tenantId: string,
    endpoints: LineageEndpoint[],
  ): Promise<{
    edges: LineageEdgeRecord[];
    truncated: boolean;
  }> {
    const artifactIds = endpoints.flatMap((endpoint) =>
      endpoint.type === "artifact" ? [endpoint.artifactId] : [],
    );
    const assertionIds = endpoints.flatMap((endpoint) =>
      endpoint.type === "assertion" ? [endpoint.assertionId] : [],
    );
    const effectIds = endpoints.flatMap((endpoint) =>
      endpoint.type === "effect" ? [endpoint.effectId] : [],
    );
    const workflowIds = endpoints.flatMap((endpoint) =>
      endpoint.type === "workflow_revision" ? [endpoint.instanceId] : [],
    );
    const workflowRevisions = endpoints.flatMap((endpoint) =>
      endpoint.type === "workflow_revision" ? [endpoint.revision] : [],
    );
    const result = await client.query<LineageRow>(
      `SELECT * FROM agentic.lineage_edges
       WHERE tenant_id = $1
         AND (
           from_artifact_id = ANY($2::TEXT[])
           OR to_artifact_id = ANY($2::TEXT[])
           OR from_assertion_id = ANY($3::TEXT[])
           OR to_assertion_id = ANY($3::TEXT[])
           OR from_effect_id = ANY($4::TEXT[])
           OR to_effect_id = ANY($4::TEXT[])
           OR EXISTS (
             SELECT 1
             FROM unnest($5::TEXT[], $6::BIGINT[])
               AS requested(instance_id, revision)
             WHERE (
               lineage_edges.from_instance_id = requested.instance_id
               AND lineage_edges.from_revision = requested.revision
             )
             OR (
               lineage_edges.to_instance_id = requested.instance_id
               AND lineage_edges.to_revision = requested.revision
             )
           )
         )
       ORDER BY created_at, edge_id
       LIMIT 2001`,
      [
        tenantId,
        artifactIds,
        assertionIds,
        effectIds,
        workflowIds,
        workflowRevisions,
      ],
    );
    return {
      edges: result.rows.slice(0, 2_000).map(mapLineage),
      truncated: result.rows.length > 2_000,
    };
  }

  private async loadTraceNodes(
    client: PoolClient,
    tenantId: string,
    refs: LineageEndpoint[],
    depth: number,
  ): Promise<{ nodes: TraceNode[]; truncated: boolean }> {
    const artifactRefs = refs.filter(
      (ref): ref is Extract<LineageEndpoint, { type: "artifact" }> =>
        ref.type === "artifact",
    );
    const assertionRefs = refs.filter(
      (ref): ref is Extract<LineageEndpoint, { type: "assertion" }> =>
        ref.type === "assertion",
    );
    const workflowRefs = refs.filter(
      (
        ref,
      ): ref is Extract<LineageEndpoint, { type: "workflow_revision" }> =>
        ref.type === "workflow_revision",
    );
    const effectRefs = refs.filter(
      (ref): ref is Extract<LineageEndpoint, { type: "effect" }> =>
        ref.type === "effect",
    );
    const nodes = new Map<string, TraceNode>();
    let truncated = false;

    if (artifactRefs.length > 0) {
      const result = await client.query<ArtifactRow>(
        `SELECT * FROM agentic.artifacts
         WHERE tenant_id = $1 AND artifact_id = ANY($2::TEXT[])`,
        [tenantId, artifactRefs.map((ref) => ref.artifactId)],
      );
      for (const row of result.rows) {
        const ref: LineageEndpoint = {
          type: "artifact",
          artifactId: row.artifact_id,
        };
        nodes.set(traceEndpointKey(ref), {
          ref,
          depth,
          label: `Artifact from ${row.source_identity}`,
          record: artifactMetadata(row),
        });
      }
    }

    if (assertionRefs.length > 0) {
      const result = await client.query<AssertionRow>(
        `SELECT * FROM agentic.assertions
         WHERE tenant_id = $1 AND assertion_id = ANY($2::TEXT[])`,
        [tenantId, assertionRefs.map((ref) => ref.assertionId)],
      );
      for (const row of result.rows) {
        const assertion = mapAssertion(row);
        const ref: LineageEndpoint = {
          type: "assertion",
          assertionId: assertion.assertionId,
        };
        nodes.set(traceEndpointKey(ref), {
          ref,
          depth,
          label:
            `${assertion.kind} ${assertion.predicate} = ` +
            typedValueText(assertion.object),
          record: summarizeTraceJson(toJsonValue(assertion)),
        });
      }
    }

    if (workflowRefs.length > 0) {
      const result = await client.query<TraceHistoryRow>(
        `SELECT history.*, machine.machine_type
         FROM agentic.machine_history history
         JOIN agentic.machine_instances machine
           ON machine.tenant_id = history.tenant_id
          AND machine.instance_id = history.instance_id
         JOIN unnest($2::TEXT[], $3::BIGINT[])
           AS requested(instance_id, revision)
           ON requested.instance_id = history.instance_id
          AND requested.revision = history.revision
         WHERE history.tenant_id = $1`,
        [
          tenantId,
          workflowRefs.map((ref) => ref.instanceId),
          workflowRefs.map((ref) => ref.revision),
        ],
      );
      for (const row of result.rows) {
        const ref: LineageEndpoint = {
          type: "workflow_revision",
          instanceId: row.instance_id,
          revision: Number(row.revision),
        };
        nodes.set(traceEndpointKey(ref), {
          ref,
          depth,
          label:
            `${row.machine_type} ${row.transition_name}: ` +
            `${row.prior_state} -> ${row.new_state}`,
          record: summarizeTraceJson({
            instanceId: row.instance_id,
            revision: Number(row.revision),
            eventId: row.event_id,
            workflowType: row.machine_type,
            transitionName: row.transition_name,
            priorState: row.prior_state,
            newState: row.new_state,
            data: row.data_json,
            createdAt: row.created_at.toISOString(),
          }),
        });
      }
    }

    if (effectRefs.length > 0) {
      const effectIds = effectRefs.map((ref) => ref.effectId);
      const effects = await client.query<EffectRow>(
        `SELECT * FROM agentic.effect_intents
         WHERE tenant_id = $1 AND effect_id = ANY($2::TEXT[])`,
        [tenantId, effectIds],
      );
      const attempts = await client.query<TraceAttemptRow>(
        `WITH ranked AS (
           SELECT
             effect_id,
             attempt_number,
             status,
             response_status,
             outcome_json,
             created_at,
             count(*) OVER (PARTITION BY effect_id)::TEXT AS total_count,
             row_number() OVER (
               PARTITION BY effect_id ORDER BY attempt_number
             ) AS first_rank,
             row_number() OVER (
               PARTITION BY effect_id ORDER BY attempt_number DESC
             ) AS last_rank
           FROM agentic.effect_attempts
           WHERE tenant_id = $1 AND effect_id = ANY($2::TEXT[])
         )
         SELECT
           effect_id,
           attempt_number,
           status,
           response_status,
           outcome_json,
           created_at,
           total_count
         FROM ranked
         WHERE first_rank <= 10 OR last_rank <= 10
         ORDER BY effect_id, attempt_number`,
        [tenantId, effectIds],
      );
      const attemptsByEffect = new Map<string, TraceAttemptRow[]>();
      for (const attempt of attempts.rows) {
        const values = attemptsByEffect.get(attempt.effect_id) ?? [];
        values.push(attempt);
        attemptsByEffect.set(attempt.effect_id, values);
      }
      for (const row of effects.rows) {
        const effect = mapEffect(row);
        const effectAttempts = attemptsByEffect.get(effect.effectId) ?? [];
        const attemptCount = Number(
          effectAttempts[0]?.total_count ?? "0",
        );
        if (attemptCount > effectAttempts.length) {
          truncated = true;
        }
        const ref: LineageEndpoint = {
          type: "effect",
          effectId: effect.effectId,
        };
        nodes.set(traceEndpointKey(ref), {
          ref,
          depth,
          label: `${effect.effectType} effect ${effect.status}`,
          record: {
            effect: summarizeTraceJson(toJsonValue(effect), 4_000),
            attemptCount,
            attemptsTruncated: attemptCount > effectAttempts.length,
            attempts: effectAttempts.map((attempt) => ({
              attemptNumber: attempt.attempt_number,
              status: attempt.status,
              responseStatus: attempt.response_status,
              outcome:
                attempt.outcome_json === null
                  ? null
                  : summarizeTraceJson(attempt.outcome_json, 1_000),
              createdAt: attempt.created_at.toISOString(),
            })),
          },
        });
      }
    }

    return {
      nodes: refs.map((ref) => {
        const node = nodes.get(traceEndpointKey(ref));
        if (!node) {
          throw new KernelError(
            "not_found",
            `Trace node ${traceEndpointKey(ref)} was not found`,
          );
        }
        return node;
      }),
      truncated,
    };
  }

  private async seedInventory(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "seed_inventory" }>,
  ): Promise<InventoryRecord> {
    const existing = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3
       FOR UPDATE`,
      [principal.tenantId, operation.sku, operation.location],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (
        prior.quantity_on_hand !== operation.quantityOnHand ||
        prior.quantity_reserved !== 0
      ) {
        throw new KernelError(
          "conflict",
          "Existing inventory cannot be reset through seed_inventory",
        );
      }
      return mapInventory(prior);
    }
    const time = await nextSystemTime(client);
    const result = await client.query<InventoryRow>(
      `INSERT INTO agentic.inventory (
         tenant_id, sku, location, quantity_on_hand, quantity_reserved,
         version, updated_at
       ) VALUES ($1, $2, $3, $4, 0, 1, $5)
       RETURNING *`,
      [
        principal.tenantId,
        operation.sku,
        operation.location,
        operation.quantityOnHand,
        time,
      ],
    );
    return mapInventory(
      requiredRow(result.rows[0], "Inventory was not persisted"),
    );
  }

  private async reserveInventory(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "reserve_inventory" }>,
  ): Promise<JsonValue> {
    const inventoryResult = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3
       FOR UPDATE`,
      [principal.tenantId, operation.sku, operation.location],
    );
    const inventory = requiredRow(
      inventoryResult.rows[0],
      "Inventory was not found",
    );
    const allocatable =
      inventory.quantity_on_hand - inventory.quantity_reserved;
    if (allocatable < operation.quantity) {
      throw new KernelError(
        "conflict",
        `Only ${allocatable} units are allocatable`,
      );
    }
    const instanceId = `order:${operation.orderId}`;
    const existing = await client.query(
      `SELECT 1 FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2`,
      [principal.tenantId, instanceId],
    );
    if (existing.rowCount !== 0) {
      throw new KernelError("conflict", `Order ${operation.orderId} exists`);
    }

    const time = await nextSystemTime(client);
    const expiresAt = new Date(
      time.getTime() + operation.holdSeconds * 1_000,
    );
    const data: OrderData = {
      orderId: operation.orderId,
      sku: operation.sku,
      location: operation.location,
      quantity: operation.quantity,
      reservationExpiresAt: expiresAt.toISOString(),
    };
    await client.query(
      `UPDATE agentic.inventory
       SET quantity_reserved = quantity_reserved + $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5`,
      [
        operation.quantity,
        time,
        principal.tenantId,
        operation.sku,
        operation.location,
      ],
    );
    const machineResult = await client.query<MachineRow>(
      `INSERT INTO agentic.machine_instances (
         tenant_id, instance_id, machine_type, state, data_json, revision,
         created_at, updated_at
       ) VALUES ($1, $2, 'retail_order', 'reserved', $3, 1, $4, $4)
       RETURNING *`,
      [principal.tenantId, instanceId, data, time],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      instanceId,
      1,
      "reserve_inventory",
      "new",
      "reserved",
      stableStringify(data),
      time,
    );
    const timerId = deterministicId(
      "timer",
      principal.tenantId,
      instanceId,
      "1",
      "reservation_expiry",
    );
    await client.query(
      `INSERT INTO agentic.timers (
         tenant_id, timer_id, instance_id, originating_revision, timer_name,
         due_at, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 1, 'reservation_expiry', $4, 'pending', $5, $5)`,
      [principal.tenantId, timerId, instanceId, expiresAt, time],
    );
    return {
      machine: toJsonValue(
        mapMachine(
          requiredRow(machineResult.rows[0], "Order machine was not persisted"),
        ),
      ),
      inventory: toJsonValue(
        await this.getInventory(
          client,
          principal.tenantId,
          operation.sku,
          operation.location,
        ),
      ),
      timerId,
    };
  }

  private async requestPayment(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "request_payment" }>,
  ): Promise<EffectRecord> {
    validateEffectTarget(operation.paymentTarget, this.config.effectAllowedHosts);
    if (!operation.paymentStatusUrl) {
      throw new KernelError(
        "invalid_input",
        "paymentStatusUrl is required in the production profile",
      );
    }
    validateEffectTarget(
      operation.paymentStatusUrl,
      this.config.effectAllowedHosts,
    );
    const machineResult = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [principal.tenantId, operation.instanceId],
    );
    const machine = mapMachine(
      requiredRow(machineResult.rows[0], "Order machine was not found"),
    );
    const effectName = "capture_payment";
    const request: JsonValue = {
      orderId: machine.data.orderId,
      amount: operation.amount,
      currency: operation.currency,
    };
    const providerNamespace = effectProviderNamespace(
      operation.paymentTarget,
    );
    const requestIdentity: EffectRequestIdentity = {
      instanceId: machine.instanceId,
      effectName,
      effectType: "payment.capture",
      target: operation.paymentTarget,
      statusUrl: operation.paymentStatusUrl,
      request,
      amount: operation.amount,
      currency: operation.currency,
      decisionAssertionId: null,
      policyAssertionId: null,
    };
    const requestHash = effectRequestHash(principal, requestIdentity);
    const replay = await this.lockEffectIdempotency(
      client,
      principal,
      providerNamespace,
      operation.idempotencyKey,
      requestIdentity,
      requestHash,
    );
    if (replay) {
      return mapEffect(replay);
    }
    if (machine.state !== "reserved") {
      throw new KernelError(
        "conflict",
        `Payment can only start from reserved, not ${machine.state}`,
      );
    }
    const time = await nextSystemTime(client);
    if (time.toISOString() >= machine.data.reservationExpiresAt) {
      throw new KernelError("conflict", "The inventory reservation has expired");
    }
    const budget = await client.query(
      `UPDATE agentic_auth.api_keys
       SET effect_budget_reserved = effect_budget_reserved + $1
       WHERE key_id = $2
         AND tenant_id = $3
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND (
           '*' = ANY(purposes)
           OR $4 = ANY(purposes)
         )
         AND effect_budget_spent + effect_budget_reserved + $1
           <= effect_budget_limit
         AND effect_budget_currency = $5`,
      [
        operation.amount,
        principal.keyId,
        principal.tenantId,
        principal.purpose,
        operation.currency,
      ],
    );
    if (budget.rowCount !== 1) {
      throw new KernelError(
        "unauthorized",
        "Effect authorization expired, was revoked, or exceeded its budget",
      );
    }
    const nextRevision = machine.revision + 1;
    const effectId = deterministicId(
      "effect",
      principal.tenantId,
      machine.instanceId,
      String(nextRevision),
      effectName,
    );
    await client.query(
      `UPDATE agentic.machine_instances
       SET state = 'payment_pending', revision = $1, updated_at = $2
       WHERE tenant_id = $3 AND instance_id = $4`,
      [nextRevision, time, principal.tenantId, machine.instanceId],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      machine.instanceId,
      nextRevision,
      "request_payment",
      machine.state,
      "payment_pending",
      machine.data,
      time,
    );
    await client.query(
      `UPDATE agentic.timers
       SET status = 'cancelled', updated_at = $1
       WHERE tenant_id = $2 AND instance_id = $3 AND status = 'pending'`,
      [time, principal.tenantId, machine.instanceId],
    );
    const effectResult = await client.query<EffectRow>(
      `INSERT INTO agentic.effect_intents (
         tenant_id, effect_id, instance_id, originating_revision, effect_name,
         effect_type, outcome_handler, target_url, request_json,
         idempotency_key, status_url,
         authorizing_key_id, purpose, budget_amount, currency, status,
         decision_assertion_id, policy_assertion_id, provider_namespace,
         request_hash, attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'payment.capture',
         'retail_order_payment', $6, $7, $8, $9,
         $10, $11, $12, $13, 'planned', NULL, NULL, $14, $15, 0, $16
       )
       RETURNING *`,
      [
        principal.tenantId,
        effectId,
        machine.instanceId,
        nextRevision,
        effectName,
        operation.paymentTarget,
        stableStringify(request),
        operation.idempotencyKey,
        operation.paymentStatusUrl,
        principal.keyId,
        principal.purpose,
        operation.amount,
        operation.currency,
        providerNamespace,
        requestHash,
        time,
      ],
    );
    return mapEffect(
      requiredRow(effectResult.rows[0], "Effect intent was not persisted"),
    );
  }

  private async recordPaymentOutcome(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "record_payment_outcome" }>,
  ): Promise<MachineRecord> {
    const effectResult = await client.query<EffectRow & {
      budget_amount: string;
      authorizing_key_id: string;
    }>(
      `SELECT * FROM agentic.effect_intents
       WHERE tenant_id = $1 AND effect_id = $2
       FOR UPDATE`,
      [principal.tenantId, operation.effectId],
    );
    const effectRow = requiredRow(
      effectResult.rows[0],
      "Effect intent was not found",
    );
    if (
      operation.status === "succeeded" &&
      !hasProviderReference(operation.outcome)
    ) {
      throw new KernelError(
        "invalid_input",
        "Successful payment outcomes require a providerReference",
      );
    }
    if (effectRow.status === "succeeded" || effectRow.status === "failed") {
      if (effectRow.status !== operation.status) {
        throw new KernelError(
          "conflict",
          `Effect is already terminal as ${effectRow.status}`,
        );
      }
      return this.getMachine(client, principal.tenantId, effectRow.instance_id);
    }
    const machineResult = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [principal.tenantId, effectRow.instance_id],
    );
    const machine = mapMachine(
      requiredRow(machineResult.rows[0], "Order machine was not found"),
    );
    if (machine.state !== "payment_pending") {
      throw new KernelError(
        "conflict",
        `Payment outcome cannot apply to ${machine.state}`,
      );
    }
    const time = await nextSystemTime(client);
    const nextAttempt = effectRow.attempt_count + 1;
    await client.query(
      `INSERT INTO agentic.effect_attempts (
         tenant_id, effect_id, attempt_number, lease_token, status,
         outcome_json, created_at
       ) VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6)`,
      [
        principal.tenantId,
        effectRow.effect_id,
        nextAttempt,
        operation.status,
        operation.outcome === undefined
          ? null
          : stableStringify(operation.outcome),
        time,
      ],
    );
    await client.query(
      `UPDATE agentic.effect_intents
       SET status = $1,
           attempt_count = $2,
           outcome_json = $3,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = $4
       WHERE tenant_id = $5 AND effect_id = $6`,
      [
        operation.status,
        nextAttempt,
        operation.outcome === undefined
          ? null
          : stableStringify(operation.outcome),
        time,
        principal.tenantId,
        effectRow.effect_id,
      ],
    );

    let nextState: MachineState = "payment_pending";
    if (operation.status === "succeeded") {
      await this.commitInventory(client, principal.tenantId, machine.data, time);
      await client.query(
        `UPDATE agentic_auth.api_keys
         SET effect_budget_reserved = effect_budget_reserved - $1,
             effect_budget_spent = effect_budget_spent + $1
         WHERE key_id = $2 AND tenant_id = $3`,
        [
          effectRow.budget_amount,
          effectRow.authorizing_key_id,
          principal.tenantId,
        ],
      );
      nextState = "confirmed";
    } else if (operation.status === "failed") {
      await this.releaseInventory(client, principal.tenantId, machine.data, time);
      await client.query(
        `UPDATE agentic_auth.api_keys
         SET effect_budget_reserved = effect_budget_reserved - $1
         WHERE key_id = $2 AND tenant_id = $3`,
        [
          effectRow.budget_amount,
          effectRow.authorizing_key_id,
          principal.tenantId,
        ],
      );
      nextState = "failed";
    }

    const nextRevision = machine.revision + 1;
    const updated = await client.query<MachineRow>(
      `UPDATE agentic.machine_instances
       SET state = $1, revision = $2, terminal = $3, updated_at = $4
       WHERE tenant_id = $5 AND instance_id = $6
       RETURNING *`,
      [
        nextState,
        nextRevision,
        nextState !== "payment_pending",
        time,
        principal.tenantId,
        machine.instanceId,
      ],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      machine.instanceId,
      nextRevision,
      `payment_${operation.status}`,
      machine.state,
      nextState,
      machine.data,
      time,
    );
    return mapMachine(
      requiredRow(updated.rows[0], "Order machine was not updated"),
    );
  }

  private async processTimers(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    asOfInput: string | undefined,
  ): Promise<MachineRecord[]> {
    if (asOfInput !== undefined) {
      throw new KernelError(
        "invalid_input",
        "Production timer processing uses database server time",
      );
    }
    const asOf = await currentSystemTime(client);
    const timers = await client.query<{
      timer_id: string;
      instance_id: string;
      timer_name: string;
    }>(
      `SELECT timer_id, instance_id, timer_name
       FROM agentic.timers
       WHERE tenant_id = $1 AND status = 'pending' AND due_at <= $2
       ORDER BY due_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
      [principal.tenantId, asOf],
    );
    const changed: MachineRecord[] = [];
    for (const timer of timers.rows) {
      const machine = await this.getMachine(
        client,
        principal.tenantId,
        timer.instance_id,
        true,
      );
      const time = await nextSystemTime(client);
      if (machine.state !== "reserved") {
        await client.query(
          `UPDATE agentic.timers
           SET status = 'cancelled', updated_at = $1
           WHERE tenant_id = $2 AND timer_id = $3`,
          [time, principal.tenantId, timer.timer_id],
        );
        continue;
      }
      await this.releaseInventory(client, principal.tenantId, machine.data, time);
      const nextRevision = machine.revision + 1;
      const updated = await client.query<MachineRow>(
        `UPDATE agentic.machine_instances
         SET state = 'cancelled', revision = $1, terminal = TRUE,
             updated_at = $2
         WHERE tenant_id = $3 AND instance_id = $4
         RETURNING *`,
        [nextRevision, time, principal.tenantId, machine.instanceId],
      );
      await client.query(
        `UPDATE agentic.timers
         SET status = 'fired', updated_at = $1
         WHERE tenant_id = $2 AND timer_id = $3`,
        [time, principal.tenantId, timer.timer_id],
      );
      await this.appendHistory(
        client,
        principal.tenantId,
        machine.instanceId,
        nextRevision,
        timer.timer_name,
        machine.state,
        "cancelled",
        machine.data,
        time,
      );
      changed.push(
        mapMachine(requiredRow(updated.rows[0], "Machine was not updated")),
      );
    }
    return changed;
  }

  private async getMachine(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
    forUpdate = false,
  ): Promise<MachineRecord> {
    const result = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, instanceId],
    );
    return mapMachine(requiredRow(result.rows[0], "Machine was not found"));
  }

  private async getMachineRecord(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
  ): Promise<MachineRecord | WorkflowRecord> {
    const result = await client.query<WorkflowRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2`,
      [tenantId, instanceId],
    );
    const row = requiredRow(result.rows[0], "Machine was not found");
    return row.machine_type === "retail_order"
      ? mapMachine(row)
      : mapWorkflow(row);
  }

  private async getWorkflow(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
    forUpdate = false,
  ): Promise<WorkflowRecord> {
    const result = await client.query<WorkflowRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, instanceId],
    );
    const row = requiredRow(result.rows[0], "Workflow was not found");
    if (row.machine_type === "retail_order") {
      throw new KernelError(
        "conflict",
        "Generic workflow operations cannot modify retail orders",
      );
    }
    return mapWorkflow(row);
  }

  private async getInventory(
    client: PoolClient,
    tenantId: string,
    sku: string,
    location: string,
  ): Promise<InventoryRecord> {
    const result = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3`,
      [tenantId, sku, location],
    );
    return mapInventory(requiredRow(result.rows[0], "Inventory was not found"));
  }

  private async listEffects(
    client: PoolClient,
    tenantId: string,
    operation: Extract<AgentOperation, { op: "list_effects" }>,
  ): Promise<EffectRecord[]> {
    if (operation.afterEffectId) {
      const cursorResult = await client.query<{ effect_id: string }>(
        `SELECT effect_id FROM agentic.effect_intents
         WHERE tenant_id = $1
           AND effect_id = $2
           AND ($3::TEXT IS NULL OR instance_id = $3)`,
        [
          tenantId,
          operation.afterEffectId,
          operation.instanceId ?? null,
        ],
      );
      if (!cursorResult.rows[0]) {
        throw new KernelError(
          "not_found",
          `Effect cursor ${operation.afterEffectId} was not found`,
        );
      }
    }
    const limit =
      operation.limit ?? (operation.afterEffectId ? 100 : undefined);
    const result = await client.query<EffectRow>(
      `SELECT * FROM agentic.effect_intents
       WHERE tenant_id = $1
         AND ($2::TEXT IS NULL OR instance_id = $2)
         AND (
           $3::TEXT IS NULL
           OR (created_at, effect_id) > (
             SELECT cursor.created_at, cursor.effect_id
             FROM agentic.effect_intents AS cursor
             WHERE cursor.tenant_id = $1
               AND cursor.effect_id = $3
           )
         )
       ORDER BY created_at, effect_id
       ${limit === undefined ? "" : "LIMIT $4"}`,
      [
        tenantId,
        operation.instanceId ?? null,
        operation.afterEffectId ?? null,
        ...(limit === undefined ? [] : [limit]),
      ],
    );
    return result.rows.map(mapEffect);
  }

  private async requireCurrentAssertionKind(
    client: PoolClient,
    tenantId: string,
    assertionId: string,
    kind: EpistemicKind,
    time: Date | string,
  ): Promise<AssertionRow> {
    const result = await client.query<AssertionRow>(
      `SELECT * FROM agentic.assertions
       WHERE tenant_id = $1 AND assertion_id = $2
         AND kind = $3 AND status = 'active'
         AND system_from <= $4
         AND (system_to IS NULL OR system_to > $4)
         AND valid_from <= $4
         AND (valid_to IS NULL OR valid_to > $4)`,
      [tenantId, assertionId, kind, time],
    );
    return requiredRow(
      result.rows[0],
      `Active ${kind} assertion ${assertionId} was not found`,
    );
  }

  private async lockEffectIdempotency(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    providerNamespace: string,
    idempotencyKey: string,
    request: EffectRequestIdentity,
    requestHash: string,
  ): Promise<EffectRow | null> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1),
         hashtext($2)
       )`,
      [principal.tenantId, `${providerNamespace}\n${idempotencyKey}`],
    );
    const result = await client.query<EffectRow>(
      `SELECT *
       FROM agentic.effect_intents
       WHERE tenant_id = $1
         AND provider_namespace = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [principal.tenantId, providerNamespace, idempotencyKey],
    );
    const existing = result.rows[0];
    if (!existing) {
      return null;
    }
    const legacyReplay =
      existing.request_hash.startsWith("legacy:") &&
      legacyEffectRequestMatches(existing, principal, request);
    if (existing.request_hash !== requestHash && !legacyReplay) {
      throw new KernelError(
        "conflict",
        `Provider idempotency key ${idempotencyKey} was already used for a different effect request`,
      );
    }
    return existing;
  }

  private async insertLineage(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    input: {
      relation: LineageRelation;
      from: LineageEndpoint;
      to: LineageEndpoint;
    },
  ): Promise<LineageEdgeRecord> {
    await this.validateLineage(client, principal.tenantId, input);
    const edgeId = deterministicId(
      "lineage",
      principal.tenantId,
      input.relation,
      stableStringify(input.from),
      stableStringify(input.to),
    );
    const from = lineageColumns(input.from);
    const to = lineageColumns(input.to);
    const result = await client.query<LineageRow>(
      `INSERT INTO agentic.lineage_edges (
         tenant_id, edge_id, relation,
         from_artifact_id, from_assertion_id, from_instance_id,
         from_revision, from_effect_id,
         to_artifact_id, to_assertion_id, to_instance_id,
         to_revision, to_effect_id, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14
       )
       ON CONFLICT (tenant_id, edge_id) DO UPDATE SET
         edge_id = EXCLUDED.edge_id
       RETURNING *`,
      [
        principal.tenantId,
        edgeId,
        input.relation,
        from.artifactId,
        from.assertionId,
        from.instanceId,
        from.revision,
        from.effectId,
        to.artifactId,
        to.assertionId,
        to.instanceId,
        to.revision,
        to.effectId,
        principal.principalId,
      ],
    );
    return mapLineage(
      requiredRow(result.rows[0], "Lineage edge was not persisted"),
    );
  }

  private async validateLineage(
    client: PoolClient,
    tenantId: string,
    input: {
      relation: LineageRelation;
      from: LineageEndpoint;
      to: LineageEndpoint;
    },
  ): Promise<void> {
    if (stableStringify(input.from) === stableStringify(input.to)) {
      throw new KernelError(
        "invalid_input",
        "Lineage cannot link a node to itself",
      );
    }
    await this.requireLineageEndpoint(client, tenantId, input.from);
    await this.requireLineageEndpoint(client, tenantId, input.to);
    const time = await currentSystemTime(client);
    switch (input.relation) {
      case "evidence_for":
        requireLineageTypes(input, "artifact", "assertion");
        return;
      case "supports":
      case "contradicts":
        requireLineageTypes(input, "assertion", "assertion");
        return;
      case "governs":
        if (
          input.from.type !== "assertion" ||
          (input.to.type !== "assertion" && input.to.type !== "effect")
        ) {
          throw new KernelError(
            "invalid_input",
            "governs requires an assertion source and assertion or effect target",
          );
        }
        await this.requireCurrentAssertionKind(
          client,
          tenantId,
          input.from.assertionId,
          "directive",
          time,
        );
        return;
      case "authorizes":
        if (
          input.from.type !== "assertion" ||
          input.to.type !== "effect"
        ) {
          throw new KernelError(
            "invalid_input",
            "authorizes requires assertion to effect",
          );
        }
        await this.requireCurrentAssertionKind(
          client,
          tenantId,
          input.from.assertionId,
          "decision",
          time,
        );
        return;
      case "produces":
        requireLineageTypes(input, "workflow_revision", "effect");
        return;
      case "verifies":
        requireLineageTypes(input, "effect", "assertion");
        if (input.to.type === "assertion") {
          await this.requireCurrentAssertionKind(
            client,
            tenantId,
            input.to.assertionId,
            "observation",
            time,
          );
        }
        return;
    }
  }

  private async requireLineageEndpoint(
    client: PoolClient,
    tenantId: string,
    endpoint: LineageEndpoint,
  ): Promise<void> {
    let result;
    switch (endpoint.type) {
      case "artifact":
        result = await client.query(
          `SELECT 1 FROM agentic.artifacts
           WHERE tenant_id = $1 AND artifact_id = $2`,
          [tenantId, endpoint.artifactId],
        );
        break;
      case "assertion":
        result = await client.query(
          `SELECT 1 FROM agentic.assertions
           WHERE tenant_id = $1 AND assertion_id = $2`,
          [tenantId, endpoint.assertionId],
        );
        break;
      case "workflow_revision":
        result = await client.query(
          `SELECT 1 FROM agentic.machine_history
           WHERE tenant_id = $1 AND instance_id = $2 AND revision = $3`,
          [tenantId, endpoint.instanceId, endpoint.revision],
        );
        break;
      case "effect":
        result = await client.query(
          `SELECT 1 FROM agentic.effect_intents
           WHERE tenant_id = $1 AND effect_id = $2`,
          [tenantId, endpoint.effectId],
        );
        break;
    }
    if (result.rowCount === 0) {
      throw new KernelError(
        "not_found",
        `Lineage ${endpoint.type} endpoint was not found`,
      );
    }
  }

  private async appendHistory(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
    revision: number,
    transitionName: string,
    priorState: string,
    nextState: string,
    data: JsonValue | OrderData,
    time: Date,
  ): Promise<void> {
    const eventId = deterministicId(
      "event",
      tenantId,
      instanceId,
      String(revision),
      transitionName,
    );
    await client.query(
      `INSERT INTO agentic.machine_history (
         tenant_id, instance_id, revision, event_id, transition_name,
         prior_state, new_state, data_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        instanceId,
        revision,
        eventId,
        transitionName,
        priorState,
        nextState,
        stableStringify(data),
        time,
      ],
    );
  }

  private async releaseInventory(
    client: PoolClient,
    tenantId: string,
    order: OrderData,
    time: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE agentic.inventory
       SET quantity_reserved = quantity_reserved - $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5
         AND quantity_reserved >= $1`,
      [order.quantity, time, tenantId, order.sku, order.location],
    );
    if (result.rowCount !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for release",
      );
    }
  }

  private async commitInventory(
    client: PoolClient,
    tenantId: string,
    order: OrderData,
    time: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE agentic.inventory
       SET quantity_on_hand = quantity_on_hand - $1,
           quantity_reserved = quantity_reserved - $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5
         AND quantity_on_hand >= $1
         AND quantity_reserved >= $1`,
      [order.quantity, time, tenantId, order.sku, order.location],
    );
    if (result.rowCount !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for commit",
      );
    }
  }

  private async recordReceipt(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    requestId: string,
    operation: string,
    result: JsonValue,
    evidenceManifest: JsonValue,
  ): Promise<IntentExecutionResult["receipt"]> {
    const resultHash = sha256(stableStringify(result));
    const receiptId = deterministicId(
      "receipt",
      principal.tenantId,
      principal.principalId,
      principal.purpose,
      requestId,
      operation,
      resultHash,
      stableStringify(evidenceManifest),
    );
    const time = await nextSystemTime(client);
    await client.query(
      `INSERT INTO agentic.execution_receipts (
         tenant_id, receipt_id, request_id, principal_id, purpose, operation,
         snapshot_time, evidence_manifest_json, result_hash, result_json,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7)`,
      [
        principal.tenantId,
        receiptId,
        requestId,
        principal.principalId,
        principal.purpose,
        operation,
        time,
        stableStringify(evidenceManifest),
        resultHash,
        stableStringify(result),
      ],
    );
    return {
      tenantId: principal.tenantId,
      receiptId,
      requestId,
      principalId: principal.principalId,
      purpose: principal.purpose,
      operation,
      snapshotTime: time.toISOString(),
      evidenceManifest,
      resultHash,
      result,
      createdAt: time.toISOString(),
    };
  }

  private async getIdempotency(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operationKey: string,
    requestHash: string,
  ): Promise<IntentExecutionResult | null> {
    const result = await client.query<IdempotencyRow>(
      `SELECT request_hash, result_json
       FROM agentic.idempotency_results
       WHERE tenant_id = $1 AND principal_id = $2 AND operation_key = $3`,
      [principal.tenantId, principal.principalId, operationKey],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (row.request_hash !== requestHash) {
      throw new KernelError(
        "conflict",
        `Idempotency key ${operationKey} was used for a different request`,
      );
    }
    return row.result_json;
  }

  private async lockIdempotency(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operationKey: string,
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        [
          principal.tenantId,
          principal.principalId,
          operationKey,
        ].join("\u001f"),
      ],
    );
  }

}

function verifyEnvelopePrincipal(
  authenticated: AuthenticatedPrincipal,
  supplied: {
    tenantId: string;
    principalId: string;
    purpose: string;
  },
): void {
  if (
    supplied.tenantId !== authenticated.tenantId ||
    supplied.principalId !== authenticated.principalId ||
    supplied.purpose !== authenticated.purpose
  ) {
    throw new KernelError(
      "unauthorized",
      "Intent principal must match the authenticated principal",
    );
  }
}

function mapAssertion(row: AssertionRow): AssertionRecord {
  return {
    tenantId: row.tenant_id,
    assertionId: row.assertion_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    object: row.object_json,
    kind: row.kind as EpistemicKind,
    perspective: row.perspective,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    systemFrom: row.system_from.toISOString(),
    systemTo: row.system_to?.toISOString() ?? null,
    strength: row.strength_json,
    authority: row.authority,
    status: row.status as AssertionRecord["status"],
    sourceArtifactId: row.source_artifact_id,
    basis: row.basis_json,
    supersedesAssertionId: row.supersedes_assertion_id,
    createdBy: row.created_by,
  };
}

function mapInventory(row: InventoryRow): InventoryRecord {
  return {
    tenantId: row.tenant_id,
    sku: row.sku,
    location: row.location,
    quantityOnHand: row.quantity_on_hand,
    quantityReserved: row.quantity_reserved,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMachine(row: MachineRow | WorkflowRow): MachineRecord {
  if (row.machine_type !== "retail_order" || !isOrderData(row.data_json)) {
    throw new KernelError(
      "conflict",
      `Machine ${row.instance_id} is not a retail order`,
    );
  }
  return {
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    machineType: "retail_order",
    state: row.state as MachineState,
    data: row.data_json,
    revision: Number(row.revision),
    terminal: row.terminal,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    machineType: row.machine_type,
    state: row.state,
    data: row.data_json,
    revision: Number(row.revision),
    terminal: row.terminal,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEffect(row: EffectRow): EffectRecord {
  return {
    tenantId: row.tenant_id,
    effectId: row.effect_id,
    instanceId: row.instance_id,
    originatingRevision: Number(row.originating_revision),
    effectName: row.effect_name,
    effectType: row.effect_type,
    outcomeHandler: row.outcome_handler as
      | "retail_order_payment"
      | "none",
    target: row.target_url,
    statusUrl: row.status_url,
    request: row.request_json,
    idempotencyKey: row.idempotency_key,
    decisionAssertionId: row.decision_assertion_id,
    policyAssertionId: row.policy_assertion_id,
    status: row.status as EffectRecord["status"],
    attemptCount: row.attempt_count,
    outcome: row.outcome_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapLineage(row: LineageRow): LineageEdgeRecord {
  return {
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    relation: row.relation as LineageRelation,
    from: lineageEndpointFromRow(row, "from"),
    to: lineageEndpointFromRow(row, "to"),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function lineageEndpointFromRow(
  row: LineageRow,
  side: "from" | "to",
): LineageEndpoint {
  const artifactId =
    side === "from" ? row.from_artifact_id : row.to_artifact_id;
  if (artifactId) {
    return { type: "artifact", artifactId };
  }
  const assertionId =
    side === "from" ? row.from_assertion_id : row.to_assertion_id;
  if (assertionId) {
    return { type: "assertion", assertionId };
  }
  const instanceId =
    side === "from" ? row.from_instance_id : row.to_instance_id;
  const revision =
    side === "from" ? row.from_revision : row.to_revision;
  if (instanceId && revision !== null) {
    return {
      type: "workflow_revision",
      instanceId,
      revision: Number(revision),
    };
  }
  const effectId =
    side === "from" ? row.from_effect_id : row.to_effect_id;
  if (effectId) {
    return { type: "effect", effectId };
  }
  throw new Error(`Lineage ${side} endpoint is invalid`);
}

function lineageColumns(endpoint: LineageEndpoint): {
  artifactId: string | null;
  assertionId: string | null;
  instanceId: string | null;
  revision: number | null;
  effectId: string | null;
} {
  return {
    artifactId: endpoint.type === "artifact" ? endpoint.artifactId : null,
    assertionId:
      endpoint.type === "assertion" ? endpoint.assertionId : null,
    instanceId:
      endpoint.type === "workflow_revision" ? endpoint.instanceId : null,
    revision:
      endpoint.type === "workflow_revision" ? endpoint.revision : null,
    effectId: endpoint.type === "effect" ? endpoint.effectId : null,
  };
}

function requireLineageTypes(
  input: {
    relation: LineageRelation;
    from: LineageEndpoint;
    to: LineageEndpoint;
  },
  fromType: LineageEndpoint["type"],
  toType: LineageEndpoint["type"],
): void {
  if (input.from.type !== fromType || input.to.type !== toType) {
    throw new KernelError(
      "invalid_input",
      `${input.relation} requires ${fromType} to ${toType}`,
    );
  }
}

function isOrderData(value: JsonValue | OrderData): value is OrderData {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.orderId === "string" &&
    typeof value.sku === "string" &&
    typeof value.location === "string" &&
    typeof value.quantity === "number" &&
    typeof value.reservationExpiresAt === "string"
  );
}

function artifactMetadata(row: ArtifactRow): JsonValue {
  return {
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    sourceIdentity: row.source_identity,
    observedAt: row.observed_at.toISOString(),
    sensitivity: row.sensitivity,
    retentionPolicy: row.retention_policy,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function resolveCandidates(
  candidates: AssertionRecord[],
  policy: ResolutionPolicy,
  validAt: string,
  systemAt: string,
): ResolutionResult {
  if (candidates.length === 0) {
    return {
      status: "unknown",
      selected: null,
      candidates: [],
      conflicts: [],
      policy,
      validAt,
      systemAt,
    };
  }
  const values = new Set(
    candidates.map((candidate) => stableStringify(candidate.object)),
  );
  if (values.size === 1) {
    return {
      status: "known",
      selected: chooseLatest(candidates),
      candidates,
      conflicts: [],
      policy,
      validAt,
      systemAt,
    };
  }
  if (policy === "none") {
    return {
      status: "conflicted",
      selected: null,
      candidates,
      conflicts: candidates,
      policy,
      validAt,
      systemAt,
    };
  }
  const selected =
    policy === "latest"
      ? chooseLatest(candidates)
      : chooseHighestAuthority(candidates);
  return {
    status: "resolved_with_conflict",
    selected,
    candidates,
    conflicts: candidates.filter(
      (candidate) =>
        stableStringify(candidate.object) !== stableStringify(selected.object),
    ),
    policy,
    validAt,
    systemAt,
  };
}

function chooseLatest(assertions: AssertionRecord[]): AssertionRecord {
  return requiredRow(
    [...assertions].sort((left, right) =>
      right.systemFrom.localeCompare(left.systemFrom),
    )[0],
    "No assertion was available",
  );
}

function chooseHighestAuthority(
  assertions: AssertionRecord[],
): AssertionRecord {
  return requiredRow(
    [...assertions].sort(
      (left, right) =>
        right.authority - left.authority ||
        right.systemFrom.localeCompare(left.systemFrom),
    )[0],
    "No assertion was available",
  );
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new KernelError("not_found", message);
  }
  return row;
}

async function nextSystemTime(client: PoolClient): Promise<Date> {
  const result = await client.query<{ system_time: Date }>(
    "SELECT agentic.next_system_time() AS system_time",
  );
  return requiredRow(
    result.rows[0],
    "System time allocation failed",
  ).system_time;
}

async function currentSystemTime(client: PoolClient): Promise<string> {
  const result = await client.query<{ system_time: Date }>(
    `SELECT GREATEST(clock_timestamp(), last_time) AS system_time
     FROM agentic.system_clock
     WHERE singleton = TRUE`,
  );
  return requiredRow(
    result.rows[0],
    "System time was unavailable",
  ).system_time.toISOString();
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(...parts).slice(0, 32)}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operation ${JSON.stringify(value)}`);
}

function effectProviderNamespace(target: string): string {
  return new URL(target).origin.toLowerCase();
}

function effectRequestHash(
  principal: AuthenticatedPrincipal,
  input: EffectRequestIdentity,
): string {
  return sha256(
    stableStringify({
      principalId: principal.principalId,
      purpose: principal.purpose,
      ...input,
    }),
  );
}

function legacyEffectRequestMatches(
  effect: EffectRow,
  principal: AuthenticatedPrincipal,
  request: EffectRequestIdentity,
): boolean {
  return (
    effect.instance_id === request.instanceId &&
    (
      request.originatingRevision === undefined ||
      Number(effect.originating_revision) === request.originatingRevision
    ) &&
    effect.effect_name === request.effectName &&
    effect.effect_type === request.effectType &&
    effect.target_url === request.target &&
    effect.status_url === request.statusUrl &&
    stableStringify(effect.request_json) === stableStringify(request.request) &&
    effect.authorizing_key_id === principal.keyId &&
    effect.purpose === principal.purpose &&
    Number(effect.budget_amount) === Number(request.amount) &&
    effect.currency === request.currency &&
    effect.decision_assertion_id === request.decisionAssertionId &&
    effect.policy_assertion_id === request.policyAssertionId
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validateEffectTarget(urlValue: string, allowedHosts: Set<string>): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new KernelError("invalid_input", "Effect target must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new KernelError("unauthorized", "Effect targets must use HTTPS");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new KernelError(
      "unauthorized",
      `Effect target host ${url.hostname} is not allowlisted`,
    );
  }
  if (url.username || url.password) {
    throw new KernelError(
      "invalid_input",
      "Effect target URLs cannot contain credentials",
    );
  }
}

function hasProviderReference(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.providerReference === "string" &&
    value.providerReference.length > 0
  );
}
