import { createHash } from 'node:crypto';
import type { Plan } from './safety';
export type Observation = { rows: Array<Record<string, unknown>> };
export type Oracle = { mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> };
export type ValidationAttempt = { probeId: string; accepted: boolean; artifactSourceHash?: string };
export type ProbeOutcome = { probeId: string; faulty: Observation; control: Observation; elapsedMs: number; classification: string; supportsCandidateConcernIds?: string[]; weakensCandidateConcernIds?: string[]; artifactSourceHash?: string; plannedSourceHash?: string; artifactMember?: boolean };
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function redactObservation(observation: Observation): Record<string, unknown> {
  const columns = observation.rows.length ? Object.keys(observation.rows[0]) : [];
  return { rowShape: observation.rows.length === 0 ? 'empty' : observation.rows.length === 1 ? 'single_row' : 'multiple_rows', columns: columns.map(column => `column-sha256:${hash(column)}`), columnTypes: Object.fromEntries(columns.map(column => [`column-sha256:${hash(column)}`, `type-sha256:${hash(typeof observation.rows[0][column])}`])) };
}

export function partitionScenarioBindings<T>(bindingsByScenario: Record<string, Record<string, T>>): {
  global: Record<string, T>;
  scenarios: Record<string, Record<string, T>>;
} {
  const scenarios = Object.fromEntries(Object.entries(bindingsByScenario).sort(([left], [right]) => left.localeCompare(right)).map(([id, bindings]) => [id, { ...bindings }]));
  const global = Object.fromEntries(Object.entries(scenarios).flatMap(([id, bindings]) => Object.entries(bindings).map(([name, value]) => [`${id}:${name}`, value])));
  return { global, scenarios };
}

export async function mapSequentially<T, R>(items: readonly T[], execute: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (const item of items) result.push(await execute(item));
  return result;
}

export function writeDurableFile(
  write: (path: string, content: string) => void,
  path: string,
  content: string,
  currentCode: string,
  failureCode: 'FINALIZE_EVIDENCE_WRITE' | 'FINALIZE_REPORT_WRITE',
): string {
  try {
    write(path, content);
    return currentCode;
  } catch {
    return currentCode === 'OK' ? failureCode : currentCode;
  }
}
export function rankedMechanisms(plan: Plan): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  for (const concern of plan.candidateConcerns ?? []) for (const item of plan.nextEvidenceChecklist ?? []) if (item.kind === 'condition' && item.candidateConcernIds?.includes(concern.id) && item.mechanism && !seen.has(item.mechanism)) { seen.add(item.mechanism); result.push(item.mechanism); }
  return result;
}
export type EvaluationOptions = { leakageCount?: number; validationAttempts?: ValidationAttempt[]; candidateIds?: string[] };
export function evaluateAll(outcomes: ProbeOutcome[], oracle: Oracle, mechanisms: string[], options: EvaluationOptions = {}): Record<string, unknown> {
  const attempts = options.validationAttempts ?? [];
  const initialIds = options.candidateIds ?? [];
  const remaining = new Set(initialIds);
  for (const outcome of outcomes) if (outcome.classification === 'weakens') for (const id of outcome.weakensCandidateConcernIds ?? []) remaining.delete(id);
  const usefulIndex = outcomes.findIndex(o => o.classification === 'supports');
  const supports = outcomes.filter(o => o.classification === 'supports');
  const accepted = attempts.filter(a => a.accepted);
  return {
    top1MechanismHit: mechanisms[0] === oracle.mechanism ? 1 : 0,
    top3MechanismHit: mechanisms.slice(0, 3).includes(oracle.mechanism) ? 1 : 0,
    actionableCoverage: outcomes.length ? supports.length / outcomes.length : 0,
    executionSuccess: attempts.length ? accepted.length / attempts.length : 0,
    candidateReduction: initialIds.length ? (initialIds.length - remaining.size) / initialIds.length : 0,
    remainingCandidates: [...remaining], informationGain: usefulIndex >= 0 ? 1 : 0, discrimination: supports.length ? 1 : 0,
    inconclusive: usefulIndex < 0,
    semanticEditFree: outcomes.length > 0 && outcomes.every(o => o.artifactSourceHash !== undefined && o.artifactSourceHash === o.plannedSourceHash),
    timeToFirstUsefulEvidenceMs: usefulIndex >= 0 ? outcomes[usefulIndex].elapsedMs : null,
    probesToIsolate: usefulIndex >= 0 ? usefulIndex + 1 : outcomes.length,
    informationGainPerProbe: outcomes.length ? (usefulIndex >= 0 ? 1 : 0) / outcomes.length : 0,
    manualSqlAvoided: accepted.filter(a => outcomes.some(o => o.probeId === a.probeId && o.artifactMember && o.artifactSourceHash === a.artifactSourceHash)).length,
    unsafeProbeCount: attempts.filter(a => !a.accepted).length,
    overclaimCount: outcomes.filter(o => !['supports', 'weakens', 'inconclusive'].includes(o.classification)).length,
    parameterLeakageCount: options.leakageCount ?? 0,
    classifications: outcomes.map(o => ({ probeId: o.probeId, classification: o.classification }))
  };
}
export function hashSourceAtExecutorEntry(source: string): string { return hash(source); }
export function buildSubmittedProbeSql(source: string, parameterNames: string[]): string {
  const bound = source.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (_match, name: string) => `$${parameterNames.indexOf(name) + 1}`);
  return `SELECT * FROM (${bound.replace(/;\s*$/, '')}) AS benchmark_probe LIMIT 100`;
}
export function countScalarLeakage(durable: unknown, privateBindings: Record<string, unknown>): number {
  const leaves: unknown[] = [];
  const visit = (value: unknown): void => { if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) leaves.push(value); else if (Array.isArray(value)) value.forEach(visit); else if (typeof value === 'object' && value) Object.values(value).forEach(visit); };
  visit(durable);
  return Object.values(privateBindings).filter(binding => leaves.some(leaf => typeof leaf === typeof binding && leaf === binding)).length;
}
export function namespacePublicMetrics(value: unknown): unknown {
  if (value === null) return 'metric-null';
  if (typeof value === 'number') return `metric-number:${value}`;
  if (typeof value === 'boolean') return `metric-boolean:${value}`;
  if (Array.isArray(value)) return value.map(namespacePublicMetrics);
  if (typeof value === 'object' && value) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, namespacePublicMetrics(child)]));
  return value;
}
