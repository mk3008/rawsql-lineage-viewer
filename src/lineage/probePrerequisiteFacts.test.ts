import { describe, expect, it } from 'vitest';
import { createInvestigationPlan, type InvestigationPlanInputV1 } from './investigationPlan';
import { analyzeSql } from './rawsqlAdapter';
import { buildProbePrerequisiteFactsV1 } from './probePrerequisiteFacts';

function facts(sql: string, targetColumn = 'total') {
  return createInvestigationPlan({ sql, target: { columnName: targetColumn, nodeId: 'main_output' } }).probePrerequisiteFacts!;
}

describe('Probe Prerequisite Facts V1', () => {
  it.each([
    ['COUNT(*)', 'SELECT COUNT(*) AS total FROM orders', 'count', 'star', 'not_distinct'],
    ['COUNT(column)', 'SELECT COUNT(amount) AS total FROM orders', 'count', 'column', 'not_distinct'],
    ['COUNT(DISTINCT column)', 'SELECT COUNT(DISTINCT amount) AS total FROM orders', 'count', 'column', 'distinct'],
    ['SUM', 'SELECT SUM(amount) AS total FROM orders', 'sum', 'column', 'not_distinct'],
    ['CASE aggregate', "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS total FROM orders", 'sum', 'case_expression', 'not_distinct'],
  ])('classifies %s without emitting SQL', (_label, sql, operation, inputKind, distinct) => {
    const result = facts(sql);
    expect(result.aggregates[0]).toMatchObject({ distinct, inputKind, operation });
    expect(JSON.stringify(result)).not.toContain(sql);
  });

  it('represents multiple and expression grouping keys with source links', () => {
    const result = facts('SELECT customer_id + 1 AS bucket, region, SUM(amount) AS total FROM orders GROUP BY customer_id + 1, region');
    expect(result.groupingKeys.map((key) => key.kind)).toEqual(['expression', 'column']);
    expect(result.aggregates[0].groupingKeyIds).toEqual(result.groupingKeys.map((key) => key.id));
    expect(result.observations.find((item) => item.kind === 'rows_per_group')).toMatchObject({ status: 'available' });
  });

  it('blocks unresolved ordinal and window observations while preserving operation facts', () => {
    const ordinal = facts('SELECT SUM(amount) AS total FROM orders GROUP BY 2');
    expect(ordinal.groupingKeys[0]).toMatchObject({ kind: 'ordinal', status: 'blocked', issueCodes: ['group_ordinal_unresolved'] });
    const window = facts('SELECT SUM(amount) OVER (PARTITION BY customer_id) AS total FROM orders');
    expect(window.aggregates[0]).toMatchObject({ operation: 'sum', status: 'unsupported', issueCodes: ['aggregate_window_unsupported'] });
  });

  it('resolves valid GROUP BY alias and ordinal to explicit references and blocks invalid forms', () => {
    const alias = facts('SELECT o.customer_id AS cid, SUM(o.amount) AS total FROM orders o GROUP BY cid');
    expect(alias.groupingKeys[0]).toMatchObject({ kind: 'alias', status: 'available', sourceIds: ['source:001'] });
    expect(alias.groupingKeys[0].referenceIds).toHaveLength(1);
    const ordinal = facts('SELECT o.customer_id, SUM(o.amount) AS total FROM orders o GROUP BY 1');
    expect(ordinal.groupingKeys[0]).toMatchObject({ kind: 'ordinal', ordinal: 1, status: 'available', sourceIds: ['source:001'] });
    expect(ordinal.groupingKeys[0].referenceIds).toHaveLength(1);
    const duplicateAlias = facts('SELECT o.customer_id AS key, o.region AS key, SUM(o.amount) AS total FROM orders o GROUP BY key');
    expect(duplicateAlias.groupingKeys[0]).toMatchObject({ kind: 'alias', status: 'blocked', issueCodes: ['group_alias_unresolved'] });
  });

  it('resolves sibling aggregate calls independently', () => {
    const result = facts('SELECT SUM(o.amount) + COUNT(r.id) AS total FROM orders o JOIN refunds r ON r.order_id = o.id');
    expect(result.aggregates).toHaveLength(2);
    expect(result.aggregates.map((aggregate) => ({ operation: aggregate.operation, references: aggregate.inputReferenceIds, sources: aggregate.sourceIds, status: aggregate.status }))).toEqual([
      { operation: 'sum', references: ['reference:001'], sources: ['source:001'], status: 'available' },
      { operation: 'count', references: ['reference:002'], sources: ['source:002'], status: 'available' },
    ]);
  });

  it('blocks value observations for COUNT(*) and identifies row counts per source', () => {
    const countStar = facts('SELECT COUNT(*) AS total FROM orders');
    expect(countStar.observations.filter((item) => item.kind.startsWith('aggregate_input')).every((item) => item.status === 'blocked')).toBe(true);
    const joined = facts('SELECT SUM(o.amount) + COUNT(r.id) AS total FROM orders o JOIN refunds r ON r.order_id = o.id');
    const rowCounts = joined.observations.filter((item) => item.kind === 'source_row_count');
    expect(rowCounts).toHaveLength(2);
    expect(rowCounts.map((item) => item.sourceIds)).toEqual([['source:001'], ['source:002']]);
  });

  it('distinguishes physical, CTE, and derived sources', () => {
    expect(facts('SELECT SUM(amount) AS total FROM orders').sources.map((source) => source.kind)).toContain('physical_table');
    expect(facts('WITH x AS (SELECT amount FROM orders) SELECT SUM(amount) AS total FROM x').sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['cte', 'physical_table']));
    expect(facts('SELECT SUM(amount) AS total FROM (SELECT amount FROM orders) x').sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['derived', 'physical_table']));
  });

  it('projects aggregate and grouping facts from the exact CTE target scope', () => {
    const sql = 'WITH x AS (SELECT customer_id, SUM(amount) AS subtotal FROM orders GROUP BY customer_id) SELECT SUM(subtotal) AS grand_total FROM x';
    const result = createInvestigationPlan({ sql, target: { nodeId: 'cte_x', columnName: 'subtotal' } }).probePrerequisiteFacts!;
    expect(result.target).toEqual({ columnName: 'subtotal', nodeId: 'cte_x', scopeId: 'scope_cte_x', status: 'resolved' });
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]).toMatchObject({ operation: 'sum', ownerNodeId: 'cte_x', target: { columnName: 'subtotal', nodeId: 'cte_x', outputIndex: 1 } });
    expect(result.groupingKeys).toHaveLength(1);
    expect(result.groupingKeys[0]).toMatchObject({ ownerNodeId: 'cte_x', status: 'available' });
    expect(result.sources).toEqual([expect.objectContaining({ directness: 'direct', nodeId: 'table_orders', ownerNodeId: 'cte_x', ownerScopeId: 'scope_cte_x', roles: expect.arrayContaining(['query_source']) })]);
  });

  it('projects a derived target from its own query and not the outer aggregate', () => {
    const sql = 'SELECT SUM(x.amount) AS total FROM (SELECT amount FROM orders) x';
    const result = createInvestigationPlan({ sql, target: { nodeId: 'derived_x_1', columnName: 'amount' } }).probePrerequisiteFacts!;
    expect(result.target).toMatchObject({ nodeId: 'derived_x_1', status: 'resolved' });
    expect(result.aggregates).toEqual([]);
    expect(result.sources).toEqual([expect.objectContaining({ directness: 'direct', nodeId: 'table_orders', ownerNodeId: 'derived_x_1', roles: ['query_source'] })]);
  });

  it('marks CTE and derived inputs direct while keeping their physical inputs internal for the root target', () => {
    const cte = facts('WITH x AS (SELECT amount FROM orders) SELECT SUM(amount) AS total FROM x');
    expect(cte.sources).toEqual([
      expect.objectContaining({ directness: 'direct', kind: 'cte', nodeId: 'cte_x', ownerNodeId: 'main_output', roles: expect.arrayContaining(['query_source']) }),
      expect.objectContaining({ directness: 'internal', kind: 'physical_table', nodeId: 'table_orders', ownerNodeId: 'cte_x', roles: ['internal_source'] }),
    ]);
    const derived = facts('SELECT SUM(x.amount) AS total FROM (SELECT amount FROM orders) x');
    expect(derived.sources).toEqual([
      expect.objectContaining({ directness: 'direct', kind: 'derived', nodeId: 'derived_x_1', ownerNodeId: 'main_output', roles: expect.arrayContaining(['query_source']) }),
      expect.objectContaining({ directness: 'internal', kind: 'physical_table', nodeId: 'table_orders', ownerNodeId: 'derived_x_1', roles: ['internal_source'] }),
    ]);
    for (const result of [cte, derived]) {
      const directIds = new Set(result.sources.filter((source) => source.directness === 'direct').map((source) => source.id));
      expect(result.observations.filter((item) => item.kind === 'source_row_count' && item.status === 'available').every((item) => item.sourceIds.every((id) => directIds.has(id)))).toBe(true);
    }
  });

  it('excludes sibling and unused source branches from a selected target slice', () => {
    const sql = 'WITH x AS (SELECT amount FROM orders), y AS (SELECT fee FROM fees) SELECT SUM(fee) AS total FROM y';
    const result = createInvestigationPlan({ sql, target: { nodeId: 'cte_x', columnName: 'amount' } }).probePrerequisiteFacts!;
    expect(result.sources).toEqual([
      expect.objectContaining({ directness: 'direct', nodeId: 'table_orders', ownerNodeId: 'cte_x', roles: ['query_source'] }),
    ]);
    expect(result.sources.map((source) => source.nodeId)).not.toEqual(expect.arrayContaining(['cte_y', 'table_fees']));
    expect(result.references.map((reference) => reference.nodeId)).not.toEqual(expect.arrayContaining(['cte_y', 'table_fees']));
    expect(result.observations.filter((item) => item.kind === 'source_row_count')).toEqual([
      expect.objectContaining({ sourceIds: ['source:001'], status: 'available' }),
    ]);
  });

  it('excludes an unused CTE with derived and physical descendants', () => {
    const sql = 'WITH unused AS (SELECT d.fee FROM (SELECT fee FROM fees) d) SELECT SUM(amount) AS total FROM orders';
    const result = facts(sql);
    expect(result.sources).toEqual([
      expect.objectContaining({ directness: 'direct', nodeId: 'table_orders', ownerNodeId: 'main_output' }),
    ]);
    expect(result.sources.map((source) => source.nodeId)).not.toEqual(expect.arrayContaining(['cte_unused', 'table_fees']));
    expect(result.references.map((reference) => reference.nodeId)).not.toEqual(expect.arrayContaining(['cte_unused', 'table_fees']));
    expect(result.observations.filter((item) => item.kind === 'source_row_count')).toHaveLength(1);
  });

  it('distinguishes direct and nested scalar sources and blocks nested row counts', () => {
    const result = facts('SELECT SUM((SELECT MAX(r.rate) FROM rates r)) AS total FROM orders o');
    expect(result.sources).toEqual([
      expect.objectContaining({ directness: 'direct', nodeId: 'table_orders', ownerNodeId: 'main_output', roles: ['query_source'] }),
      expect.objectContaining({ directness: 'internal', nodeId: 'table_rates', ownerNodeId: 'scalar_subquery_total_1', ownerScopeId: 'scope_scalar_subquery_total_1', roles: ['internal_source'] }),
    ]);
    const rowCounts = result.observations.filter((item) => item.kind === 'source_row_count');
    expect(rowCounts).toEqual([
      expect.objectContaining({ sourceIds: ['source:001'], status: 'available' }),
      expect.objectContaining({ blockedReasons: ['observation_prerequisite_missing'], sourceIds: ['source:002'], status: 'blocked' }),
    ]);
  });

  it('fails closed when a target has no parser-backed query association', () => {
    const sql = 'SELECT SUM(amount) AS total FROM orders';
    const lineage = analyzeSql(sql, { analysisMode: 'original', optimizeConditions: false }).lineage;
    const result = buildProbePrerequisiteFactsV1({
      lineage: { ...lineage, nodes: lineage.nodes.map((node) => node.id === 'main_output' ? { ...node, id: 'detached_target', querySql: undefined } : node), scopes: lineage.scopes.map((scope) => scope.nodeId === 'main_output' ? { ...scope, nodeId: 'detached_target' } : scope) },
      parameters: { definitions: [] }, sql, target: { columnName: 'total', nodeId: 'detached_target', symptom: 'logic_review' },
    });
    expect(result.target).toMatchObject({ nodeId: 'detached_target', status: 'unsupported' });
    expect(result.aggregates).toEqual([]);
    expect(result.groupingKeys).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'target_scope_unavailable', status: 'unsupported' }));
  });

  it('preserves ambiguous JOIN input facts instead of choosing a source', () => {
    const result = facts('SELECT SUM(amount) AS total FROM orders o JOIN refunds r ON r.order_id = o.id');
    expect(result.aggregates[0]).toMatchObject({ operation: 'sum', status: 'ambiguous' });
    expect(result.aggregates[0].sourceIds).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('aggregate_input_ambiguous');
  });

  it('is deterministic, immutable, provenance-closed, and parameter-value-free', () => {
    const input: InvestigationPlanInputV1 = {
      parameters: { bindingPresence: { providedNames: ['status'] }, definitions: [{ name: 'status', origin: 'original_query_parameter' }] },
      sql: 'SELECT SUM(amount) AS total FROM orders WHERE status = :status GROUP BY customer_id',
      target: { columnName: 'total', nodeId: 'main_output' },
    };
    const before = structuredClone(input);
    const first = createInvestigationPlan(input).probePrerequisiteFacts!;
    const second = createInvestigationPlan({ ...input, parameters: { ...input.parameters!, definitions: [...input.parameters!.definitions].reverse() } }).probePrerequisiteFacts!;
    expect(first).toEqual(second);
    expect(input).toEqual(before);
    const provenance = new Set(first.provenance.map((item) => item.id));
    for (const item of [...first.aggregates, ...first.groupingKeys, ...first.references, ...first.sources]) {
      expect(item.provenanceIds.every((id) => provenance.has(id))).toBe(true);
    }
    expect(first.parameterDefinitionIds.every((id) => provenance.has(id))).toBe(true);
    const factIds = new Set([...first.aggregates, ...first.groupingKeys, ...first.references, ...first.sources].map((item) => item.id));
    for (const issue of first.issues) expect(issue.factIds.every((id) => factIds.has(id))).toBe(true);
    for (const aggregate of first.aggregates) {
      expect(aggregate.groupingKeyIds.every((id) => factIds.has(id))).toBe(true);
      expect(aggregate.inputReferenceIds.every((id) => factIds.has(id))).toBe(true);
      expect(aggregate.sourceIds.every((id) => factIds.has(id))).toBe(true);
    }
    expect(JSON.stringify(first)).not.toContain('opaque-secret');
  });

  it('normalizes reversed lineage collection order to the same result', () => {
    const sql = 'SELECT SUM(o.amount) AS total FROM orders o GROUP BY o.customer_id';
    const lineage = analyzeSql(sql, { analysisMode: 'original', optimizeConditions: false }).lineage;
    const forward = buildProbePrerequisiteFactsV1({ lineage, parameters: { definitions: [] }, sql, target: { columnName: 'total', nodeId: 'main_output', symptom: 'logic_review' } });
    const reversed = buildProbePrerequisiteFactsV1({
      lineage: { ...lineage, nodes: [...lineage.nodes].reverse().map((node) => ({ ...node, columns: [...node.columns].reverse().map((column) => ({ ...column, upstream: [...(column.upstream ?? [])].reverse() })) })), scopes: [...lineage.scopes].reverse() },
      parameters: { definitions: [] }, sql, target: { columnName: 'total', nodeId: 'main_output', symptom: 'logic_review' },
    });
    expect(reversed).toEqual(forward);
  });

  it('closes every public Id and Ids link against represented facts or provenance', () => {
    const plan = createInvestigationPlan({
      parameters: { definitions: [{ name: 'status', origin: 'original_query_parameter' }] },
      sql: 'SELECT o.customer_id AS cid, SUM(o.amount) + COUNT(r.id) AS total FROM orders o JOIN refunds r ON r.order_id = o.id WHERE o.status = :status GROUP BY cid',
      target: { columnName: 'total', nodeId: 'main_output' },
    });
    const result = plan.probePrerequisiteFacts!;
    const represented = new Set<string>([
      ...result.aggregates.map((item) => item.id), ...result.groupingKeys.map((item) => item.id), ...result.observations.map((item) => item.id),
      ...result.references.map((item) => item.id), ...result.sources.map((item) => item.id), ...result.provenance.map((item) => item.id),
      ...result.provenance.map((item) => item.sourceId), ...plan.candidateConcerns.map((item) => item.id), ...result.parameterDefinitionIds,
    ]);
    const visitIds = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'id') continue;
        if (key.endsWith('Id') && typeof nested === 'string') expect(represented.has(nested), `${key}=${nested}`).toBe(true);
        else if (key.endsWith('Ids') && Array.isArray(nested)) for (const id of nested) expect(represented.has(String(id)), `${key}=${id}`).toBe(true);
        else if (Array.isArray(nested)) nested.forEach(visitIds);
        else visitIds(nested);
      }
    };
    visitIds(result);
    expect(JSON.stringify(result)).not.toContain('inputExpressionId');
  });

  it('fails closed for scalar subqueries, unknown windows, wildcard ambiguity, and absent grouping', () => {
    const scalar = facts('SELECT SUM((SELECT MAX(value) FROM rates)) AS total FROM orders');
    expect(scalar.aggregates).toHaveLength(1);
    expect(scalar.aggregates[0].issueCodes).toContain('aggregate_input_scalar_subquery');
    expect(facts('SELECT mystery_metric(amount) OVER () AS total FROM orders').aggregates[0]).toMatchObject({ operation: 'unknown', status: 'unsupported' });
    expect(facts('SELECT SUM(amount) AS total FROM orders o JOIN refunds r ON r.order_id = o.id').aggregates[0]).toMatchObject({ status: 'ambiguous', sourceIds: [] });
    expect(facts('SELECT SUM(amount) AS total FROM orders').observations.filter((item) => item.kind === 'rows_per_group' || item.kind === 'distinct_group_count').every((item) => item.status === 'blocked')).toBe(true);
  });

  it('keeps observation semantics structured and non-conclusive', () => {
    const result = facts('SELECT SUM(amount) AS total FROM orders GROUP BY customer_id');
    expect(result.observations.map((item) => item.kind).sort()).toEqual([
      'source_row_count', 'distinct_group_count', 'rows_per_group', 'aggregate_input_non_null_count', 'aggregate_input_value_summary',
    ].sort());
    expect(result.observations.every((item) => item.doesNotProve.length > 0 && item.assumptions.length > 0 && item.inconclusiveWhen.length > 0)).toBe(true);
  });
});
