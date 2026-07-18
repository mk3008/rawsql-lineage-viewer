import { createHash } from 'node:crypto';
import type { Plan } from './safety';
import { compareCodeUnits, encodeBindingKey } from './parameterRewrite';
export { buildSubmittedProbeSql } from './parameterRewrite';
export type Observation = { rows: Array<Record<string, unknown>> };
export type Oracle = { mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> };
export type ValidationAttempt = { probeId: string; accepted: boolean; artifactSourceHash?: string };
export type ProbeOutcome = { probeId: string; faulty: Observation; control: Observation; elapsedMs: number; classification: string; supportsCandidateConcernIds?: string[]; weakensCandidateConcernIds?: string[]; artifactSourceHash?: string; plannedSourceHash?: string; artifactMember?: boolean; observationContractMatches?: boolean; faultyControlDiscriminates?: boolean };
export interface UtilityMetricsV1 {
  executionSuccessRate: number;
  observationContractMatchRate: number;
  actionableEvidenceRate: number;
  faultyControlDiscriminationRate: number;
  candidateReductionRate: number;
  top1MechanismHitRate: number;
  top3MechanismHitRate: number;
  semanticEditFreeRate: number;
  manualSqlAvoidedCount: number;
  unsafeProbeCount: number;
  overclaimCount: number;
  parameterLeakageCount: number;
  rootMechanismInconclusive: boolean;
  timeToFirstUsefulEvidenceMs: number | null;
  remainingCandidates: string[];
  classifications: Array<{ probeId: string; classification: string }>;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function redactObservation(observation: Observation): Record<string, unknown> {
  const columns = observation.rows.length ? Object.keys(observation.rows[0]) : [];
  return { rowShape: observation.rows.length === 0 ? 'empty' : observation.rows.length === 1 ? 'single_row' : 'multiple_rows', columns: columns.map(column => `column-sha256:${hash(column)}`), columnTypes: Object.fromEntries(columns.map(column => [`column-sha256:${hash(column)}`, `type-sha256:${hash(typeof observation.rows[0][column])}`])) };
}

export function partitionScenarioBindings<T>(bindingsByScenario: Record<string, Record<string, T>>): {
  global: Record<string, T>;
  scenarios: Record<string, Record<string, T>>;
} {
  const scenarios = Object.fromEntries(Object.entries(bindingsByScenario)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([id, bindings]) => [id, Object.fromEntries(Object.entries(bindings).sort(([left], [right]) => compareCodeUnits(left, right))) ]));
  const global = Object.fromEntries(Object.entries(scenarios).flatMap(([id, bindings]) => Object.entries(bindings).map(([name, value]) => [encodeBindingKey(id, name), value])));
  return { global, scenarios };
}

export function mergeChangedPaths(trackedDiff: string, untrackedFiles: string): string[] {
  return [...new Set(`${trackedDiff}\n${untrackedFiles}`.split(/\r?\n/).filter(Boolean))].sort(compareCodeUnits);
}

export function hasRuntimeDbConfigAddition(trackedDiff: string, untrackedSource: string): boolean {
  const dbConfigPattern = /(?:from\s+['"]pg['"]|require\(['"]pg['"]\)|new\s+Client\s*\(|DATABASE_URL|BENCHMARK_DB_|postgres(?:ql)?:\/\/)/i;
  const trackedAddition = trackedDiff.split(/\r?\n/)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .some(line => dbConfigPattern.test(line));
  return trackedAddition || dbConfigPattern.test(untrackedSource);
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
export function evaluateAll(outcomes: ProbeOutcome[], oracle: Oracle, mechanisms: string[], options: EvaluationOptions = {}): UtilityMetricsV1 {
  const attempts = options.validationAttempts ?? [];
  const initialIds = options.candidateIds ?? [];
  const remaining = new Set(initialIds);
  for (const outcome of outcomes) if (outcome.classification === 'weakens') for (const id of outcome.weakensCandidateConcernIds ?? []) remaining.delete(id);
  const accepted = attempts.filter(a => a.accepted);
  const successful = accepted.filter(attempt => outcomes.some(outcome => outcome.probeId === attempt.probeId));
  const contractMatches = outcomes.filter(outcome => outcome.observationContractMatches === true);
  const actionableOutcomes = outcomes.filter(outcome => outcome.classification === 'supports' || outcome.classification === 'weakens');
  const discriminating = outcomes.filter(outcome => outcome.faultyControlDiscriminates === true);
  const candidateReductionRate = initialIds.length ? (initialIds.length - remaining.size) / initialIds.length : 0;
  const top1MechanismHitRate = mechanisms[0] === oracle.mechanism ? 1 : 0;
  const top3MechanismHitRate = mechanisms.slice(0, 3).includes(oracle.mechanism) ? 1 : 0;
  const usefulIndex = outcomes.findIndex(outcome => outcome.faultyControlDiscriminates === true || (outcome.classification === 'weakens' && (outcome.weakensCandidateConcernIds?.length ?? 0) > 0));
  const firstUsefulIndex = usefulIndex >= 0 ? usefulIndex : top3MechanismHitRate > 0 && outcomes.length > 0 ? 0 : -1;
  return {
    executionSuccessRate: attempts.length ? successful.length / attempts.length : 0,
    observationContractMatchRate: outcomes.length ? contractMatches.length / outcomes.length : 0,
    actionableEvidenceRate: attempts.length ? successful.filter(attempt => actionableOutcomes.some(outcome => outcome.probeId === attempt.probeId)).length / attempts.length : 0,
    faultyControlDiscriminationRate: outcomes.length ? discriminating.length / outcomes.length : 0,
    candidateReductionRate,
    top1MechanismHitRate,
    top3MechanismHitRate,
    semanticEditFreeRate: outcomes.length ? outcomes.filter(o => o.artifactSourceHash !== undefined && o.artifactSourceHash === o.plannedSourceHash).length / outcomes.length : 0,
    manualSqlAvoidedCount: accepted.filter(a => outcomes.some(o => o.probeId === a.probeId && o.artifactMember && o.artifactSourceHash === a.artifactSourceHash)).length,
    unsafeProbeCount: attempts.filter(a => !a.accepted).length,
    overclaimCount: outcomes.filter(o => !['supports', 'weakens', 'inconclusive'].includes(o.classification)).length,
    parameterLeakageCount: options.leakageCount ?? 0,
    rootMechanismInconclusive: top3MechanismHitRate === 0 && candidateReductionRate === 0 && discriminating.length === 0,
    timeToFirstUsefulEvidenceMs: firstUsefulIndex >= 0 ? outcomes[firstUsefulIndex].elapsedMs : null,
    remainingCandidates: [...remaining],
    classifications: outcomes.map(o => ({ probeId: o.probeId, classification: o.classification })),
  };
}
export function hashSourceAtExecutorEntry(source: string): string { return hash(source); }
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
