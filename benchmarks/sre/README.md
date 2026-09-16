# SRE Incident Benchmark

This benchmark implements the same deterministic incident twice:

- conventional PostgreSQL tables and application code;
- Agentic Data Kernel using the published production primitives.

Both variants must:

1. store observations and competing hypotheses;
2. revise confidence and select a hypothesis;
3. persist a decision and rollback request;
4. apply the rollback once but receive an ambiguous timeout;
5. reload runtime state;
6. reconcile provider status;
7. verify recovery and finish as resolved.

The shared remediation adapter is identical for both variants. A competent
PostgreSQL implementation is expected to match the kernel on correctness.

## Run

Start the repository PostgreSQL profile and create the runtime role:

```powershell
docker compose up -d postgres
docker compose run --rm bootstrap
$env:BENCHMARK_REPETITIONS = "3"
npm run benchmark:sre
```

Use `BENCHMARK_WRITE_RESULTS=1` to regenerate `results/summary.json` and
`results/report.md`.

`summary.json` includes every per-run outcome, audit answer, table count,
database footprint, and informational duration used by the aggregate report.
It also includes a portable source hash over benchmark-relevant package
manifest fields, the lockfile, benchmark, production kernel, migrations, and
PostgreSQL container configuration. Descriptive package metadata such as
author and homepage does not invalidate the evidence.

CI runs the comparison and verifies that the committed report is generated
from `summary.json`, contains three correct runs per variant, has aggregates
that match the raw runs, has a current evidence source hash, and matches a
fresh three-run comparison for deterministic outcomes and structural metrics.

## Metrics

Correctness is a merge gate:

- final incident state;
- final effect state;
- provider delivery count;
- provider reconciliation count;
- nine engine-neutral audit questions.

The report also records application-owned nonblank source lines, app-authored
tables, total operated tables, database footprint, and informational runtime.

Application LOC excludes the benchmark runner, engine-specific audit queries,
and the kernel dependency. The report separately discloses the benchmark
harness, shipped SRE scenario, full dependency source size, and total operated
table count so code and schema are not presented as having disappeared.

## Not claimed

- PostgreSQL can implement correct outbox, idempotency, and reconciliation
  behavior; correctness must be equal.
- Runtime reloads close and reopen database-backed runtime objects. This version
  does not claim operating-system process crash recovery.
- Runtime duration is not a performance benchmark.
- Database size is expected to favor the narrower conventional schema.
- LOC is not a direct measure of developer productivity.
- Adapter LOC measures reuse of the shipped SRE scenario. It is not a
  comparison of two equivalent scenario implementations written from generic
  primitives.
