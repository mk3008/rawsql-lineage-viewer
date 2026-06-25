# Long SQL Reading Cases

This directory stores long SQL examples used as reading and reasoning cases for
lineage maintenance.

These files are not ordinary regression scenarios. They are meant to help humans
and AI agents practice reading large, realistic SQL without immediately editing
unrelated lineage code.

## Cases

| File | Lines | Purpose |
| --- | ---: | --- |
| `postgres_customer_health_report_commented.sql` | 455 | PostgreSQL customer health report with many commented CTEs, joins, lateral subqueries, population filters, value expressions, and final presentation columns. |

## How To Use

When using a long SQL reading case:

- Start by identifying the query's CTE sections and final SELECT outputs.
- Separate SELECT output columns from row-population influences such as WHERE,
  JOIN ON, HAVING, ORDER BY, and LIMIT.
- Note which parts are value-origin questions, population-origin questions,
  source-reference questions, or output-column questions.
- Do not treat this directory as an executable test fixture unless a future task
  explicitly adds test expectations.
- Keep changes to these examples separate from lineage behavior changes when
  possible.

## Maintenance Notes

- Prefer adding a short README entry for each new long SQL file.
- Keep the SQL close to realistic production shape, including comments when they
  improve reading.
- Avoid adding real customer data, secrets, or proprietary identifiers.
- If a long SQL case becomes a regression test, copy or adapt it into a test
  fixture directory with explicit expectations.
