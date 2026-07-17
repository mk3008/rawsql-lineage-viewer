import { describe, expect, it } from 'vitest';
import { sqlArtifactKinds, type InvestigationParameterV1, type InvestigationPlanV1, type ProbeStaticSafetyEvidenceV1 } from './investigationPlan';

const staticSafetyEvidence = {
  assumptions: ['The SQL is interpreted by the parser version bundled with this product.'],
  basis: 'parser_ast',
  confidence: 'syntax_only',
  executionCaveats: ['This static classification does not authorize execution.'],
  statementClassification: 'select_statement',
  version: 1,
} satisfies ProbeStaticSafetyEvidenceV1;

describe('InvestigationPlanV1 contract', () => {
  it('exports only the accepted SQL artifact taxonomy', () => {
    expect(sqlArtifactKinds).toEqual(['original_query', 'equivalent_rewrite', 'investigation_probe']);
    expect(sqlArtifactKinds).not.toContain('corrected_query');
  });

  it('represents the Phase A target, parameter origins, and direct probe groups', () => {
    const originalStatus: InvestigationParameterV1 = {
      id: 'parameter:status', name: 'status', origin: 'original_query_parameter', required: true,
      status: 'provided', typeHint: 'text',
      usedBy: [{ analysisMode: 'original', kind: 'original_analysis' }, { kind: 'probe', probeId: 'probe:status-count' }],
    };
    const plan = {
      analysisMode: 'original',
      blockedProbes: [{ code: 'JOIN_KEY_UNAVAILABLE', id: 'probe:join-cardinality', reason: 'A required join key is unavailable.', status: 'blocked' }],
      candidateConcerns: [{ evidence: ['orders.status = :status'], hypothesis: 'The predicate may exclude rows.', id: 'concern:where:1', limitations: ['No database result was inspected.'], status: 'candidate' }],
      deferredProbes: [],
      diagnostics: [{ code: 'sql_only', message: 'Diagnosis is based only on SQL analysis.' }],
      kind: 'investigation-plan',
      limitations: [{ code: 'no_database_access', message: 'No database result was inspected.' }],
      nextEvidenceChecklist: [],
      originalQuery: { artifactKind: 'original_query', sql: 'select status from orders where status = :status' },
      parameters: [
        originalStatus,
        { id: 'parameter:investigation-key', name: 'customer_id', origin: 'investigation_key', required: true, status: 'required', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] },
        { id: 'parameter:derived', name: 'start_date', origin: 'derived_parameter', required: false, status: 'provided', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] },
        { id: 'parameter:environment', name: 'database_timezone', origin: 'environment_parameter', required: false, status: 'required', typeHint: 'iana-timezone', usedBy: [] },
        { id: 'parameter:missing', name: 'tenant_id', origin: 'unresolved_parameter', required: true, status: 'unresolved', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] },
      ],
      recommendedProbes: [{ artifactKind: 'investigation_probe', confidence: 'possible', hypothesis: 'The status predicate may exclude rows.', id: 'probe:status-count', kind: 'row_count_comparison', limitations: ['The product did not run the proposed statement.'], nodeId: 'table_orders', parameters: [originalStatus], priority: 1, priorityReasons: ['Directly tests the candidate predicate.'], question: 'How many rows match the supplied status?', reason: 'Compare the predicate-constrained row count.', sql: 'select count(*) from orders where status = :status', staticSafetyEvidence }],
      target: { columnName: 'status', nodeId: 'main_output', symptom: 'missing_rows' },
      unresolvedParameters: [{ id: 'parameter:missing', name: 'tenant_id', origin: 'unresolved_parameter', required: true, status: 'unresolved', usedBy: [{ kind: 'probe', probeId: 'probe:status-count' }] }],
      version: 1,
    } satisfies InvestigationPlanV1;

    expect(plan.analysisMode).toBe('original');
    expect(plan.originalQuery).toEqual({ artifactKind: 'original_query', sql: 'select status from orders where status = :status' });
    expect(plan.recommendedProbes[0].artifactKind).toBe('investigation_probe');
    expect(plan.target).toEqual({ columnName: 'status', nodeId: 'main_output', symptom: 'missing_rows' });
    expect(plan.parameters.map((parameter) => parameter.origin)).toEqual(['original_query_parameter', 'investigation_key', 'derived_parameter', 'environment_parameter', 'unresolved_parameter']);
    expect(plan.parameters.every((parameter) => !Object.prototype.hasOwnProperty.call(parameter, 'value'))).toBe(true);
    expect(plan.recommendedProbes.flatMap((probe) => probe.parameters).every((parameter) => !Object.prototype.hasOwnProperty.call(parameter, 'value'))).toBe(true);
    expect(plan.recommendedProbes[0].staticSafetyEvidence).toEqual(staticSafetyEvidence);
    expect(plan.recommendedProbes[0].staticSafetyEvidence.assumptions).not.toHaveLength(0);
    expect(plan.recommendedProbes[0].staticSafetyEvidence.executionCaveats).not.toHaveLength(0);
    expect(plan.deferredProbes).toEqual([]);
    expect(plan.blockedProbes[0]).toMatchObject({ code: 'JOIN_KEY_UNAVAILABLE', reason: expect.any(String) });
    expect(plan.unresolvedParameters[0].status).toBe('unresolved');
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('corrected_query');
    expect(serialized).not.toContain('readOnly');
    expect(serialized).not.toContain('"value"');
    for (const unsafeAssuranceTerm of ['safe_to_execute', 'read_only', 'side_effect_free', 'database_validated', 'executed', 'production_safe']) {
      expect(serialized).not.toContain(unsafeAssuranceTerm);
    }
  });
});
