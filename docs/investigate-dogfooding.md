# Static Investigate CLI Dogfooding

Use this template to record a worker's practical evaluation of the static
`rawsql-lineage investigate` CLI. It records observations; it is not a product
acceptance decision.

## Reproducible invocation

Run from the repository root. Use a scenario's `expected.json` for the target
column and symptom.

```sh
npx tsx src/cli/diagnose.ts investigate \
  --sql tests/scenarios/<scenario>/query.sql \
  --ddl tests/scenarios/<scenario>/schema.sql \
  --target-node main_output \
  --target-column <expected.targetColumn> \
  --symptom <expected.symptom>
```

Add `--parameters <parameter-input.json>` only when the scenario requires
explicit investigation keys or known original-query parameter values. The JSON
file is an array of parameter objects with a fixed origin, for example
`[{"name":"customer_id","origin":"investigation_key","value":10}]`.
Do not create placeholder parameters merely to make a dogfooding command look
complete.

Save the command's JSON only as ephemeral evidence under
`tmp/orchestration/<task-id>/raw/<scenario>.json`. Do not copy a generated plan
payload into this document or another tracked document.

## Worker record

The worker records the exact invocation, fixture revision, supplied parameter
origins (never sensitive values), target, symptom, candidate concern count,
recommended/deferred/blocked probe counts, and distinct blocked reasons. Link
the raw JSON using the convention
`tmp/orchestration/<task-id>/raw/<scenario>.json`. This is a temporary path
convention, not a tracked-document link; do not embed generated payloads in
tracked documentation.

| Scenario | Target / symptom | Candidate concerns | Recommended / deferred / blocked | Distinct probe reasons | Raw JSON |
| --- | --- | ---: | --- | --- | --- |
| `<scenario>` | `<node>.<column>` / `<symptom>` | `<count>` | `<n>` / `<n>` / `<n>` | `<summary>` | `tmp/orchestration/<task-id>/raw/<scenario>.json` |

Record parameter handling separately: whether each parameter is `provided`,
`required`, or `unresolved`, and whether a supplied marker value was absent from
all proposed probe SQL. The static planner may emit parameter metadata but must
not cause a DB call, SQL execution, network request, or AI request.

## Separation of responsibilities

The worker runs the CLI and records raw observations only. The evaluator reviews
the request, acceptance criteria, this template-derived record, and linked raw
JSON independently; the evaluator, not the worker, classifies the result as
`meets`, `partially meets`, or `does not meet`. The evaluator should state
blockers, non-blockers, evidence gaps, wording overreach, and missing user value.

## Static probe classification

Each emitted probe includes `staticSafetyEvidence`, a versioned syntax-derived
classification. A `select_statement` classification with `syntax_only`
confidence means that the bundled parser recognized one SELECT or binary SELECT
statement and found only SELECT queries throughout its parsed CTE tree.

This classification is static evidence, not execution authorization. Its
assumptions and execution caveats remain part of the artifact. In particular,
the classification does not prove the absence of database-specific or
user-defined function effects, `SELECT FOR UPDATE` locking behavior,
extension-specific syntax, or effects in SQL dialects outside the parser's
supported surface. The product does not inspect a live database, permissions,
data, runtime bindings, or an execution environment.

## Required uncertainty fields

- `UNCONFIRMED — DB symptom and correct baseline:` no conclusion without a
  DB-backed fixture run or equivalent evidence.
- `UNCONFIRMED — Human usability:` no conclusion without an evaluator or target
  user assessing the investigation handoff.
- `UNCONFIRMED — Production schema/data/permissions:` fixture DDL is not proof
  of live schema, data, access, or runtime behavior.
- `UNCONFIRMED — Product acceptance:` all scenario observations remain evidence
  for an evaluator; they are not acceptance by themselves.

## Minimal handoff

The worker report should identify its task and attempt, link the temporary raw
evidence, describe limitations and the uncertainty fields above, and state a
non-conclusive worker claim. The parent/evaluator then performs the acceptance
decision without treating the worker summary as a substitute for the raw JSON.
