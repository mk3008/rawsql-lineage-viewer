import { describe, expect, it } from 'vitest';
import { validateProbe } from './safety';
import { evaluateAll, redactObservation } from './evaluator';
const base = { artifactKind: 'investigation_probe', parameters: [], staticSafetyEvidence: { statementClassification: 'select_statement', confidence: 'syntax_only', version: 1 } };
describe('benchmark probe safety', () => {
  it('requires recommended investigation probes and rejects DML/locks', () => {
    const plan = { recommendedProbes: [{ ...base, id: 'p', sql: 'SELECT 1' }], unresolvedParameters: [] };
    expect(() => validateProbe(plan, { ...base, id: 'x', sql: 'SELECT 1' }, {})).toThrow('PROBE_NOT_RECOMMENDED');
    expect(() => validateProbe(plan, { ...base, id: 'p', sql: 'SELECT 1 FOR UPDATE' }, {})).toThrow('PROBE_EFFECT_UNSAFE');
    expect(() => validateProbe(plan, { ...base, id: 'p', sql: 'DELETE FROM t' }, {})).toThrow('PROBE_AST_UNSUPPORTED');
  });
  it('keeps bind values out of SQL and checks names', () => {
    const plan = { recommendedProbes: [{ ...base, id: 'p', sql: 'SELECT COUNT(*) FROM t WHERE status = :status', parameters: [{ name: 'status', status: 'resolved' }] }], unresolvedParameters: [] };
    expect(() => validateProbe(plan, plan.recommendedProbes[0], {})).toThrow('BINDING_MISMATCH');
    expect(() => validateProbe(plan, plan.recommendedProbes[0], { status: 'ok' })).not.toThrow();
  });
  it('redacts sentinel scalar values from durable observations', () => {
    const durable = JSON.stringify(redactObservation({ rows: [{ status: 'SENTINEL_PRIVATE', count: 7 }] }));
    expect(durable).not.toContain('SENTINEL_PRIVATE');
    expect(durable).not.toContain('"count":7');
    expect(durable).toContain('rowCount');
  });
  it('derives actionable coverage and mechanism hits from every outcome', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 12 }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1']);
    expect(result).toMatchObject({ top1MechanismHit: 1, top3MechanismHit: 1, actionableCoverage: 1, timeToFirstUsefulEvidenceMs: 12, overclaimCount: 0 });
  });
  it('classifies a miss as inconclusive and reports failed safety/hash evidence', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [{ x: 1 }] }, control: { rows: [] }, elapsedMs: 3, safetyAccepted: false, executedArtifactHash: 'a', plannedArtifactHash: 'b' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m2'], { leakageCount: 2 });
    expect(result).toMatchObject({ top1MechanismHit: 0, top3MechanismHit: 0, actionableCoverage: 0, executionSuccess: 0, inconclusive: true, semanticEditFree: false, unsafeProbeCount: 1, parameterLeakageCount: 2, overclaimCount: 0 });
  });
  it('rejects unsupported emitted classifications as overclaims', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, safetyAccepted: true, executedArtifactHash: 'a', plannedArtifactHash: 'a', classification: 'prove' as never }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1']);
    expect(result).toMatchObject({ overclaimCount: 1, semanticEditFree: true });
  });
});
