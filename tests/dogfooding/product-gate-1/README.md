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

Before running a parameterized case, the operator must create its local
`private/<case>/bindings.json` file. Binding files are intentionally ignored by
Git and must contain only synthetic fixture values. The harness fails closed
when a required binding is absent; do not commit, attach, or paste binding
values into review evidence.

The harness starts an ephemeral PostgreSQL 16 container, captures the actual
CLI and stdio-MCP exchanges, compares their complete plan JSON exactly, and
executes only `recommendedProbes` listed by that plan.  It rejects blocked,
unknown, unexpectedly classified, or unresolved-parameter probes.  A probe's
static classification does not authorize execution.  This external harness
applies its own fixture-only policy, including an explicit read-only
transaction, a five-second statement timeout, and a 100-row output cap.  Raw
captures are deliberately written only to `tmp/dogfooding/product-gate-1/raw/`.

The executor performs deterministic placeholder conversion (`:name` to `$n`)
and an outer output cap only; it does not rewrite probe meaning.  Definitions
remain in the public request while fixture-only bindings live in Git-ignored
files under `private/`.
The harness passes those bindings only through a temporary CLI input and the
PostgreSQL `PREPARE`/`EXECUTE` wrapper.  It never writes bindings, invocation
arguments, or parameter input files to raw evidence.  Generated and prepared
probe SQL contains placeholders only.  Seed/control/oracle files are never
sent as planning context.  Private binding files are supplied only through the
explicit CLI/MCP binding inputs and are never copied into plans or evidence.
Each emitted probe also carries a static interpretation contract.  The harness
checks its shape and concern references before external execution, but it does
not persist a runtime interpretation, causal conclusion, or remediation claim.
