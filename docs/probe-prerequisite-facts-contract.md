# Probe prerequisite facts contract

Status: public additive version 1 contract. This document is subordinate to the
[product boundary](./product-boundary.md).

`InvestigationPlanV1.probePrerequisiteFacts` is a deterministic projection of
caller-supplied SQL, parser AST structure, lineage nodes/scopes/references,
optional `SchemaFacts`, and parameter definitions. It contains no parser class
instances, parameter values, runtime observations, database access, generated
probe SQL, or corrected SQL.

## Static facts

The contract separates aggregate-operation facts, grouping-key facts, source
relations, resolved references, provenance, and structured issues. Aggregate
facts distinguish `COUNT(*)`, column inputs, `DISTINCT`, supported aggregate
names, CASE/composite/scalar-subquery inputs, grouping/source links, owner
node/scope, and output target identity. Grouping facts distinguish columns,
aliases, ordinals, expressions, and multiple keys. Sources distinguish physical
tables, CTEs, derived relations, and unknown provenance.

Known fields survive an ambiguity or unsupported result. The implementation
does not choose the first aggregate, first grouping key, first source leaf, or a
name-based match. Unresolved references, invalid aliases/ordinals, multiple
relations, scalar subqueries, window functions, wildcards, and unsupported
dialect aggregates remain explicit issues with blocked or ambiguous status.

IDs and arrays are canonical and plan-local. Every provenance ID and fact link
must resolve within the same object. Inputs are copied before sorting and are
not mutated.

## Observation contracts

Observation contracts describe metadata for `source_row_count`,
`distinct_group_count`, `rows_per_group`,
`aggregate_input_non_null_count`, and `aggregate_input_value_summary`. They are
not probe artifacts and contain no SQL. Each contract declares expected column
semantics, linked facts and concerns, assumptions, non-conclusions,
inconclusive conditions, and structured blocked reasons. Source row counts are
represented as one contract per exact source. Aggregate-input observations are
represented as one contract per exact aggregate fact and are blocked for
`COUNT(*)`, unresolved inputs, or inputs without exactly one resolved source.

An `available` observation contract means only that its static prerequisites
are represented. It does not authorize execution, prove a root cause, show
runtime feasibility, or establish that an observed snapshot is comparable to
the incident. A future phase must separately prove safe probe construction and
execution feasibility.
