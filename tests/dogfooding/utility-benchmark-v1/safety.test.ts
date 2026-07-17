import { describe, expect, it } from 'vitest';
import { validateProbe } from './safety';
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
});
