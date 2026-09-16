# SRE Incident Benchmark

Generated from `summary.json`.

Source revision: `b27d6671cd94c67c1fab6dbd2ae607d98f90bde5`

Source hash: `b88e11bfb6346c1200eea4cc027fdfb25ee16291e2602e17bc797f8abf8c8650`

## Correctness

Both variants must resolve every run with one delivery and one reconciliation.

| Variant | Passed | Delivery counts | Reconciliation counts | Recovery | Audit score |
| --- | ---: | --- | --- | --- | --- |
| Conventional PostgreSQL | 3/3 | 1, 1, 1 | 1, 1, 1 | 0.42 -> 0.03, 0.42 -> 0.03, 0.42 -> 0.03 | 9, 9, 9 / 9 |
| Agentic Data Kernel | 3/3 | 1, 1, 1 | 1, 1, 1 | 0.42 -> 0.03, 0.42 -> 0.03, 0.42 -> 0.03 | 9, 9, 9 / 9 |

## Application-owned surface

| Variant | Nonblank app lines | App-authored tables | Operated tables |
| --- | ---: | ---: | ---: |
| Conventional PostgreSQL | 317 | 8 | 8 |
| Agentic Data Kernel adapter | 43 | 0 | 18 |

The adapter delegates to the shipped SRE scenario, which contains
930 nonblank TypeScript source lines inside the
dependency. The full kernel dependency contains 16709
nonblank TypeScript source lines.

The benchmark runner and engine-specific audit verification contain
1470 nonblank TypeScript source lines.
They are excluded from both application columns. Dependency and harness code
is not application-authored, but it remains code that must be understood,
operated, or upgraded.

## Database footprint

| Variant | Median bytes |
| --- | ---: |
| Conventional PostgreSQL | 540672 |
| Agentic Data Kernel | 1572864 |

## Informational runtime

| Variant | Median milliseconds |
| --- | ---: |
| Conventional PostgreSQL | 57.90 |
| Agentic Data Kernel | 929.60 |

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
