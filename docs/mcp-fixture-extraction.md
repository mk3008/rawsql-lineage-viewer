# Experimental fixture-extraction MCP tool

`create_fixture_extraction_plan` produces an experimental, static
`fixture-extraction-plan` from submitted SQL, explicit schema evidence, and an
explicit value-free reproduction key. The plan uses `schemaVersion: 0`; its
shape and semantics are intentionally not a stable production contract.

The MCP server is launched as usual:

```sh
rawsql-lineage-mcp --workspace /absolute/path/to/workspace
```

Call the tool with exactly one of `sql` or workspace-confined `sqlPath`; schema
evidence may be inline `ddl`, workspace-confined `ddlFiles` / `ddlDirectories`,
or `schemaFactsPath` (the latter cannot be combined with DDL). For example:

```json
{
  "sql": "select status from orders where status = :status",
  "ddl": "create table orders (status text primary key);",
  "reproductionKey": {
    "parameterNames": ["status"],
    "rootRelation": "orders",
    "rootColumns": ["status"]
  }
}
```

`reproductionKey` must contain metadata only: `parameterNames`, optional
`rootRelation`, and optional `rootColumns`. Parameter bindings, parameter
values, rows, and other value-bearing fields are rejected with the stable
`VALUE_BEARING_INPUT_FORBIDDEN` MCP error. Invalid SQL/DDL source combinations
and workspace paths retain the server's existing stable input errors.

The tool never connects to a database, executes SQL, reads runtime rows, loads
fixtures, or emits `INSERT`, `COPY`, CSV, or JSON transfer actions. It only
returns parser-backed bounded capture `SELECT` text for narrow supported shapes;
unsupported or unproven input returns explicit `partial` or `blocked` output.
No arbitrary-SQL support, migration automation, or production-readiness claim is
made by this tool.
