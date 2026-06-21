# SQL Lineage Viewer

Demo: https://mk3008.github.io/rawsql-lineage-viewer/

Paste SQL and see the lineage graph in the browser.

This is a static TypeScript web app intended for GitHub Pages. SQL is parsed locally with `rawsql-ts`; no backend, database, or upload step is required for the MVP.

## MVP Scope

- Load a sample SQL query on first visit.
- Edit SQL in the side panel.
- Analyze SQL with `rawsql-ts`.
- Convert parser output through an adapter into a stable lineage model.
- Render the lineage graph with React Flow.
- Collapse upstream helper CTEs into a representative CTE group.
- Copy a hash-based share URL for SQL that is short enough to fit in the URL.

Save/load, JSON import/export, SVG/PNG export, and upstream/downstream switching are intentionally left for later iterations. The internal model layers are separated so those capabilities can be added without binding the app to the raw parser AST.

The graph visualizes value lineage, not JOIN relationships as separate edges. Dashed data-flow edges indicate values from an OUTER JOIN nullable side. This is a join-context marker, not full output nullability inference.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run build
npm run test:e2e
```

## CLI diagnostics

The web app remains SQL-first and does not require DDL. For local project analysis, the package also exposes a CLI that can enrich diagnostic JSON with optional DDL or prebuilt `SchemaFacts`.

```bash
rawsql-lineage diagnose --sql ./queries/customer-health.sql
rawsql-lineage diagnose --sql ./queries/customer-health.sql --ddl ./db/schema.sql
rawsql-lineage diagnose --sql ./queries/customer-health.sql --ddl-dir ./db/ddl
rawsql-lineage diagnose --sql ./queries/customer-health.sql --schema-facts ./schema-facts.json
rawsql-lineage diagnose --sql ./queries/customer-health.sql --target-column paid_amount --out ./diagnostic.json
```

Options:

- `--sql <file>`: required SQL file to diagnose.
- `--ddl <file>`: optional DDL file. May be specified more than once.
- `--ddl-dir <dir>`: optional directory scanned recursively for `.sql` files. The CLI skips `.git`, `node_modules`, `dist`, `build`, and `coverage`, then sorts paths for stable reads.
- `--schema-facts <file>`: optional `SchemaFacts` JSON. This is the intended boundary for future tools such as Ashiba.
- `--target-column <name>`: optional output-column filter. Without it, all output columns are diagnosed.
- `--out <file>`: optional output path. Without it, JSON is printed to stdout.

Without DDL, diagnostics stay SQL-only. For example, `SELECT *` may produce a `wildcard_unresolved_without_schema` diagnostic because physical table columns are unknown. With DDL or `SchemaFacts`, `SELECT *` / `table.*` can be expanded, unqualified columns can be resolved when a single source owns the name, and PK / UNIQUE / nullable facts can adjust candidate concern confidence. DDL is advisory; the CLI never treats it as proof of the root cause.

`SchemaFacts` is a public JSON boundary, not a raw AST dump:

```json
{
  "kind": "schema-facts",
  "version": 1,
  "tables": {
    "customers": {
      "name": "customers",
      "columns": {
        "id": { "name": "id", "type": "int", "nullable": false }
      },
      "primaryKey": ["id"]
    }
  }
}
```

### DDL adapter note

rawsql-ts is the source of truth for SQL parsing, SELECT item structure, wildcard expansion, table aliases, schema-qualified names, quoted identifiers, CTEs, derived tables, subqueries, and expression ASTs. rawsql-lineage enriches that analysis with lineage-specific metadata: `scopeId`, `nodeId`, `upstream`, value origin, population origin, candidate concerns, diagnostics, and confidence adjustments.

`SchemaFacts` creates a rawsql-ts-compatible `TableColumnResolver`. Wildcard SELECT items are expanded through rawsql-ts `SelectValueCollector`; the lineage adapter then converts those expanded values into `LineageColumn` objects.

When wildcard expansion contains duplicate output column names, rawsql-lineage keeps the rawsql-ts `SelectValueCollector` result as the source of truth. If `SchemaFacts` indicates that source columns were likely deduplicated, diagnostics include `rawsql_duplicate_output_columns_deduped` instead of silently merging or inventing columns.

The adapter still performs the final rawsql-ts-result-to-`LineageModel` conversion because diagnostic JSON needs information that rawsql-ts collectors do not expose as output metadata: `nodeId`, `scopeId`, `upstream` references, `usageKind`, and lineage diagnostics such as unresolved wildcard warnings. This keeps rawsql-ts responsible for parser/schema primitives while this app owns diagnostic semantics.

日本語メモ: SQL解析の正は rawsql-ts です。rawsql-lineage は、その解析結果に `scopeId`、`upstream`、値由来、母集団由来、diagnostics を付加する層です。

## Deployment

The Vite `base` path can be changed for GitHub Pages by setting `VITE_BASE_PATH`.

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```
