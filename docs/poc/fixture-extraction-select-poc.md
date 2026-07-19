# Fixture Extraction SELECT PoC

## Status

This is an experimental, internal V0 proof of concept. It is not a public API,
a production-readiness claim, or a contract for arbitrary SQL.

The PoC shows that a pure, static Core component can derive bounded fixture
extraction `SELECT` plans for a deliberately narrow set of SQL and schema shapes.
Database execution, row transfer, fixture loading, `INSERT`, and `COPY` are not
Core capabilities. The disposable PostgreSQL harness under `tests/poc` performs
test-only execution and parameterized row insertion solely to evaluate the plans.

## Outcome

Within the five required supported synthetic scenarios, the generated plans
reproduced the observed source result in a fresh target database in **5/5 cases**.
The harness executed **10/10 generated captures**, verified their exact columns
and unordered row multisets, and transferred **13 synthetic rows** in total.

The required DML CTE case failed closed with zero generated captures and zero DML
execution. The `NOT EXISTS` scenario preserved the required zero-row child capture.
The accepted run also completed container, port, temporary-directory, and synthetic
credential cleanup.

These results support continued investigation. They do not establish end-to-end
migration-work reduction, elapsed-time savings, or production suitability.

## Evidence separation

- **Repository evidence** covers static generation, parser-backed SQL, fail-closed
  classifications, product-boundary scans, tests, type checking, and builds.
- **Supplementary runtime evidence** comes from the accepted disposable local
  PostgreSQL harness run. It covers only the five required supported synthetic cases,
  the required blocked DML case, and that run's cleanup.
- **Comparison evidence** comes from a blind manual SELECT-authoring baseline. It is a
  construction proxy, not a runtime benchmark or human-time study.

## Architecture and safety boundary

The product-side flow is intentionally static:

```text
SQL text + DDL-derived SchemaFacts + reproduction-key metadata
    -> internal static safety and relation analysis
    -> internal FixtureExtractionPlanV0
    -> bounded SELECT text or an explicit non-ready result
```

The boundary is:

- Core remains pure, static, database-free, and free of runtime credentials.
- The plan carries parameter names and bounded `SELECT` text, not binding values or
  captured rows.
- Unsupported or unproven population, schema, volatility, environment-state, and
  propagation cases fail closed instead of emitting an executable step.
- Ready SQL is parser-backed and bounded by proven key and foreign-key evidence for
  the supported V0 shapes.
- No fixture-loading API is exposed. Product `INSERT`, `COPY`, CSV/JSON transfer,
  database clients, Docker control, and source-to-target execution are out of scope.
- The PostgreSQL runner is an external test harness. Its test-only parameterized
  inserts validate reproduction behavior but do not expand the Core boundary.

## Bounded scenario evidence

The accepted runtime used disposable local PostgreSQL 16.11 from
`postgres:16-alpine`. All data was synthetic.

| Scenario | Static result | Executed captures | Transferred rows | Runtime observation |
| --- | --- | ---: | ---: | --- |
| `fxsel-01-single-ticket` | ready | 1 | 1 | Source and target observations matched. |
| `fxsel-02-account-notes-left` | ready | 2 | 3 | Source and target observations matched; tested nulls were preserved. |
| `fxsel-03-customer-order-items` | ready | 3 | 6 | Source and target observations matched across two relationship hops. |
| `fxsel-04-member-exists` | ready | 2 | 2 | Source and target observations matched; the retained `subscription_state = 'active'` predicate was included. |
| `fxsel-05-workspace-not-exists` | ready | 2 | 1 | Source and target observations matched; the child capture returned the required zero rows. |
| `fxsel-06-dml-cte-blocked` | blocked | 0 | 0 | `RETURNING_UNSUPPORTED` and `DML_CTE_UNSUPPORTED`; the original DML was not executed. |

Across the five ready required scenarios:

- source-to-target comparison: **5/5 matched**;
- generated and executed captures: **10/10**;
- exact capture columns: **10/10 matched**;
- exact unordered row multisets: **10/10 matched**;
- transferred synthetic rows: **13**;
- runtime mismatches: **0**.

Exact capture checks are scenario-specific synthetic oracles. They demonstrate the
accepted cases, not general SQL coverage.

### Optional aggregate stretch

The optional aggregate scenario, `fxsel-07-anonymous-paid-summary`, currently has a
static `ready` plan with two parser-valid bounded `SELECT` steps. It was not executed
by the accepted runtime harness. Its runtime utility and source-to-target equivalence
therefore remain **partial and unexecuted**.

## Hypothesis verdicts

| Hypothesis | Verdict | Evidence boundary |
| --- | --- | --- |
| H1 — bounded plan generation is feasible | Demonstrated | Exact relation sets and bounded parser-valid `SELECT` plans were produced for the five required supported cases and the optional static case. This is limited to the evaluated V0 shapes. |
| H2 — generated captures can reproduce an observation | Demonstrated | The five executed supported synthetic cases matched after transferring only generated capture results. Optional aggregate and real or remote data were not executed. |
| H3 — fixture extraction reduces migration cost | Partially demonstrated | A narrow SELECT-authoring proxy improved, but assisted end-to-end human steps, historical omission retries, and elapsed time were not measured in comparable units. |
| H4 — unsupported work can fail closed | Demonstrated for tested forms | The DML CTE produced zero steps and zero execution. Required negative tests and eleven tested environment/session expressions also blocked with zero steps. This does not cover every unsupported SQL form. |
| H5 — the product execution boundary can remain intact | Demonstrated within the PoC | Core scans found no database, network, process, or credential execution surface; all DB-backed evaluation remains under `tests/poc`. |

## SELECT-authoring proxy

For the five executed supported cases, the blind manual baseline authored:

- **10 handwritten capture SELECTs**;
- **30 construction units**; and
- **33 nonblank SQL lines**.

The accepted assisted path used the 10 generated captures with **zero manual SQL
edits** and **zero manual SQL additions**.

This is evidence of reduced SELECT-authoring work only. It is not evidence that total
migration work fell to zero. Assisted end-to-end migration steps were not recorded,
historical retries caused by omissions were unavailable, and no controlled human-time
study was performed. H3 therefore remains partial, and any claim about elapsed time,
retry reduction, or end-to-end migration reduction remains inconclusive.

## Cleanup evidence

The accepted local run recorded all of the following:

- the disposable container removal succeeded;
- no container with the generated run name remained;
- the loopback port was closed;
- the temporary directory was removed; and
- the synthetic credential file was removed.

This confirms cleanup for the accepted synthetic run only. It is not an operational or
production lifecycle guarantee.

## Limitations and non-claims

- The generator is experimental and internal; no CLI, MCP, UI, package, or public API
  commitment is made.
- Only bounded synthetic scenarios were evaluated. No real data, remote database,
  production environment, or real credential was used.
- The supported grammar and propagation shapes are intentionally narrow. This is not
  arbitrary SQL support.
- Static readiness does not imply runtime reproduction unless the scenario was actually
  executed. The optional aggregate remains unexecuted.
- The harness demonstrates test-only transfer; it does not provide product loading,
  `INSERT`, `COPY`, export, import, or deployment behavior.
- Five matching scenarios and ten exact captures are useful PoC evidence, not a
  statistical estimate of correctness for unseen workloads.
- No statistically valid time-saving, retry-saving, or end-to-end migration-work claim
  is supported by the available evidence.

## Recommendation

**Promising, but more evidence is required.**

Keep the generator internal and fail-closed. Before considering a public or production
surface:

1. instrument assisted human steps, omission-driven retries, and elapsed time in units
   comparable with a manual baseline;
2. add broader adversarial schemas and SQL shapes without weakening the static boundary;
3. execute the optional aggregate only if aggregate support remains a product goal; and
4. repeat runtime evaluation on a larger, explicitly approved synthetic corpus before
   discussing generality or production readiness.

## Reproduction

Install the locked dependencies and run the repository checks:

```sh
npm ci
npx vitest run tests/poc/fixture-extraction src/lineage/fixture-extraction/generateFixtureExtractionPlanV0.test.ts
npm test
npx tsc --noEmit
npm run build
```

With a local Docker daemon available, run the disposable synthetic PostgreSQL
evaluation:

```sh
docker version
npx tsx tests/poc/fixture-extraction/run.ts
```

The runner creates fresh source and target databases in one local container, executes
only bounded generated capture `SELECT` steps with bound parameters, uses test-only
parameterized inserts for transfer, compares the original source and target queries,
writes machine-readable evidence under
`tmp/orchestration/fixture-extraction-select-poc/evidence/`, and attempts cleanup in a
`finally` path. Inspect the command result and evidence rather than assuming a run
succeeded from process startup alone.

See the [external harness README](../../tests/poc/fixture-extraction/README.md) for the
test harness boundary and the shortest reproduction commands.
