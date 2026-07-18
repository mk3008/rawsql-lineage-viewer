# SQL Lineage Viewer

Demo: https://mk3008.github.io/rawsql-lineage-viewer/

Paste SQL and see the lineage graph in the browser.

This is a static TypeScript web app intended for GitHub Pages. SQL is parsed locally with `rawsql-ts`; no backend, database, or upload step is required for the MVP.

The normative [Product Boundary Contract](docs/product-boundary.md) defines how
Core, Viewer, CLI, and MCP support static investigation and where responsibility
passes to an external investigator.
The additive Core and MCP selection surface is defined in the
[Target Discovery Contract](docs/target-discovery-contract.md).

## Local package, CLI, and MCP distribution

This repository is private and is not published to npm. A clean checkout can
still produce and verify the consumer artifact locally:

```sh
npm ci
npm run build
npm run smoke:package
```

`npm run smoke:package` creates an `npm pack` tarball in a temporary directory,
installs it offline into an isolated consumer project, invokes the compiled
entrypoints, and removes the temporary files. It never publishes the package.
The supported installed entrypoints are:

```sh
rawsql-lineage discover --sql query.sql --contract-version 1
rawsql-lineage investigate --sql query.sql --target-id target:001 --contract-version 1
rawsql-lineage investigate --sql query.sql --target-node main_output --target-column total --contract-version 1
rawsql-lineage-mcp --workspace /absolute/path/to/workspace
```

JavaScript and TypeScript consumers can import the versioned static contracts
and planner from `sql-lineage-viewer`, including
`discoverInvestigationTargets`, `resolveInvestigationTarget`, and
`createInvestigationPlanForTarget`. The direct `targetNode` / `targetColumn`
planner input remains a caller-directed compatibility path; target discovery is
the supported path when a caller needs Core to determine eligibility. MCP server construction is available
from `sql-lineage-viewer/mcp`. Consumers do not need repository `src` files,
`tsx`, parser instances, runtime rows, or parameter binding values. CLI errors
are JSON objects with `kind`, `code`, `message`, and `version`; MCP tool errors
use the same `invalid_input` kind and stable codes. Contract version 1 is the
only accepted version.

The CLI and MCP expose the same composable static flow: analyze the submitted
artifact, discover selectable target identities, then create a plan with the
selected `targetId`. MCP also exposes `prepare_sql_investigation` as a
high-level convenience call. Discovery and planning are deterministic for the
same SQL, DDL/schema facts, and parameter definitions.

All three surfaces are DB-free: they parse only submitted SQL and explicitly
supplied DDL/schema facts, do not connect to or query a database, and do not
execute submitted SQL. They return static investigation artifacts and
selection/prerequisite limits, not diagnoses, corrected SQL, query results, or
proof of root cause. The current utility ceiling is deliberate: prerequisite
facts may state that an observation is supportable or blocked, but the package
does not generate or run aggregate/grain observation probes. Database
execution, runtime data retrieval, credential handling, binding-value
serialization, publishing, and remote MCP hosting are unsupported.

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

## Diagnostic focus badges

The `Focus` selector changes Row Lineage badges from a general graph annotation into a symptom-oriented diagnostic view for the selected column. Badges are confirmation prompts, not a SQL syntax inventory.

- Yellow badges mark the node that owns a row-lineage signal worth inspecting for the selected symptom.
- Blue `Ref: ...` badges mark input nodes referenced by that highlighted condition or population signal.
- Purple `Data` badges mark source data used by the selected value lineage.

`ORDER BY` is retained in diagnostic JSON, but it is not shown as an independent graph badge. `ORDER BY` with `LIMIT` / `OFFSET` is summarized as `Top-N`; `DISTINCT ON` absorbs its representative-row `ORDER BY` context.

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
rawsql-lineage diagnose --sql ./queries/customer-health.sql --symptom missing_rows
rawsql-lineage diagnose --sql ./queries/customer-health.sql --target-column paid_amount --out ./diagnostic.json
```

Options:

- `--sql <file>`: required SQL file to diagnose.
- `--ddl <file>`: optional DDL file. May be specified more than once.
- `--ddl-dir <dir>`: optional directory scanned recursively for `.sql` files. The CLI skips `.git`, `node_modules`, `dist`, `build`, and `coverage`, then sorts paths for stable reads.
- `--schema-facts <file>`: optional `SchemaFacts` JSON. This is the intended boundary for future tools such as Ashiba.
- `--symptom <intent>`: optional diagnostic focus. Supported values are `value_too_high`, `value_too_low`, `value_missing`, `missing_rows`, and `duplicate_rows`.
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

rawsql-ts is the source of truth for SQL parsing, SELECT item structure, wildcard expansion, table aliases, schema-qualified names, quoted identifiers, CTEs, derived tables, subqueries, and expression ASTs. rawsql-lineage enriches that analysis with lineage-specific metadata: `scopeId`, `nodeId`, `upstream`, column lineage, row lineage, candidate concerns, diagnostics, and confidence adjustments.

`SchemaFacts` creates a rawsql-ts-compatible `TableColumnResolver`. Wildcard SELECT items are expanded through rawsql-ts `SelectValueCollector`; the lineage adapter then converts those expanded values into `LineageColumn` objects.

When wildcard expansion contains duplicate output column names, rawsql-lineage keeps the rawsql-ts `SelectValueCollector` result as the source of truth. If `SchemaFacts` indicates that source columns were likely deduplicated, diagnostics include `rawsql_duplicate_output_columns_deduped` instead of silently merging or inventing columns.

The adapter still performs the final rawsql-ts-result-to-`LineageModel` conversion because diagnostic JSON needs information that rawsql-ts collectors do not expose as output metadata: `nodeId`, `scopeId`, `upstream` references, `usageKind`, and lineage diagnostics such as unresolved wildcard warnings. This keeps rawsql-ts responsible for parser/schema primitives while this app owns diagnostic semantics.

日本語メモ: SQL解析の正は rawsql-ts です。rawsql-lineage は、その解析結果に `scopeId`、`upstream`、列リネージュ、行リネージュ、diagnostics を付加する層です。

## Deployment

The Vite `base` path can be changed for GitHub Pages by setting `VITE_BASE_PATH`.

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```
