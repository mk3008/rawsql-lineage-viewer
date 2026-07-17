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

Targets with unresolved upstream references have selection status `unsupported`
and are not eligible for target-ID resolution or high-level plan preparation.
The matching `unresolved_output_reference` entry lists the same target IDs.
Schema-free wildcards also remain explicit in `unsupported`; neither limitation
is converted into runtime knowledge. The compatible explicit `targetColumn`
plan input remains caller-directed and does not assert that lineage resolved.

## MCP workflows

MCP exposes a three-step composable workflow and one high-level operation:

1. `analyze_investigation_sql` returns the analysis summary.
2. `discover_investigation_targets` returns the target-discovery contract.
3. `create_investigation_plan` accepts either a discovery `targetId` or the
   compatible explicit `targetColumn` plus optional `targetNode` input.
4. `prepare_sql_investigation` starts without a known target. It returns a plan
   only when discovery has exactly one selectable target or the caller supplies
   an explicit target. Otherwise it returns the complete discovery result with
   `selection_required` and does not guess among candidates.

The composable workflow makes analysis and target-selection boundaries visible
and stops at target discovery when selection remains necessary. The high-level
workflow makes the same decision within one static call and exposes its
discovery result. Both plan paths use the same Core plan contract. The compatible
one-call `create_investigation_plan` path with a pre-known `targetColumn` is not
treated as an unknown-target high-level workflow and is not used as one in the
comparison evidence.

The repository-owned static dogfooding harness measures completion, actual MCP
call count, UTF-8 JSON bytes returned before plan creation, stage-specific error
localization, ambiguity handling, and boundary clarity across multiple SQL/DDL
scenarios from identical unknown-target inputs. Repository scenarios with
multiple selectable targets must produce `selection_required` in both workflow
shapes; a single-target scenario must produce byte-identical plans. It does not
execute scenario SQL. Real LLM tool-selection success is `UNCONFIRMED`;
deterministic harness calls are not evidence of model behavior.
