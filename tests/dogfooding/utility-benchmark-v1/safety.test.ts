import { describe, expect, it } from 'vitest';
import { validateProbe } from './safety';
import { countScalarLeakage, evaluateAll, hashSourceAtExecutorEntry, namespacePublicMetrics, rankedMechanisms, redactObservation } from './evaluator';
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
    expect(durable).not.toMatch(/"rowCount":\s*\d/);
  });
  it('scans string, number, boolean, and null leaves without emitting values', () => {
    expect(countScalarLeakage({ a: 'secret', b: 42, c: true, d: null }, { s: 'secret', n: 42, b: true, z: null })).toBe(4);
    const durable = JSON.stringify({ leakageCount: 4 });
    expect(durable).not.toContain('secret');
    expect(durable).not.toContain('42');
  });
  it('does not strictly collide after durable scalar namespacing', () => {
    const durable = namespacePublicMetrics({ publicString: 'status-ok', number: 1, boolean: true, null: null });
    expect(countScalarLeakage(durable, { s: 'secret', n: 1, b: true, z: null })).toBe(0);
    expect(countScalarLeakage(namespacePublicMetrics({ number: 7 }), { n: 7 })).toBe(0);
    expect(countScalarLeakage({ number: 7 }, { n: 7 })).toBe(1);
  });
  it('keeps finalization code readable and container status namespaced', () => {
    const durable = namespacePublicMetrics({ finalization: { code: 'OK', containerAbsent: true } }) as { finalization: { code: string; containerAbsent: string } };
    expect(durable.finalization).toEqual({ code: 'OK', containerAbsent: 'metric-boolean:true' });
  });
  it('derives actionable coverage and mechanism hits from every outcome', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 12, classification: 'supports', artifactMember: true, artifactSourceHash: 's', plannedSourceHash: 's' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1'], { validationAttempts: [{ probeId: 'p1', accepted: true, artifactSourceHash: 's' }], candidateIds: ['c1'] });
    expect(result).toMatchObject({ top1MechanismHit: 1, top3MechanismHit: 1, actionableCoverage: 1, timeToFirstUsefulEvidenceMs: 12, overclaimCount: 0 });
  });
  it('classifies a miss as inconclusive and reports failed safety/hash evidence', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [{ x: 1 }] }, control: { rows: [] }, elapsedMs: 3, classification: 'inconclusive', artifactSourceHash: 'a', plannedSourceHash: 'b' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m2'], { leakageCount: 2, validationAttempts: [{ probeId: 'p1', accepted: false }], candidateIds: ['c1'] });
    expect(result).toMatchObject({ top1MechanismHit: 0, top3MechanismHit: 0, actionableCoverage: 0, executionSuccess: 0, inconclusive: true, semanticEditFree: false, unsafeProbeCount: 1, parameterLeakageCount: 2, overclaimCount: 0 });
  });
  it('rejects unsupported emitted classifications as overclaims', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, artifactSourceHash: 'a', plannedSourceHash: 'a', classification: 'prove' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1']);
    expect(result).toMatchObject({ overclaimCount: 1, semanticEditFree: true });
  });
  it('derives ranked mechanisms from checklist conditions, not concern ids', () => {
    expect(rankedMechanisms({ recommendedProbes: [], unresolvedParameters: [], candidateConcerns: [{ id: 'c1' }, { id: 'c2' }], nextEvidenceChecklist: [{ kind: 'condition', mechanism: 'm1', candidateConcernIds: ['c1'] }, { kind: 'condition', mechanism: 'm1', candidateConcernIds: ['c2'] }, { kind: 'condition', mechanism: 'm2', candidateConcernIds: ['c2'] }] })).toEqual(['m1', 'm2']);
  });
  it('weakens only linked candidates and leaves inconclusive unchanged', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, classification: 'supports', supportsCandidateConcernIds: ['c1'] }, { probeId: 'p2', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 2, classification: 'weakens', weakensCandidateConcernIds: ['c2'] }, { probeId: 'p3', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 3, classification: 'inconclusive' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1'], { candidateIds: ['c1', 'c2', 'c3'] });
    expect(result.remainingCandidates).toEqual(['c1', 'c3']);
    expect(result.candidateReduction).toBeCloseTo(1 / 3);
  });
  it('distinguishes Top3-only and mechanism misses, and hashes source with SHA-256', () => {
    const oracle = { mechanism: 'm3', faulty: {}, control: {} };
    expect(evaluateAll([], oracle, ['m1', 'm2', 'm3'])).toMatchObject({ top1MechanismHit: 0, top3MechanismHit: 1 });
    expect(evaluateAll([], oracle, ['m1', 'm2', 'm4'])).toMatchObject({ top1MechanismHit: 0, top3MechanismHit: 0 });
    expect(hashSourceAtExecutorEntry('SELECT 1')).toMatch(/^[0-9a-f]{64}$/);
  });
});
