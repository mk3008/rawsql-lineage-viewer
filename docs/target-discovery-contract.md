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

## Supported surfaces

Core exposes `discoverInvestigationTargets`, `resolveInvestigationTarget`, and
`createInvestigationPlanForTarget`. The CLI exposes `analyze`, `discover`, and
`investigate`; callers select a target explicitly from discovery output.

MCP workflows and their comparison harness have been retired. Earlier MCP
workflow measurements remain historical evidence only and do not describe a
currently supported transport.
