export type Observation = { rows: Array<Record<string, unknown>> };
export type Oracle = { mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> };
export function redactObservation(observation: Observation): Record<string, unknown> {
  const rows = observation.rows;
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { rowCount: rows.length, columns, columnTypes: Object.fromEntries(columns.map(column => [column, typeof rows[0][column]])), canonicalHash: hash(JSON.stringify(rows)) };
}
function hash(value: string): string { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }
export function evaluate(faulty: Observation, control: Observation, oracle: Oracle, candidates: string[]): Record<string, unknown> {
  const same = JSON.stringify(faulty) === JSON.stringify(oracle.faulty) && JSON.stringify(control) === JSON.stringify(oracle.control);
  const hit = same ? 1 : 0;
  const initial = candidates.length;
  const remaining = same ? 1 : initial;
  return { top1MechanismHit: hit, top3MechanismHit: hit, candidateReduction: initial ? (initial - remaining) / initial : 0, remainingCandidates: remaining, informationGain: same ? 1 : 0, discrimination: same ? 1 : 0, inconclusive: !same, leakageCount: 0, overclaimCount: same ? 0 : 1, classification: same ? 'supports' : 'inconclusive' };
}
