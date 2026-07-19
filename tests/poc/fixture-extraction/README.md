# Fixture Extraction SELECT PoC External Harness

This test-only harness proves the accepted fixture-extraction plans against synthetic,
disposable PostgreSQL source and target databases. Product code remains static and
database-free; all Docker, credentials, SQL execution, and row transfer live here.

The committed case metadata is a focused projection of the accepted scenario oracle
with SHA256 `2E2C05A44F3B9A332145AF6C111A1001DFC8FA6472AC44042F6215DAFBD4AFFD`.
It covers the five required `ready` scenarios and the required blocked DML CTE. The
optional aggregate scenario is intentionally not executed because its accepted plan is
`partial`, not a complete executable fixture plan.

Run the static and mechanical gates:

```sh
npx vitest run tests/poc/fixture-extraction
```

Run the disposable PostgreSQL reproduction:

```sh
npx tsx tests/poc/fixture-extraction/run.ts
```

The runtime command starts one local PostgreSQL 16 container with fresh source and
target databases, loads only synthetic source rows, executes only bounded generator
SELECT steps with bound parameters, transfers their returned rows with parameterized
test-only INSERTs, and compares the original query on both databases. It writes
machine-readable evidence under
`tmp/orchestration/fixture-extraction-select-poc/evidence/` and removes the container
in a `finally` path.
