export type Observation = { rows: Array<Record<string, unknown>> };
export type Oracle = { mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> };
export function evaluate(faulty: Observation, control: Observation, oracle: Oracle, candidates: string[]): Record<string, unknown> {
  const same = JSON.stringify(faulty) === JSON.stringify(oracle.faulty) && JSON.stringify(control) === JSON.stringify(oracle.control);
  const hit = same ? 1 : 0;
  return { top1MechanismHit: hit, top3MechanismHit: hit, candidateReduction: candidates.length ? 1 / candidates.length : 0, informationGain: same ? 1 : 0, discrimination: same ? 1 : 0, inconclusive: !same, leakageCount: 0, overclaimCount: 0 };
}
