# Probe feasibility decision V1

Status: utility ceiling accepted for Phase C. No new probe SQL is generated.

This decision evaluates the additive
[`ProbePrerequisiteFactsV1`](./probe-prerequisite-facts-contract.md) contract
against the eight Phase-C feasibility conditions. An observation being
`available` means that its static facts are represented; it does not mean that
an executable observation can be reconstructed safely.

## Decision

No observation kind satisfies all eight conditions. Candidate selection is
therefore deterministically `none`, without ranking by names, aliases, array
order, first items, or source leaves. The product retains the accepted static
facts and does not add an `aggregate_grain`, `exists_coverage`, or
`join_cardinality` SQL artifact.

The blocking condition common to every kind is complete SQL artifact
provenance. Version 1 records parser, lineage node/scope, schema-fact, and
parameter-definition provenance IDs, but deliberately contains no SQL or AST
object from which the exact observation scope can be reconstructed. Without an
artifact, parser-backed SELECT-only validation cannot validate the generated
statement. Parameter definitions also do not provide authorized runtime
bindings, and observation contracts do not identify faulty/control fixtures or
an expected comparison oracle.

## Feasibility matrix

`yes` means the contract supplies deterministic evidence for the condition.
`n/a` means the observation does not require that fact. `no` blocks probe
generation.

| Observation kind | Resolved input / grouping | Resolved source | Complete SQL artifact provenance | Syntactic safety | Expected columns | Interpretation | Non-disclosing binding | Faulty/control benchmark | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `source_row_count` | n/a | yes, only for a source proven resolved and direct | no | no | yes | yes | no | no | blocked |
| `distinct_group_count` | yes, only when every grouping fact and reference is available | yes, only when every linked source is resolved and direct | no | no | yes | yes | no | no | blocked |
| `rows_per_group` | yes, only when every grouping fact and reference is available | yes, only when every linked source is resolved and direct | no | no | yes | yes | no | no | blocked |
| `aggregate_input_non_null_count` | yes, only for one available non-star input with resolved references | yes, only for exactly one resolved direct source | no | no | yes | yes | no | no | blocked |
| `aggregate_input_value_summary` | yes, only for one available non-star input with resolved references | yes, only for exactly one resolved direct source | no | no | yes | yes | no | no | blocked |

The `yes` entries above are conditional availability rules already enforced by
the version 1 contract. They do not compensate for any `no` entry. In
particular, a resolved source node ID is not an exact SQL relation artifact,
and a parameter definition ID is not an executable binding.

## Repository evidence

- `observationContracts` creates exactly the five versioned observation kinds,
  deterministic expected columns, assumptions, non-conclusions, and
  inconclusive states. It blocks unresolved grouping, aggregate input, and
  source links.
- `ProbePrerequisiteFactsV1.provenance` is limited to lineage nodes/scopes,
  parameter definitions, parser-AST identity, and schema facts. The public
  contract explicitly excludes SQL and parser class instances.
- Static SELECT inspection exists for current `InvestigationPlanV1` probe
  artifacts, but it accepts a complete SQL string. The prerequisite contract
  supplies no complete candidate string to inspect.
- Planner parameter validation rejects values and exposes definitions plus
  binding presence only. This preserves confidentiality but cannot construct
  authorized benchmark bindings.
- The external Utility Benchmark V1 executes only selected
  `recommendedProbes` and owns its private faulty/control fixtures and oracle.
  Observation contracts contain no deterministic mapping to those artifacts.

The focused prerequisite tests cover resolved and rejected aggregate inputs,
grouping keys, direct/internal/ambiguous sources, CTE and derived ownership,
unsupported syntax, repeated runs, reverse-order inputs, provenance closure,
parameter-value rejection, and non-mutation. Existing CLI and MCP tests prove
that the same prerequisite contract shape crosses both adapters.

## Utility ceiling

The product can state which observations are statically supportable and why an
observation is blocked. It cannot yet emit immediately runnable observation SQL
from those facts without adding authority that version 1 intentionally does
not possess. Existing plan probes remain unchanged; this decision neither
endorses them as aggregate-grain probes nor broadens Core, CLI, or MCP database
authority.

Minimum additional metadata for a future Phase-C attempt is:

1. A versioned, provenance-closed SELECT source artifact for the exact owning
   scope, including an unambiguous mapping from every selected source,
   grouping key, and aggregate input to that artifact.
2. A parser-backed construction contract that proves the complete generated
   statement is one bounded SELECT tree and declares its exact output shape.
3. An external binding manifest that maps placeholder definitions to
   authorized synthetic values without placing values in Core, CLI, MCP,
   plans, logs, or reports.
4. A benchmark scenario manifest that binds exactly one generated artifact to
   isolated faulty/control fixtures, expected observations, and an explicit
   comparison oracle.

Until all four are present, inability to generate a probe is an automatic safe
fallback, not a human blocker. Distribution and Viewer work may proceed with
the documented utility ceiling.
