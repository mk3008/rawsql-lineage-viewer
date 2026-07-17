# Utility benchmark v1

This is an external, fixture-only benchmark for the static investigation utility.
`public/` contains the caller-visible case, schema, query, and parameter definitions.
`private/` contains only benchmark execution inputs and evaluator oracles. The runner
never includes private values or oracle text in its report.

Run from the repository root with `npx tsx tests/dogfooding/utility-benchmark-v1/run.ts`.
The runner starts fixed `postgres:16-alpine`, records the accepted static baseline
before executing any probe, executes only validated plan probes in a read-only
transaction, compares faulty/control observations, and removes the container and
private temporary bindings in `finally`.
