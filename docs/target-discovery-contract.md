# Target discovery contract

Status: public version 1 contract. This document is subordinate to the
[product boundary](./product-boundary.md).

Target discovery is a deterministic Core operation over caller-supplied SQL,
DDL, and schema facts. It does not connect to a database, execute SQL, inspect
bindings or results, select a root cause, or generate corrected SQL.

## Result shape

`InvestigationTargetDiscoveryV1` contains:

- an `investigation-analysis-summary` with original-analysis mode, parser
  version, node/output/target counts, selection-status counts, and static
  warnings;
- an ordered `targets` array with stable plan-local IDs (`target:001`,
  `target:002`, and so on);
- syntax-derived node and column identities, including zero-based output index
  and select-item ID when available;
- reasons explaining why each target was included;
- a selection status that is `selectable`, `ambiguous`, or `unsupported`;
- explicit ambiguity groups and unsupported-analysis information.

Ordering is deterministic: the final output node comes first, other supported
query-output nodes are ordered by node ID, and their columns are ordered by
output index and stable identity. IDs are stable for identical supplied inputs
and compiler version. They are not global database identities.

A selectable target carries the existing `{ nodeId, columnName }` plan target.
Core resolves a `targetId` only against a discovery result recomputed from the
same supplied static inputs. Unknown, ambiguous, and identity-deficient targets
fail explicitly. In particular, duplicate output names are not guessed because
the version 1 investigation-plan target cannot distinguish them by ordinal.

Unresolved upstream references and schema-free wildcards remain explicit in
`unsupported`; their presence is not converted into runtime knowledge.

## MCP workflows

MCP exposes three static operations:

1. `analyze_investigation_sql` returns the analysis summary.
2. `discover_investigation_targets` returns the target-discovery contract.
3. `create_investigation_plan` accepts either a discovery `targetId` or the
   compatible explicit `targetColumn` plus optional `targetNode` input.

The composable workflow makes analysis and target-selection boundaries visible
and can stop at target discovery when ambiguity is reported. The high-level
workflow preserves the existing one-call plan path for callers that already
have an explicit target. Both plan paths use the same Core plan contract.

The repository-owned static dogfooding harness measures completion, actual MCP
call count, UTF-8 JSON bytes returned before plan creation, stage-specific error
localization, ambiguity handling, and boundary clarity across multiple SQL/DDL
scenarios. It does not execute scenario SQL. Real LLM tool-selection success is
`UNCONFIRMED`; deterministic harness calls are not evidence of model behavior.
