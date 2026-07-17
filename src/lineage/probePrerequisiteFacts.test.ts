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

  it('distinguishes physical, CTE, and derived sources', () => {
    expect(facts('SELECT SUM(amount) AS total FROM orders').sources.map((source) => source.kind)).toContain('physical_table');
    expect(facts('WITH x AS (SELECT amount FROM orders) SELECT SUM(amount) AS total FROM x').sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['cte', 'physical_table']));
    expect(facts('SELECT SUM(amount) AS total FROM (SELECT amount FROM orders) x').sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['derived', 'physical_table']));
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

  it('keeps observation semantics structured and non-conclusive', () => {
    const result = facts('SELECT SUM(amount) AS total FROM orders GROUP BY customer_id');
    expect(result.observations.map((item) => item.kind)).toEqual([
      'source_row_count', 'distinct_group_count', 'rows_per_group', 'aggregate_input_non_null_count', 'aggregate_input_value_summary',
    ]);
    expect(result.observations.every((item) => item.doesNotProve.length > 0 && item.assumptions.length > 0 && item.inconclusiveWhen.length > 0)).toBe(true);
  });
});
