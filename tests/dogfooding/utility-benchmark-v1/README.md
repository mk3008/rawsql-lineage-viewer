# Utility benchmark v1

This is an external, fixture-only benchmark for the static investigation utility.
`public/` contains the caller-visible case, schema, query, and parameter definitions.
`private/` contains only benchmark execution inputs and evaluator oracles. The runner
never includes private values or oracle text in its report.

Run from the repository root with `npx tsx tests/dogfooding/utility-benchmark-v1/run.ts`.
The runner resolves one accepted baseline revision at startup (the PR remediation
baseline by default, or `UTILITY_BENCHMARK_BASE_SHA` when explicitly supplied)
and uses that same full commit SHA for evidence metadata, changed-path
classification, and the durable report.
The runner starts fixed `postgres:16-alpine`, records the accepted static baseline
before executing any probe, executes only validated plan probes in a read-only
transaction, compares faulty/control observations, and removes the container and
private temporary bindings in `finally`.

## Parameter submission contract

The benchmark rewrites parameters with the public `rawsql-ts` tokenizer and token
source positions. Only tokenizer-classified `:identifier` parameter tokens are
rewritten. Text inside string literals, quoted identifiers, line or block comments,
PostgreSQL dollar-quoted strings, and `::` casts is left unchanged. Repeated names
reuse one PostgreSQL positional parameter. Declared but unused definitions are
allowed and are not submitted; undeclared, duplicate, or unsupported parameter
tokens fail closed with a stable benchmark error code. Binding keys in aggregate
evidence are encoded as JSON tuples, and ordering uses JavaScript code-unit order so
evidence does not depend on the host locale.

The executor wraps the rewritten statement in a row-capped derived-table `SELECT`,
submits only bindings referenced by that statement, and runs it inside `BEGIN READ
ONLY`. If execution or commit fails, rollback is attempted without replacing the
original error.

## Metric semantics

- `observationContractMatchRate` measures probes whose faulty and control
  observations match the private oracle contract.
- `faultyControlDiscriminationRate` measures probes whose faulty and control results
  differ, independently of oracle agreement.
- `actionableEvidenceRate` measures accepted probes that executed and produced a
  `supports` or `weakens` classification.
- `candidateReductionRate` measures the fraction of initial candidate concerns
  removed by `weakens` evidence.
- `rootMechanismInconclusive` is true only when the oracle mechanism misses the top
  three, no candidate is reduced, and no probe discriminates faulty from control.
- `semanticEditFreeRate` and `manualSqlAvoidedCount` concern equality between the
  planned probe and the executor-entry artifact. Transport-only parameterization and
  row-capping are recorded separately with submitted-statement hashes.
