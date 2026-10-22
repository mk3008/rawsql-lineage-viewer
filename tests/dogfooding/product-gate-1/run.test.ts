import { describe, expect, it } from 'vitest';
import { assertStaticInterpretationContracts, toBindingSafeProbeEvidence } from './run';

const opaqueBinding = 'opaque-binding-sentinel';

describe('product gate binding evidence boundary', () => {
  it('records probe execution structure without invocation arguments or results', () => {
    const evidence = toBindingSafeProbeEvidence(
      'probe:example',
      'SELECT * FROM orders WHERE customer_id = :customer_id',
      'PREPARE probe AS SELECT * FROM orders WHERE customer_id = $1',
      [{ name: 'customer_id', position: 1 }],
    );
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain(opaqueBinding);
    expect(evidence).not.toHaveProperty('executeWrapper');
    expect(evidence).not.toHaveProperty('fixtureSafeValues');
    expect(evidence).not.toHaveProperty('rowOutput');
    expect(evidence).toMatchObject({ resultPersisted: false });
  });

  it('accepts complete static interpretation contracts and rejects unknown concern references', () => {
    const interpretation = {
      assumptions: ['An external evaluator supplies comparable evidence.'],
      doesNotProve: ['The observation does not prove causality.'],
      expectedCardinality: 'exactly_one_row',
      expectedColumns: [{ name: 'candidate_rows', role: 'aggregate_count', type: 'integer' }],
      inconclusiveHandling: { conditions: ['comparable_baseline_unavailable_or_shape_invalid'], nextEvidence: ['Establish a baseline.'] },
      nextEvidence: ['Compare with the accepted baseline.'],
      observationRules: [
        { candidateConcernIds: ['concern:where:01'], condition: 'candidate_rows_below_accepted_baseline', outcome: 'supports' },
        { candidateConcernIds: ['concern:where:01'], condition: 'candidate_rows_at_or_above_accepted_baseline', outcome: 'weakens' },
        { candidateConcernIds: ['concern:where:01'], condition: 'comparable_baseline_unavailable_or_shape_invalid', outcome: 'inconclusive' },
      ],
      supportsCandidateConcernIds: ['concern:where:01'],
      version: 1,
      weakensCandidateConcernIds: ['concern:where:01'],
    };
    const plan = {
      blockedProbes: [],
      candidateConcerns: [{ id: 'concern:where:01' }],
      deferredProbes: [],
      recommendedProbes: [{ id: 'probe:where:01', interpretation, parameters: [], sql: 'SELECT COUNT(*) AS candidate_rows FROM orders', staticSafetyEvidence: { confidence: 'syntax_only', executionCaveats: [], statementClassification: 'select_statement', version: 1 } }],
      unresolvedParameters: [],
    } as Parameters<typeof assertStaticInterpretationContracts>[0];

    expect(() => assertStaticInterpretationContracts(plan, 'scenario')).not.toThrow();
    const invalidPlan = structuredClone(plan);
    invalidPlan.recommendedProbes[0].interpretation.supportsCandidateConcernIds = ['concern:missing:01'];
    expect(() => assertStaticInterpretationContracts(invalidPlan, 'scenario')).toThrow('incomplete static interpretation contract');
  });
});
