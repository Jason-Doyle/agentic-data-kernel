# Production Runbooks

## API is not ready

1. Check `/health/live`, then `/health/ready`.
2. Verify the process uses the restricted `agentic_app` role.
3. Run `migration-status` with the administrative connection.
4. Confirm the configured embedding model, version, and dimensions match the
   database.
5. Check PostgreSQL connection limits and statement timeout logs.

## Remote MCP connector is not ready

1. Verify the API is ready and `MCP_HTTP_ENABLED=true`.
2. Confirm the client URL is the configured public origin plus `/mcp`.
3. Confirm the reverse proxy preserves the public `Host` header.
4. Send both `Authorization: Bearer ...` and `X-Agent-Purpose`.
5. Verify the key is active and includes `data:read`; add other scopes only
   when remote write tools are deliberately enabled.
6. Check the connector's MCP tool discovery and health logs. Remote MCP uses
   stateless JSON responses, so clients must send authentication on every
   request.

## Effect backlog or unknown outcome

1. Keep the worker running with the same artifact keys and effect allowlist.
2. Inspect effect status and attempts through `list_effects` with pagination.
3. Do not manually redeliver an expired `dispatching` effect. The worker
   reconciles it after lease expiry.
4. Confirm the provider honors the original idempotency key and status URL.
5. Investigate queue age before increasing worker replicas.

## Migration failure

1. Keep API and worker replicas at zero.
2. Preserve migration logs and the signed pre-upgrade backup.
3. Correct configuration or provider-extension availability.
4. Rerun the idempotent migration command.
5. If an applied migration is incompatible, restore the backup. Never edit a
   released migration checksum.

## Artifact integrity failure

1. Stop writes.
2. Run `reconcile-artifacts` with the administrative connection.
3. Treat missing, corrupt, or undecryptable referenced files as data-loss
   incidents.
4. Restore the coordinated signed backup or restore the missing key version.
5. Do not remove an old key ID while retained artifacts reference it.

## Pool exhaustion

1. Multiply `DATABASE_POOL_SIZE` by total API and worker replicas.
2. Compare the result with PostgreSQL connection capacity and reserved
   administrative connections.
3. Reduce per-process pools before increasing the database limit.
4. Check slow statements and provider calls before adding replicas.

## Timer backlog

1. Invoke `process_timers` with a tenant-scoped key that has `workflows:run`.
2. Repeat while the operation returns changed machines. Each call processes at
   most 100 due timers.
3. Check scheduler credentials, purpose, and cadence before adding concurrent
   invokers.
4. Keep separate scheduler state per tenant. There is no global timer sweep.

## Rate limiting

1. Confirm `TRUSTED_PROXY_HOPS` matches the exact ingress chain.
2. Ensure the Node.js listener cannot be reached around that trusted chain.
3. Remember that the built-in limiter is process-local.
4. Use a shared edge or gateway limiter before adding API replicas.

## Backup and restore

1. Keep `BACKUP_MANIFEST_KEY` in a separate secret store.
2. Stop all writers.
3. Run the backup script and copy the signed backup off-host.
4. Keep `manifest.json`, `manifest.hmac`, the database dump, and any artifact
   archive together.
5. Run `scripts/test-backup-restore.ps1` regularly in a disposable
   environment.
6. Record restore duration and verify API readiness after every drill.

## Graceful shutdown

Send `SIGTERM` once and allow `SHUTDOWN_TIMEOUT_MS` for draining. The HTTP
server stops accepting connections, closes idle connections, and forcibly
closes remaining sockets at the deadline. The worker aborts active outbound
requests and leaves ambiguous effects for reconciliation.
