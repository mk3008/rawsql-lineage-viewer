# Lineage Maintenance Map

This document is a navigation map for AI-assisted maintenance of the lineage feature.
Its goal is token efficiency: when a bug or feature request arrives, the maintainer
should be able to identify the smallest files and tests to read before editing.

Do not treat this as a mandate to move everything at once. It describes the target
slice structure and the intended migration order.

## Current Hotspots

The current codebase has several large files where unrelated change reasons are
co-located. These files are understandable, but they are expensive for AI agents
because small changes often require reading a broad context.

| File | Current responsibility mix | Token-efficiency issue |
| --- | --- | --- |
| `src/lineage/rawsqlAdapter.ts` | SQL parsing, source resolution, output columns, value lineage, population origin, scalar subqueries, UNION, node column finalization, warnings, comments, SQL formatting, edge generation | The adapter mixes semantic stages, so output-column bugs and population-origin bugs require reading the same large file. |
| `src/components/LineageGraph.tsx` | Graph display, graph selection, inspector UI, inspector card selection, highlight, pan/focus, group collapse, AutoLayout, diagnostic panel, history helpers, column tree building | UI state machines with different ownership are interleaved, making selection/focus/display bugs hard to isolate. |
| `src/App.tsx` | Page shell, SQL analysis, SQL history, share URL, panel state, inspector card history, graph focus request, legend persistence | Page composition and persistence workflows are mixed with lineage UI coordination. |
| `src/lineage/diagnostics.ts` | Column lineage, row lineage, diagnostic packet assembly, candidate concerns, evidence ranking, omitted context | Diagnostic semantics and presentation-oriented packet assembly live together. |
| `tests/e2e/lineage.spec.ts` | Basic rendering, editor behavior, inspector flows, group collapse, layout, share/history, SQL forms, recursive CTEs, UNION, comments | One failed E2E often requires opening a very large test file and reading unrelated workflows. |
| `src/lineage/rawsqlAdapter.test.ts` | Adapter integration, output columns, population origin, value origin, source references, SQL wrappers, comments, scalar subqueries, UNION | Test names do not consistently point to a slice. |
| `src/lineage/__snapshots__/diagnostics.test.ts.snap` | Full diagnostic packet snapshots | Small semantic changes can produce large snapshot diffs, increasing review and AI context cost. |

## Target Slice Structure

The target organization is vertical-slice oriented. Prefer change reason, user-visible
behavior, and invariants over technical layers such as generic `utils` or `hooks`.

```text
src/
  lineage/
    core/
      lineageTypes.ts
      columnRef.ts
      nodeId.ts
      scopeId.ts
      lineageKinds.ts

    output-columns/
      collectOutputColumns.ts
      finalizeDisplayColumns.ts
      outputColumns.types.ts
      outputColumnsBoundary.test.ts
      collectOutputColumns.test.ts

    value-origin/
      collectValueLineage.ts
      expressionLineage.ts
      scalarSubqueryValue.ts
      valueOrigin.types.ts
      valueOrigin.test.ts

    population-origin/
      collectPopulationScope.ts
      collectConditionInfluences.ts
      collectJoinInfluences.ts
      collectOrderLimitInfluences.ts
      populationOrigin.types.ts
      populationOriginBoundary.test.ts
      collectPopulationScope.test.ts

    source-references/
      resolveSourceExpression.ts
      resolveColumnReferences.ts
      collectSourceReferences.ts
      sourceReferences.types.ts
      sourceReferences.test.ts

    diagnostics/
      buildColumnDiagnosticPacket.ts
      analyzeColumnLineage.ts
      analyzeRowLineage.ts
      diagnosticConcerns.ts
      diagnostics.types.ts
      diagnostics.test.ts

    graph-display/
      graphDisplaySnapshot.ts
      autoLayoutVisibleNodes.ts
      reactFlowModel.ts
      graphDisplay.test.ts

    graph-selection/
      graphSelection.ts
      selectionHistory.ts
      graphSelection.test.ts

    group-collapse/
      groupCollapse.ts
      groupCollapse.test.ts

    inspector-selection/
      inspectorSelection.ts
      inspectorCardSelection.ts
      inspectorSelection.test.ts

    share-save-load/
      sqlHistory.ts
      shareUrl.ts
      persistedUiState.ts
      shareSaveLoad.test.ts

    ui-shell/
      LineagePage.tsx
      LineageGraph.tsx
      LineageInspector.tsx
      SqlPanel.tsx
```

Keep `src/domain/lineage.ts` in place until there is a specific need to move shared
types. Early migration should import existing domain types instead of relocating them.

## Slice Responsibilities And Invariants

### `output-columns`

Owns display columns: SELECT outputs, SELECT aliases, and wildcard-expanded outputs.

Invariants:

- Only SELECT-derived columns become display columns.
- Predicate-only references from WHERE, JOIN ON, HAVING, ORDER BY, LIMIT, or OFFSET do not enter `LineageNode.columns`.
- A real SELECT alias such as `"condition 1"` remains a display column.
- This slice does not own row filtering, population impact, diagnostics concerns, graph display state, or inspector active state.

Look here when:

- A graph node shows a column that is not a SELECT output or value-lineage support column.
- A SELECT alias disappears or is renamed incorrectly.
- Wildcard expansion creates the wrong output column set.

### `population-origin`

Owns row-set and population influences: WHERE, JOIN ON, EXISTS, GROUP BY, HAVING,
ORDER BY, LIMIT, and OFFSET.

Invariants:

- Population origin is preserved in scopes and can feed diagnostics or inspector evidence.
- Population-origin-only references do not add display columns.
- Population origin does not decide graph selection, graph display, or value upstreams.

Look here when:

- WHERE/JOIN/HAVING/ORDER/LIMIT evidence is missing from diagnostics.
- Predicate-only columns leak into node columns.
- Row lineage or population badges appear to come from the wrong SQL clause.

### `value-origin`

Owns value-producing lineage: SELECT expressions, aggregate inputs, CASE result
expressions, expression trees, and scalar subquery values.

Invariants:

- Value origin tracks dependencies that create a column value.
- Predicate-only dependencies are not value origin unless they also contribute to a value expression.
- CASE conditions and CASE results must not be collapsed into the same meaning.

Look here when:

- A selected column highlights the wrong upstream value columns.
- Aggregate, CASE, scalar subquery, or expression lineage is missing or over-included.

### `source-references`

Owns source and column reference resolution.

Invariants:

- Resolving a reference does not mutate `LineageNode.columns`.
- Qualified and unqualified reference behavior is tested independently from output column creation.
- Unresolved reference warnings are generated without inventing display columns.

Look here when:

- Qualified aliases resolve incorrectly.
- Unqualified columns are guessed when they should be ambiguous.
- Missing sources or columns produce confusing dead-link warnings.

Phase 2.5 dependency classification:

| Dependency | Classification | Notes |
| --- | --- | --- |
| `resolveColumnReferences` | `source-references` | Core reference resolver for qualified, unqualified, unknown, and ambiguous references. Used by population, output, and value logic, so extract before moving `collectPopulationScope`. |
| `toSourceReferences` | `source-references` adapter | Converts resolved column refs into scoped `LineageSourceReference` objects. It is small, but belongs near reference resolution once scope id and role are passed in. |
| `mergeColumnRefs` | shared reference utility | Deduplicates resolved refs and is used by population and value lineage. Keep it tiny and dependency-free before moving. |
| `formatExpressionSql` | shared SQL formatting utility | Needed for diagnostics, population-origin expressions, unresolved reference messages, and display text. Do not hide it inside `population-origin`. |
| `collectNestedQueryReferences` | keep in `rawsqlAdapter.ts` for now | It resolves nested query sources by calling `resolveSourceExpression` and mutating local analysis state. Moving it now would pull adapter orchestration with it. |
| `collectQueryLocalReferences` | keep in `rawsqlAdapter.ts` for now | Same coupling as nested query references: it needs CTE names, nodes, scopes, warnings, counters, schema facts, and source resolution. |
| `ResolvedSource` | shared adapter/source type | This is the main type crossing source resolution, output columns, value origin, and population origin. Move only after the public shape is stable. |
| `CollectQueryEdgesOptions` | keep in `rawsqlAdapter.ts` for now | This is orchestration state, not a slice contract. Passing it through a deps interface would make the interface too large. |

Minimum extraction order:

1. Add boundary tests for `source-references` behavior through `analyzeSql`.
2. Extract dependency-free helpers first: `mergeColumnRefs`, then `resolveColumnReferences` with its issue helpers if the `ResolvedSource` type can be moved or narrowed.
3. Keep nested query reference collection in `rawsqlAdapter.ts` until `resolveSourceExpression` has its own boundary.
4. Move `collectPopulationScope` only after it can depend on a small resolver API instead of the whole `CollectQueryEdgesOptions` object.

Avoid a large `PopulationOriginDeps` interface for now. A small injected resolver can work later, but an interface containing `resolveSourceExpression`, counters, nodes, scopes, warnings, CTE names, and schema facts would preserve the current coupling under a new name.

### `diagnostics`

Owns diagnostic packets, row lineage analysis, column lineage analysis, candidate
concerns, evidence ranking, and diagnostic text/view models.

Invariants:

- Diagnostics read from `LineageModel`, column upstreams, and scopes.
- Diagnostics do not mutate model columns or graph display state.
- Full snapshots are not the primary proof for semantic invariants; slice assertions should cover semantics first.

Look here when:

- Diagnostic evidence, concern ranking, or row/column lineage packets are wrong.
- Snapshot changes are limited to diagnostic presentation or packet shape.

### `graph-display`

Owns what appears in the graph and how graph nodes/edges are mapped to ReactFlow.

Invariants:

- Graph display changes visible structure only.
- Graph display does not alter lineage semantics, diagnostics packets, or inspector active cards.
- AutoLayout visible nodes come from graph display state, not from inspector card selection.

Look here when:

- AutoLayout hides or shows the wrong nodes.
- Collapsed groups or display snapshots produce the wrong graph model.
- ReactFlow node/edge props are mapped incorrectly.

### `graph-selection`

Owns graph-origin selection and selection history from graph clicks.

Invariants:

- Graph selection is updated by graph interactions.
- Graph selection is not the same as inspector active card.
- Pan/focus requests are not selection changes.

Look here when:

- Clicking graph nodes/columns selects the wrong origin.
- Browser back/forward restores graph selection incorrectly.
- Selection changes unexpectedly alter inspector card activity.

### `group-collapse`

Owns collapsed group state and group expansion/collapse commands.

Invariants:

- Group collapse changes display structure only.
- Group collapse does not change lineage semantics, row/value evidence, badges, or diagnostic packets.
- Expanding a group is not an origin-selection change.

Look here when:

- GROUP expand/collapse hides the wrong helpers.
- Collapse reset does not return to the intended initial grouped state.
- Group operations accidentally change selection or diagnostics.

### `inspector-selection`

Owns inspector active card and card-driven pan/focus requests.

Invariants:

- Inspector card clicks update active card state and may request pan/focus.
- Inspector card clicks do not update graph origin selection or graph display snapshot.
- The graph selected-column marker may follow a card when explicitly modeled as display feedback, not as graph origin.

Look here when:

- Inspector card active state is wrong.
- Card click changes graph origin, AutoLayout, or highlight semantics unexpectedly.
- Browser history restores inspector card state incorrectly.

### `share-save-load`

Owns share URLs, SQL history, localStorage-backed preferences, and restore behavior.

Invariants:

- Persistence restores inputs and UI preferences.
- Persistence does not mutate lineage semantics directly.
- Invalid storage or long share URLs fail gracefully.

Look here when:

- Share URLs do not restore SQL.
- SQL history records, sorts, or restores incorrectly.
- localStorage-backed UI state behaves incorrectly.

### `ui-shell`

Owns composition only.

Invariants:

- UI shell wires slices together.
- UI shell should not accumulate new business logic or state machines.
- Complex behavior belongs in the relevant slice.

Look here when:

- Props are wired to the wrong slice.
- Page layout or top-level composition changes.

## E2E Split Plan

Current file: `tests/e2e/lineage.spec.ts`.

Do not move everything at once. When splitting, move tests without changing behavior,
and keep shared helpers local or in a small `tests/e2e/helpers/lineage.ts` only when
duplication becomes obvious.

Recommended target files:

```text
tests/e2e/lineage.basic.spec.ts
tests/e2e/lineage.editor.spec.ts
tests/e2e/lineage.inspector.spec.ts
tests/e2e/lineage.group-collapse.spec.ts
tests/e2e/lineage.layout.spec.ts
tests/e2e/lineage.share-history.spec.ts
tests/e2e/lineage.sql-forms.spec.ts
```

Suggested classification:

| Target file | Current test examples |
| --- | --- |
| `lineage.basic.spec.ts` | `renders the sample SQL lineage graph on first load`, `keeps the graph in upstream flow direction`, `updates the lineage graph after editing SQL`, `renders three-way UNION chains as sibling graph parts`, `marks recursive CTEs without drawing recursive self-reference lines` |
| `lineage.editor.spec.ts` | `allows the SQL editor to scroll vertically for long queries`, `can clear the SQL editor on mobile before entering another query` |
| `lineage.inspector.spec.ts` | `shows GROUP BY usage and the selected column expression in the inspector`, `shows selected lineage details in the inspector panel`, `focuses the graph node when inspector column or table names are clicked`, `shows selected expressions with rawsql-ts formatting in the inspector`, `shows the selected column owning SQL scope in the inspector`, expression tree and CASE inspector tests |
| `lineage.group-collapse.spec.ts` | `can collapse upstream helper CTEs into a CTE group and expand them again`, `keeps row lineage badges stable when expanding a CTE group`, `keeps selected columns across group toggles after helper nodes are moved`, nested derived collapse tests |
| `lineage.layout.spec.ts` | `keeps downstream nodes visible when auto layout focuses an intermediate CTE`, drag-position tests, overlap/layout tests, expanded-column sizing tests |
| `lineage.share-history.spec.ts` | SQL history tests, hash/query parameter restore tests, share URL tests |
| `lineage.sql-forms.spec.ts` | CREATE TABLE AS SELECT, INSERT SELECT, recursive CTE, UNION, scalar subquery, WHERE EXISTS smoke tests when they are browser smoke rather than semantic proofs |

E2E should remain smoke-oriented. Semantic proof should live in slice tests.

## `rawsqlAdapter.test.ts` Split Plan

Current file: `src/lineage/rawsqlAdapter.test.ts`.

Do not move all tests at once. Prefer moving tests only after the corresponding slice
has a stable destination and boundary tests exist.

Recommended target files:

```text
src/lineage/output-columns/outputColumnsBoundary.test.ts
src/lineage/output-columns/collectOutputColumns.test.ts
src/lineage/population-origin/populationOriginBoundary.test.ts
src/lineage/population-origin/collectPopulationScope.test.ts
src/lineage/value-origin/valueOrigin.test.ts
src/lineage/source-references/sourceReferences.test.ts
src/lineage/rawsqlAdapter.integration.test.ts
```

Suggested classification:

| Target file | Current test examples |
| --- | --- |
| `output-columns/*` | output and referenced source column population, condition-only columns out of graph columns, real alias `"condition 1"`, wildcard expansion, grouped output usage when it affects display columns |
| `population-origin/*` | WHERE predicates out of graph columns, UNION branch WHERE predicates, JOIN/HAVING/ORDER references, WHERE EXISTS condition lineage, GROUP BY/HAVING/ORDER/LIMIT scope facts |
| `value-origin/*` | upstream column lineage through CTEs, CASE result lineage, composite expression trees, aggregate inputs, scalar subquery value outputs |
| `source-references/*` | qualified/unqualified column resolution, ambiguous unqualified columns, dead-link diagnostics, repeated aliases, physical table targeting |
| `rawsqlAdapter.integration.test.ts` | wrapper SQL forms such as CREATE TABLE AS SELECT, CREATE VIEW AS SELECT, INSERT SELECT, recursive CTE integration, edge wiring, comments/query SQL integration |

Keep `rawsqlAdapter.integration.test.ts` as a composition proof after slicing. It should
be smaller than the current file and avoid duplicating slice-level assertions.

## Diagnostics Snapshot Policy

Current large snapshot:

```text
src/lineage/__snapshots__/diagnostics.test.ts.snap
```

Rules:

- Do not update diagnostics snapshots for unrelated changes.
- Do not use full packet snapshots as the first proof of semantic correctness.
- Add slice-level assertions for semantic invariants before accepting snapshot changes.
- Snapshot updates should be limited to diagnostic packet shape, display text, or intentional omitted-context count changes.
- When a snapshot changes, report the reason in the final summary.

Future split options:

```text
src/lineage/diagnostics/__snapshots__/columnLineage.snap
src/lineage/diagnostics/__snapshots__/rowLineage.snap
src/lineage/diagnostics/__snapshots__/diagnosticText.snap
src/lineage/diagnostics/__snapshots__/diagnosticViewModel.snap
```

Prefer smaller targeted snapshots plus explicit assertions such as:

```text
row lineage contains WHERE EXISTS influence
candidate concerns include data_condition for predicate-only missing rows
column lineage contains CASE result upstream but not CASE condition as value source
omittedContext count changes only when model column count intentionally changes
```

## Migration Phases

### Phase 1: Boundary tests

Status: started.

Goal:

- Fix and guard the output-column vs population-origin boundary.
- Add tests under slice directories before production code moves.

### Phase 1.5: Token-efficiency foundation

Goal:

- Add this maintenance map.
- Classify E2E and adapter tests.
- Establish snapshot rules.
- Avoid production moves.

### Phase 2: Extract population origin

Suggested first production refactor:

```text
src/lineage/population-origin/collectPopulationScope.ts
```

Move only the smallest coherent group:

- `collectPopulationScope`
- `collectConditionInfluences`
- `collectOrderByInfluences`
- `collectLimitInfluence`
- `createJoinInfluence`

If dependencies make this too large, first group these helpers in `rawsqlAdapter.ts`
and keep the file move for a follow-up PR.

### Phase 3: Extract output columns

Suggested target:

```text
src/lineage/output-columns/collectOutputColumns.ts
```

Move only after dependencies are clearer. This area currently touches wildcard
expansion, scalar subqueries, expression trees, comments, and node column finalization.

### Phase 2.5: Establish source reference boundary

Before moving `collectPopulationScope` out of `rawsqlAdapter.ts`, reduce the source-reference coupling that currently blocks a small extraction.

Suggested target:

```text
src/lineage/source-references/sourceReferencesBoundary.test.ts
src/lineage/source-references/resolveColumnReferences.ts
src/lineage/source-references/mergeColumnRefs.ts
src/lineage/source-references/sourceReferences.types.ts
```

Start with tests and dependency classification. Move production helpers only when they do not require exporting broad adapter orchestration types.

### Phase 4: Extract source references and value origin

Suggested targets:

```text
src/lineage/source-references/resolveColumnReferences.ts
src/lineage/source-references/resolveSourceExpression.ts
src/lineage/value-origin/collectValueLineage.ts
```

This phase should reduce the remaining size of `rawsqlAdapter.ts`.

### Phase 5: Split diagnostics

Split after model-generation slices are stable.

Suggested targets:

```text
analyzeColumnLineage.ts
analyzeRowLineage.ts
diagnosticConcerns.ts
buildColumnDiagnosticPacket.ts
```

### Phase 6: Split UI state slices

Start after lineage semantics and diagnostics boundaries are safer.

Suggested order:

```text
inspector-selection
graph-selection
group-collapse
graph-display
ui-shell
```

### Phase 7: Split share/save/load

Move SQL history, share URL, and localStorage helpers out of `App.tsx`.

## What To Touch First

The next production refactor should be one of these:

1. Stabilize `source-references` enough that `collectPopulationScope` can call a small resolver API.
2. Extract `population-origin/collectPopulationScope.ts` after source references no longer require `CollectQueryEdgesOptions`.
3. If extraction is still too large, keep the helper block in `rawsqlAdapter.ts` and narrow one dependency at a time.
4. After that, extract `output-columns/collectOutputColumns.ts` only when dependency size is acceptable.

Do not start with `LineageGraph.tsx`. It is large, but UI slicing will be safer after
lineage model boundaries are stable.

## Working Rules For AI Agents

- Start with this document when changing lineage behavior.
- Identify the slice before reading large files.
- Prefer `rg` for the slice name and test name before opening a large file.
- Do not move shared domain types unless the task explicitly requires it.
- Do not make broad snapshot updates without slice-level semantic assertions.
- Do not mix graph origin selection, inspector active card, pan/focus, and display snapshot changes in one patch unless the request explicitly spans them.
- Keep PRs small enough that the changed files point to one slice or one migration phase.
