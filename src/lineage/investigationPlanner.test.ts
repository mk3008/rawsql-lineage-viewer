import { describe, expect, it } from 'vitest';
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
});
