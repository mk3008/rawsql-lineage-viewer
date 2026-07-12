import { describe, expect, it } from 'vitest';
import type { InvestigationNodeQueryContextV1 } from './investigationPlan';
import type { ColumnDiagnosticPacket } from './diagnostics';
import { createInvestigationPlan, createInvestigationPlanFromDiagnosticPacket } from './investigationPlan';
import { analyzeSql } from './rawsqlAdapter';

function packet(overrides: Partial<ColumnDiagnosticPacket> = {}): ColumnDiagnosticPacket {
  return {
    candidateConcerns: [{ checkDomains: ['data_condition'], confidence: 'possible', effects: ['row_filter'], evidence: ['status = :status'], impact: ['may_filter_rows'], influenceIds: ['influence:where'], kind: 'where', mechanisms: ['where'], reason: 'The WHERE predicate may exclude rows.', scopeId: 'scope:orders', signals: ['where'] }],
    columnLineage: { caseRules: [], expressionChain: [], expressions: [], references: [], root: 'orders.status', scopeChain: [], sourceLeaves: [{ columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', nodeType: 'table', scopeId: 'scope:orders' }], summary: { caseRuleCount: 0, expressionStepCount: 0, intermediateReferenceCount: 0, sourceLeafCount: 1 } },
    diagnostics: [], kind: 'column-diagnostic-packet', omittedContext: { message: '', omittedColumnCount: 0, omittedInfluenceCount: 0, omittedNodeCount: 0 },
    rowLineage: { influences: [{ effects: ['row_filter'], expressionSql: 'status = :status', id: 'influence:where', kind: 'where', mechanism: 'where', references: [{ columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', roles: ['row_lineage'], scopeId: 'scope:orders', usages: [{ role: 'row_lineage', scopeId: 'scope:orders', usageKind: 'where' }] }], signals: ['where'], scopeId: 'scope:orders' }], nodeImpacts: [], summary: '' },
    target: { columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', nodeType: 'table', scopeId: 'scope:orders' }, version: 1, views: { columnLineageTree: { derivedFrom: 'columnLineage', tree: [] } },
    ...overrides,
  };
}

describe('createInvestigationPlan', () => {
  it('is deterministic and analyzes only the original diagnostic packet', () => {
    const input = { sql: 'SELECT o.status FROM orders o WHERE o.status = :status', target: { columnName: 'status', nodeId: 'main_output' }, symptom: 'missing_rows' as const, parameters: [{ name: 'status', origin: 'original_query_parameter' as const, required: true, value: 'paid' }] };
    expect(createInvestigationPlan(input)).toEqual(createInvestigationPlan(input));
    expect(createInvestigationPlan(input).analysisMode).toBe('original');
    expect(createInvestigationPlan(input).diagnostics[0].code).toBe('original_sql_only');
  });

  it('preserves the supplied symptom on the investigation target and defaults deterministically', () => {
    const base = { sql: 'SELECT status FROM orders WHERE status IS NOT NULL', target: { columnName: 'status', nodeId: 'main_output' } };
    expect(createInvestigationPlan({ ...base, symptom: 'missing_rows' }).target.symptom).toBe('missing_rows');
    expect(createInvestigationPlan(base).target.symptom).toBe('logic_review');
  });

  it('uses submitted SQL and parser-backed fragments for standalone read-only SELECT probes without inlining values', () => {
    const plan = createInvestigationPlan({ sql: 'SELECT status FROM orders WHERE status IS NOT NULL', target: { columnName: 'status', nodeId: 'main_output' }, parameters: [{ name: 'status', origin: 'original_query_parameter', value: 'paid' }] });
    expect(plan.recommendedProbes).toHaveLength(1);
    expect(plan.recommendedProbes[0]).toMatchObject({ readOnly: true, sql: 'SELECT COUNT(*) AS candidate_rows FROM orders WHERE (status is not null)' });
    expect(plan.recommendedProbes[0].sql).not.toContain('paid');
    for (const probe of plan.recommendedProbes) {
      expect(() => analyzeSql(probe.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
    }
  });

  it('keeps parameter origins separate and marks absent required values unresolved', () => {
    const plan = createInvestigationPlan({ sql: 'SELECT o.status FROM orders o WHERE o.status = :status', target: { columnName: 'status', nodeId: 'main_output' }, parameters: [
      { name: 'status', origin: 'original_query_parameter', value: 'paid' },
      { name: 'customer_id', origin: 'investigation_key', required: true },
      { name: 'start_date', origin: 'derived_parameter', value: '2026-01-01' },
      { name: 'database_timezone', origin: 'environment_parameter' },
    ] });
    expect(plan.parameters.map((item) => item.origin)).toEqual(['derived_parameter', 'environment_parameter', 'original_query_parameter', 'unresolved_parameter']);
    expect(plan.unresolvedParameters).toMatchObject([{ name: 'customer_id', status: 'unresolved' }]);
  });

  it('blocks a probe when a usable source relation is unavailable', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(packet({ columnLineage: { ...packet().columnLineage, sourceLeaves: [] } }));
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'UNSUITABLE_PROBE_SOURCE', status: 'blocked' }]);
    expect(plan.limitations).toEqual(expect.arrayContaining([{ code: 'unsuitable_probe_source', message: expect.any(String) }]));
  });

  it('limits recommendations to three deterministic probes', () => {
    const concerns = ['where', 'where', 'where', 'where'].map((kind, index) => ({
      ...packet().candidateConcerns[0], evidence: [`status = :status_${index}`], kind, scopeId: `scope:${kind}`,
    }));
    const plan = createInvestigationPlanFromDiagnosticPacket(packet({ candidateConcerns: concerns }));
    expect(plan.recommendedProbes).toHaveLength(3);
    expect(plan.deferredProbes).toHaveLength(1);
    expect(plan.recommendedProbes.every((probe) => probe.sql.startsWith('SELECT '))).toBe(true);
    for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
      expect(() => analyzeSql(probe.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
    }
  });

  it('never interpolates prose or unsafe candidate evidence into probe SQL', () => {
    const unsafePacket = packet({
      candidateConcerns: [{ ...packet().candidateConcerns[0], evidence: ['This is prose; DROP TABLE orders;'] }],
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(unsafePacket);
    expect(plan.recommendedProbes[0].sql).toBe('SELECT COUNT(*) AS candidate_rows FROM orders WHERE (status = :status)');
    expect(plan.recommendedProbes[0].sql).not.toContain('DROP TABLE');
    expect(plan.recommendedProbes[0].sql).not.toContain('This is prose');
  });

  it('blocks when only diagnostic evidence exists without a parser-backed predicate', () => {
    const missingFragmentPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: undefined }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(missingFragmentPacket);
    expect(plan.blockedProbes).toMatchObject([{ code: 'SAFE_PROBE_FRAGMENT_UNAVAILABLE', status: 'blocked' }]);
  });

  it('blocks an ON/join concern instead of embedding it in a WHERE probe', () => {
    const joinPacket = packet({
      candidateConcerns: [{ ...packet().candidateConcerns[0], kind: 'join_on', influenceIds: ['influence:join'] }],
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], id: 'influence:join', kind: 'join_on', mechanism: 'join', expressionSql: 'orders.customer_id = customers.id' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(joinPacket);
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'UNSUPPORTED_CONCERN_KIND', status: 'blocked' }]);
  });

  it('blocks an alias-qualified WHERE predicate when the alias cannot be reconstructed', () => {
    const aliasPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: 'o.status IS NOT NULL' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(aliasPacket);
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'ALIAS_MAPPING_UNAVAILABLE', status: 'blocked' }]);
  });

  it('wraps a proven selected node query with an explicitly supplied investigation key without changing its SQL', () => {
    const query = 'SELECT p.customer_id, sum(p.amount) AS paid_amount FROM payments p WHERE p.status = :status GROUP BY p.customer_id';
    const nodeQuery = analyzeSql(query, { analysisMode: 'original', optimizeConditions: false }).lineage.nodes.find((node) => node.id === 'main_output')?.querySql;
    const plan = createInvestigationPlan({
      sql: query,
      target: { columnName: 'paid_amount', nodeId: 'main_output' },
      symptom: 'value_too_low',
      parameters: [
        { name: 'customer_id', origin: 'investigation_key', value: 10 },
        { name: 'status', origin: 'original_query_parameter', value: 'succeeded' },
      ],
    });
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');

    expect(probe).toMatchObject({
      id: 'probe:node-query-outer-filter:01',
      kind: 'node_query_outer_filter',
      nodeId: 'main_output',
      priority: 1,
      readOnly: true,
    });
    expect(probe?.sql).toContain(`FROM (\n${nodeQuery}\n) AS investigation_node`);
    expect(probe?.sql).toContain('investigation_node."customer_id" = :customer_id');
    expect(probe?.sql).not.toContain('= 10');
    expect(probe?.sql).not.toContain('succeeded');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'status']);
    expect(plan.parameters.find((parameter) => parameter.name === 'customer_id')?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    expect(plan.parameters.find((parameter) => parameter.name === 'status')?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    expect(() => analyzeSql(probe!.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
  });

  it('requires every investigation key, sorts them, and applies each as an outer AND condition', () => {
    const context = contextFor('SELECT customer_id, region_id, amount FROM payments WHERE status = :status', [
      { name: 'customer_id', outputIndex: 0 }, { name: 'region_id', outputIndex: 1 }, { name: 'amount', outputIndex: 2 },
    ]);
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), [
      { name: 'region_id', origin: 'investigation_key', value: 20 },
      { name: 'customer_id', origin: 'investigation_key', value: 10 },
      { name: 'status', origin: 'original_query_parameter', value: 'paid' },
    ], 'value_too_low', context);
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');

    expect(probe?.sql).toContain('investigation_node."customer_id" = :customer_id AND investigation_node."region_id" = :region_id');
    expect(probe?.sql).not.toContain('= 10');
    expect(probe?.sql).not.toContain('= 20');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'region_id', 'status']);
    for (const name of ['customer_id', 'region_id']) {
      expect(plan.parameters.find((parameter) => parameter.name === name)?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    }
  });

  it('blocks the whole node query probe when any investigation key is not exactly exposed', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), [
      { name: 'customer_id', origin: 'investigation_key', value: 10 },
      { name: 'missing_key', origin: 'investigation_key', value: 20 },
    ], 'value_too_low', contextFor('SELECT customer_id FROM payments WHERE status = :status', [{ name: 'customer_id', outputIndex: 0 }]));

    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'INVESTIGATION_KEY_NOT_EXPOSED' }));
  });

  it('blocks duplicate investigation key names rather than creating a partial filter', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), [
      { name: 'customer_id', origin: 'investigation_key', value: 10 },
      { name: 'customer_id', origin: 'investigation_key', value: 11 },
    ], 'value_too_low', contextFor('SELECT customer_id FROM payments WHERE status = :status', [{ name: 'customer_id', outputIndex: 0 }]));
    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'INVESTIGATION_KEY_DUPLICATE' }));
  });

  it('collects only parser-recognized parameters, not cast names, strings, comments, or quoted identifiers', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), [{ name: 'customer_id', origin: 'investigation_key', value: 10 }], 'value_too_low', contextFor(
      "SELECT customer_id FROM payments WHERE status = :status::text AND note <> ':fake' /* :comment */",
      [{ name: 'customer_id', outputIndex: 0 }],
    ));
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'status']);
  });

  it('returns a structured block when generated candidate SQL cannot reparse', () => {
    const invalidPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: 'status = (1' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(invalidPacket);
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'PROBE_REPARSE_FAILED', status: 'blocked' }));
  });

  it.each([
    ['missing key output', contextFor('SELECT total FROM payments', [{ name: 'total', outputIndex: 0 }]), 'INVESTIGATION_KEY_NOT_EXPOSED'],
    ['duplicate key output', contextFor('SELECT customer_id, customer_id FROM payments', [{ name: 'customer_id', outputIndex: 0 }, { name: 'customer_id', outputIndex: 1 }]), 'AMBIGUOUS_OUTPUT_COLUMN'],
    ['unresolved wildcard', { ...contextFor('SELECT customer_id FROM payments', [{ name: 'customer_id', outputIndex: 0 }]), analysisWarnings: [{ code: 'wildcard_unresolved_without_schema', message: 'Wildcard expansion is unresolved.' }] }, 'UNRESOLVED_WILDCARD'],
    ['absent node query', contextFor(undefined, [{ name: 'customer_id', outputIndex: 0 }]), 'NODE_QUERY_UNAVAILABLE'],
    ['non-SELECT node query', contextFor('DELETE FROM payments', [{ name: 'customer_id', outputIndex: 0 }]), 'NODE_QUERY_UNAVAILABLE'],
    ['source alias only', contextFor('SELECT p.amount FROM payments p', [{ name: 'amount', outputIndex: 0 }]), 'INVESTIGATION_KEY_NOT_EXPOSED'],
  ])('blocks the outer-filter probe for %s', (_label, context, code) => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), [{ name: 'customer_id', origin: 'investigation_key', value: 10 }], 'value_too_low', context);
    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code, status: 'blocked' }));
  });
});

function nodeQueryPacket(): ColumnDiagnosticPacket {
  const base = packet();
  return {
    ...base,
    target: { ...base.target, nodeId: 'main_output' },
  };
}

function contextFor(querySql: string | undefined, columns: Array<{ name: string; outputIndex: number }>): InvestigationNodeQueryContextV1 {
  return {
    analysisWarnings: [],
    nodes: [{ columns: columns.map((column) => ({ id: `main_output.${column.name}.${column.outputIndex}`, ...column })), id: 'main_output', label: 'Final Result', querySql, type: 'output' }],
    scopes: [{ id: 'scope:orders', kind: 'select', nodeId: 'main_output' }],
  };
}
