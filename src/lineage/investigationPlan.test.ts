import { describe, expect, it } from 'vitest';
import type { InvestigationParameterV1, InvestigationPlanV1 } from './investigationPlan';

describe('InvestigationPlanV1 contract', () => {
  it('represents the Phase A target, parameter origins, and direct probe groups', () => {
    const originalStatus: InvestigationParameterV1 = {
      id: 'parameter:status', name: 'status', origin: 'original_query_parameter', required: true,
      status: 'provided', typeHint: 'text',
      usedBy: [{ analysisMode: 'original', kind: 'original_analysis' }, { kind: 'probe', probeId: 'probe:status-count' }],
      value: 'paid',
    };
    const plan = {
      analysisMode: 'original',
      blockedProbes: [{ code: 'JOIN_KEY_UNAVAILABLE', id: 'probe:join-cardinality', reason: 'A required join key is unavailable.', status: 'blocked' }],
      candidateConcerns: [{ evidence: ['orders.status = :status'], hypothesis: 'The predicate may exclude rows.', id: 'concern:where:1', limitations: ['No database result was inspected.'], status: 'candidate' }],
      deferredProbes: [],
      diagnostics: [{ code: 'sql_only', message: 'Diagnosis is based only on SQL analysis.' }],
      kind: 'investigation-plan',
      limitations: [{ code: 'no_database_access', message: 'No database result was inspected.' }],
      parameters: [
        originalStatus,
        { id: 'parameter:investigation-key', name: 'customer_id', origin: 'investigation_key', required: true, status: 'required', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] },
        { id: 'parameter:derived', name: 'start_date', origin: 'derived_parameter', required: false, status: 'provided', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }], value: '2026-01-01' },
        { id: 'parameter:environment', name: 'database_timezone', origin: 'environment_parameter', required: false, status: 'required', typeHint: 'iana-timezone', usedBy: [] },
        { id: 'parameter:missing', name: 'tenant_id', origin: 'unresolved_parameter', required: true, status: 'unresolved', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] },
      ],
      recommendedProbes: [{ confidence: 'possible', hypothesis: 'The status predicate may exclude rows.', id: 'probe:status-count', kind: 'row_count_comparison', limitations: ['Results require a read-only execution environment.'], nodeId: 'table_orders', parameters: [originalStatus], priority: 1, priorityReasons: ['Directly tests the candidate predicate.'], question: 'How many rows match the supplied status?', readOnly: true, reason: 'Compare the predicate-constrained row count.', sql: 'select count(*) from orders where status = :status' }],
      target: { columnName: 'status', nodeId: 'main_output', symptom: 'missing_rows' },
      unresolvedParameters: [{ id: 'parameter:missing', name: 'tenant_id', origin: 'unresolved_parameter', required: true, status: 'unresolved', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] }],
      version: 1,
    } satisfies InvestigationPlanV1;

    expect(plan.analysisMode).toBe('original');
    expect(plan.target).toEqual({ columnName: 'status', nodeId: 'main_output', symptom: 'missing_rows' });
    expect(plan.parameters.map((parameter) => parameter.origin)).toEqual(['original_query_parameter', 'investigation_key', 'derived_parameter', 'environment_parameter', 'unresolved_parameter']);
    expect(plan.recommendedProbes[0].readOnly).toBe(true);
    expect(plan.deferredProbes).toEqual([]);
    expect(plan.blockedProbes[0]).toMatchObject({ code: 'JOIN_KEY_UNAVAILABLE', reason: expect.any(String) });
    expect(plan.unresolvedParameters[0].status).toBe('unresolved');
  });
});
