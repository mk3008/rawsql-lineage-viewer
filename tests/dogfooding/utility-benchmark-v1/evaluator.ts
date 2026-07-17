import { createHash } from 'node:crypto';
export type Observation = { rows: Array<Record<string, unknown>> };
export type Oracle = { mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> };
export type ProbeOutcome = { probeId: string; faulty: Observation; control: Observation; mechanism?: string; elapsedMs: number; executedArtifactHash?: string; plannedArtifactHash?: string; safetyAccepted?: boolean; classification?: 'supports' | 'weakens' | 'inconclusive' };
export function redactObservation(observation: Observation): Record<string, unknown> {
  const rows = observation.rows;
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { rowCount: rows.length, columns, columnTypes: Object.fromEntries(columns.map(column => [column, typeof rows[0][column]])), canonicalHash: hash(JSON.stringify(rows)) };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function evaluate(faulty: Observation, control: Observation, oracle: Oracle, candidates: string[]): Record<string, unknown> {
  const same = JSON.stringify(faulty) === JSON.stringify(oracle.faulty) && JSON.stringify(control) === JSON.stringify(oracle.control);
  const hit = same ? 1 : 0;
  const initial = candidates.length;
  const remaining = same ? 1 : initial;
  return { top1MechanismHit: hit, top3MechanismHit: hit, candidateReduction: initial ? (initial - remaining) / initial : 0, remainingCandidates: remaining, informationGain: same ? 1 : 0, discrimination: same ? 1 : 0, inconclusive: !same, leakageCount: 0, overclaimCount: same ? 0 : 1, classification: same ? 'supports' : 'inconclusive' };
}
export type EvaluationOptions = { leakageCount?: number };
export function evaluateAll(outcomes: ProbeOutcome[], oracle: Oracle, rankedMechanisms: string[], options: EvaluationOptions = {}): Record<string, unknown> {
  const matches = outcomes.map(outcome => JSON.stringify(outcome.faulty) === JSON.stringify(oracle.faulty) && JSON.stringify(outcome.control) === JSON.stringify(oracle.control));
  const usefulIndex = matches.findIndex(Boolean);
  const initial = rankedMechanisms.length;
  const remaining = usefulIndex >= 0 ? Math.max(1, initial - 1) : initial;
  const top1 = rankedMechanisms[0] === oracle.mechanism ? 1 : 0;
  const top3 = rankedMechanisms.slice(0, 3).includes(oracle.mechanism) ? 1 : 0;
  const classifications = outcomes.map((outcome, index) => ({ probeId: outcome.probeId, classification: outcome.classification ?? (matches[index] ? 'supports' : 'inconclusive') }));
  return { top1MechanismHit: top1, top3MechanismHit: top3, actionableCoverage: outcomes.length ? matches.filter(Boolean).length / outcomes.length : 0, executionSuccess: outcomes.length ? outcomes.filter(o => o.safetyAccepted === true).length / outcomes.length : 0, candidateReduction: initial ? (initial - remaining) / initial : 0, remainingCandidates: remaining, informationGain: usefulIndex >= 0 ? 1 : 0, discrimination: matches.filter(Boolean).length ? 1 : 0, inconclusive: usefulIndex < 0, semanticEditFree: outcomes.length > 0 && outcomes.every(o => o.executedArtifactHash !== undefined && o.executedArtifactHash === o.plannedArtifactHash), timeToFirstUsefulEvidenceMs: usefulIndex >= 0 ? outcomes[usefulIndex].elapsedMs : null, probesToIsolate: usefulIndex >= 0 ? usefulIndex + 1 : outcomes.length, informationGainPerProbe: outcomes.length ? (usefulIndex >= 0 ? 1 : 0) / outcomes.length : 0, manualSqlAvoided: outcomes.length > 0 ? 1 : 0, unsafeProbeCount: outcomes.filter(o => o.safetyAccepted === false).length, overclaimCount: classifications.filter(c => !['supports', 'weakens', 'inconclusive'].includes(c.classification)).length, parameterLeakageCount: options.leakageCount ?? 0, classifications };
}
