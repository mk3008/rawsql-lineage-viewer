# Product Dogfooding Gate 1 fixture harness

This directory is a reproducible product-boundary harness, not a Planner test
suite.  Each case has only static, user-supplied inputs under `public/`.
Database seed data, controls, and expected observations are isolated under
`private/`; later AI/LLM delegation must receive neither that directory nor
the raw capture directory.

Run from the repository root:

```text
npx tsx tests/dogfooding/product-gate-1/run.ts
```

The harness starts an ephemeral PostgreSQL 16 container, captures the actual
CLI and stdio-MCP exchanges, compares their complete plan JSON exactly, and
executes only `recommendedProbes` listed by that plan.  It rejects blocked,
unknown, unexpectedly classified, or unresolved-parameter probes.  A probe's
static classification does not authorize execution.  This external harness
applies its own fixture-only policy, including an explicit read-only
transaction, a five-second statement timeout, and a 100-row output cap.  Raw
captures are deliberately written only to `tmp/dogfooding/product-gate-1/raw/`.

The executor performs deterministic placeholder conversion (`:name` to `$n`)
and an outer output cap only; it does not rewrite probe meaning.  It passes
fixture-safe values only through a PostgreSQL `PREPARE`/`EXECUTE` wrapper, so
the generated or prepared probe SQL never has parameter values inlined.
Seed/control/
oracle files are used solely by this local harness and are never input to the
CLI or MCP server.
