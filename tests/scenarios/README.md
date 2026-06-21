# Diagnose Scenario Matrix

These fixtures validate `rawsql-lineage diagnose` as a debugging aid.
Each scenario runs a faulty query against a real PostgreSQL database, compares it with a correct baseline, and verifies CLI diagnostic JSON with and without DDL.

| Scenario | Symptom | Faulty result | Correct baseline | Expected diagnostic focus |
| --- | --- | --- | --- | --- |
| `value-too-high-join-multiplication` | `value_too_high` | `total_amount = 200` | `total_amount = 100` | `row_multiplication`, `aggregate_expression`, `grain_change` |
| `value-too-low-status-filter` | `value_too_low` | no paid rows | `paid_amount = 200` | `row_filter`, status predicate, aggregate |
| `value-missing-null-zero` | `value_missing` | `paid_amount = 0` | `paid_amount = 100` | `null_extension`, `null_replacement`, missing match |
| `missing-rows-exists-master` | `missing_rows` | Alice is filtered out | Alice and Bob are returned | `exists`, `row_filter` |
| `duplicate-rows-duplicate-master` | `duplicate_rows` | Alice appears twice | Alice appears once | `row_multiplication`, join/data-condition check |

## Verification Axes

- Real DB symptom: the faulty query result must match `expectedRows`.
- Correct baseline: `query_correct.sql` or `seed_correct.sql` must produce `expectedCorrectRows`, proving the symptom is not just a fixture naming convention.
- CLI without DDL: expected effects, mechanisms, evidence, and check domains must still be present.
- CLI with DDL: expected effects must not be lost, candidate volume must remain within Recall@5, and schema-assumption visibility must not regress.
- Wrong symptom: a deliberately incorrect symptom must not emphasize the scenario's primary effects as strongly as the correct symptom.

## Current DDL Finding

The representative five scenarios are mostly understandable from SQL shape alone.
DDL currently preserves recall and schema-assumption context, but these fixtures do not claim that every scenario shows a large candidate reduction from DDL.
A future DDL-specific fixture should focus on wildcard expansion, unqualified-column disambiguation, nullable evidence, or unique-key confidence changes.
