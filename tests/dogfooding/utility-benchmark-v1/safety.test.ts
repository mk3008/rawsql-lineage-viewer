import { describe, expect, it } from 'vitest';
import { createInvestigationPlan, type InvestigationPlanV1 } from '../../../src/lineage/investigationPlan';
import { validateProbe } from './safety';
import { assertMetricConsistency, buildSubmittedProbeSql, countScalarLeakage, evaluateAll, hasRuntimeDbConfigAddition, hashSourceAtExecutorEntry, mapSequentially, mergeChangedPaths, namespacePublicMetrics, partitionScenarioBindings, rankedMechanisms, redactObservation, writeDurableFile } from './evaluator';
import { executeReadOnlyStatement } from './executor';
import { buildSubmittedProbeStatement, compareCodeUnits, encodeBindingKey } from './parameterRewrite';
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
    const observation = redactObservation({ rows: [{ status: 'SENTINEL_PRIVATE', count: 7 }] });
    const durable = JSON.stringify(observation);
    expect(durable).not.toContain('SENTINEL_PRIVATE');
    expect(durable).not.toContain('"count":7');
    expect(observation).toMatchObject({ rowShape: 'single_row' });
    expect(observation).not.toHaveProperty('canonicalHash');
  });
  it('partitions scenario bindings and qualifies the global scan keys', () => {
    const partitioned = partitionScenarioBindings({ alpha: { status: 'a' }, beta: { status: 'b' } });
    expect(partitioned.scenarios).toEqual({ alpha: { status: 'a' }, beta: { status: 'b' } });
    expect(partitioned.global).toEqual({ '["alpha","status"]': 'a', '["beta","status"]': 'b' });
  });
  it('uses locale-independent ordering and collision-free tuple binding keys', () => {
    const partitioned = partitionScenarioBindings({ 'a:b': { c: 1 }, a: { 'b:c': 2 }, Z: { z: 3 } });
    expect(Object.keys(partitioned.scenarios)).toEqual(['Z', 'a', 'a:b']);
    expect(encodeBindingKey('a', 'b:c')).not.toBe(encodeBindingKey('a:b', 'c'));
    expect(Object.keys(partitioned.global)).toContain('["a","b:c"]');
    expect(Object.keys(partitioned.global)).toContain('["a:b","c"]');
    expect(['a', 'Z', 'a:b'].sort(compareCodeUnits)).toEqual(['Z', 'a', 'a:b']);
  });
  it('includes untracked files in deterministic changed-path evidence', () => {
    expect(mergeChangedPaths('src/z.ts\r\ntests/a.ts\r\n', 'src/new.ts\ntests/a.ts\n')).toEqual([
      'src/new.ts',
      'src/z.ts',
      'tests/a.ts',
    ]);
  });
  it('scans both tracked additions and raw untracked runtime sources for DB configuration', () => {
    expect(hasRuntimeDbConfigAddition("+import { Client } from 'pg';", '')).toBe(true);
    expect(hasRuntimeDbConfigAddition('', "import { Client } from 'pg';")).toBe(true);
    expect(hasRuntimeDbConfigAddition('', 'export const staticPlanner = true;')).toBe(false);
  });
  it('executes probes sequentially in deterministic order', async () => {
    const events: string[] = [];
    const result = await mapSequentially(['first', 'second'], async (id) => {
      events.push(`start:${id}`);
      await Promise.resolve();
      events.push(`end:${id}`);
      return id;
    });
    expect(result).toEqual(['first', 'second']);
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
  it('returns distinct fail-closed codes when durable writes fail', () => {
    const fail = () => { throw new Error('write failed'); };
    expect(writeDurableFile(fail, 'evidence.json', '{}', 'OK', 'FINALIZE_EVIDENCE_WRITE')).toBe('FINALIZE_EVIDENCE_WRITE');
    expect(writeDurableFile(fail, 'report.yaml', '', 'OK', 'FINALIZE_REPORT_WRITE')).toBe('FINALIZE_REPORT_WRITE');
  });
  it('accepts planner-supported function sources while preserving static-only safety', () => {
    const probe = { ...base, id: 'p', sql: 'SELECT value FROM generate_series(1, 3) AS series(value)' };
    expect(() => validateProbe({ recommendedProbes: [probe], unresolvedParameters: [] }, probe, {})).not.toThrow();
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
  it('separates executable contract evidence from faulty/control discrimination', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 12, classification: 'supports', observationContractMatches: true, faultyControlDiscriminates: false, artifactMember: true, artifactSourceHash: 's', plannedSourceHash: 's' }], { mechanism: 'expected', faulty: { rows: [] }, control: { rows: [] } }, ['other'], { validationAttempts: [{ probeId: 'p1', accepted: true, artifactSourceHash: 's' }], candidateIds: ['c1'] });
    expect(result).toMatchObject({ executionSuccessRate: 1, observationContractMatchRate: 1, actionableEvidenceRate: 1, faultyControlDiscriminationRate: 0, candidateReductionRate: 0, top1MechanismHitRate: 0, top3MechanismHitRate: 0, rootMechanismInconclusive: true, semanticEditFreeRate: 1, manualSqlAvoidedCount: 1, timeToFirstUsefulEvidenceMs: null, overclaimCount: 0 });
  });
  it('does not count weakens evidence as an observation-contract match', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, classification: 'weakens', observationContractMatches: false, weakensCandidateConcernIds: ['c1'] }], { mechanism: 'm1', faulty: {}, control: {} }, ['m1'], { candidateIds: ['c1'], validationAttempts: [{ probeId: 'p1', accepted: true }] });
    expect(result).toMatchObject({ observationContractMatchRate: 0, actionableEvidenceRate: 1, candidateReductionRate: 1 });
  });
  it('classifies a miss as inconclusive and reports failed safety/hash evidence', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [{ x: 1 }] }, control: { rows: [] }, elapsedMs: 3, classification: 'inconclusive', faultyControlDiscriminates: true, artifactSourceHash: 'a', plannedSourceHash: 'b' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m2'], { leakageCount: 2, validationAttempts: [{ probeId: 'p1', accepted: false }], candidateIds: ['c1'] });
    expect(result).toMatchObject({ top1MechanismHitRate: 0, top3MechanismHitRate: 0, actionableEvidenceRate: 0, executionSuccessRate: 0, observationContractMatchRate: 0, faultyControlDiscriminationRate: 1, rootMechanismInconclusive: false, semanticEditFreeRate: 0, unsafeProbeCount: 1, parameterLeakageCount: 2, overclaimCount: 0 });
  });
  it('rejects unsupported emitted classifications as overclaims', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, artifactSourceHash: 'a', plannedSourceHash: 'a', classification: 'prove' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1']);
    expect(result).toMatchObject({ overclaimCount: 1, semanticEditFreeRate: 1 });
  });
  it('derives ranked mechanisms from checklist conditions, not concern ids', () => {
    const concern = (id: string) => ({ id, evidence: [], hypothesis: id, limitations: [], status: 'candidate' as const });
    const plan: Pick<InvestigationPlanV1, 'candidateConcerns' | 'nextEvidenceChecklist'> = {
      candidateConcerns: [concern('concern:where:01'), concern('concern:join:02')],
      nextEvidenceChecklist: [
        { id: 'next-evidence:condition:02', kind: 'condition', status: 'to_verify', condition: { candidateConcernIds: ['concern:join:02'], influenceId: 'influence:join:01', kind: 'join', mechanism: 'join', scopeId: 'scope:root' } },
        { id: 'next-evidence:relation:01', kind: 'relation', status: 'to_verify', relation: { conditionIds: [], columnNames: [], nodeId: 'table:orders', relationName: 'orders', scopeIds: [] } },
        { id: 'next-evidence:property:01', kind: 'property', status: 'to_verify', property: { anchorRelationNodeIds: [], conditionId: 'condition:exists:01', kind: 'matching_related_record', relatedRelationNodeIds: [] } },
        { id: 'next-evidence:condition:01', kind: 'condition', status: 'to_verify', condition: { candidateConcernIds: ['concern:where:01'], influenceId: 'influence:where:01', kind: 'where', mechanism: 'where', scopeId: 'scope:root' } },
        { id: 'next-evidence:condition:duplicate', kind: 'condition', status: 'to_verify', condition: { candidateConcernIds: ['concern:join:02'], influenceId: 'influence:where:02', kind: 'where', mechanism: 'where', scopeId: 'scope:root' } },
      ],
    };
    expect(plan.nextEvidenceChecklist.filter((item) => item.kind === 'condition').map((item) => item.condition.mechanism)).toEqual(['join', 'where', 'where']);
    expect(rankedMechanisms(plan)).toEqual(['where', 'join']);
  });
  it('ranks mechanisms from real planner output without reading relation or property items', () => {
    const plan = createInvestigationPlan({
      sql: 'SELECT o.status FROM orders o WHERE o.status = :status',
      target: { columnName: 'status', nodeId: 'main_output' },
      parameters: { bindingPresence: { providedNames: ['status'] }, definitions: [{ name: 'status', origin: 'original_query_parameter' }] },
    });
    const conditionMechanisms = plan.nextEvidenceChecklist
      .filter((item) => item.kind === 'condition')
      .map((item) => item.condition.mechanism);
    const ranked = rankedMechanisms(plan);
    expect(conditionMechanisms.length).toBeGreaterThan(0);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked).toEqual([...new Set(conditionMechanisms)]);
    expect(ranked).not.toContain('relation');
    expect(ranked).not.toContain('property');
  });
  it('weakens only linked candidates and leaves inconclusive unchanged', () => {
    const result = evaluateAll([{ probeId: 'p1', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 1, classification: 'supports', supportsCandidateConcernIds: ['c1'] }, { probeId: 'p2', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 2, classification: 'weakens', weakensCandidateConcernIds: ['c2'] }, { probeId: 'p3', faulty: { rows: [] }, control: { rows: [] }, elapsedMs: 3, classification: 'inconclusive' }], { mechanism: 'm1', faulty: { rows: [] }, control: { rows: [] } }, ['m1'], { candidateIds: ['c1', 'c2', 'c3'] });
    expect(result.remainingCandidates).toEqual(['c1', 'c3']);
    expect(result.candidateReductionRate).toBeCloseTo(1 / 3);
    expect(result.timeToFirstUsefulEvidenceMs).toBe(2);
  });
  it('distinguishes Top3-only and mechanism misses, and hashes source with SHA-256', () => {
    const oracle = (mechanism: string) => ({ mechanism, faulty: {}, control: {} });
    expect(evaluateAll([], oracle('m1'), ['m1', 'm2', 'm3'])).toMatchObject({ top1MechanismHitRate: 1, top3MechanismHitRate: 1 });
    expect(evaluateAll([], oracle('m2'), ['m1', 'm2', 'm3'])).toMatchObject({ top1MechanismHitRate: 0, top3MechanismHitRate: 1 });
    expect(evaluateAll([], oracle('m3'), ['m1', 'm2', 'm3'])).toMatchObject({ top1MechanismHitRate: 0, top3MechanismHitRate: 1 });
    expect(evaluateAll([], oracle('missing'), ['m1', 'm2', 'm3'])).toMatchObject({ top1MechanismHitRate: 0, top3MechanismHitRate: 0 });
    expect(evaluateAll([], oracle('missing'), [])).toMatchObject({ top1MechanismHitRate: 0, top3MechanismHitRate: 0 });
    expect(hashSourceAtExecutorEntry('SELECT 1')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('fails closed when mechanism metrics or zero-tolerance safety metrics are inconsistent', () => {
    const valid = evaluateAll([], { mechanism: 'm1', faulty: {}, control: {} }, ['m1']);
    expect(() => assertMetricConsistency(['m1'], 'm1', valid)).not.toThrow();
    expect(() => assertMetricConsistency(['m1'], 'm1', { ...valid, top3MechanismHitRate: 0 })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
    expect(() => assertMetricConsistency(['m1'], 'm1', { ...valid, top1MechanismHitRate: 0 })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
    expect(() => assertMetricConsistency(['m2', 'm1'], 'm1', { ...valid, top1MechanismHitRate: 0, top3MechanismHitRate: 1 })).not.toThrow();
    expect(() => assertMetricConsistency(['m2'], 'm1', { ...valid, top1MechanismHitRate: 0, top3MechanismHitRate: 1 })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
    expect(() => assertMetricConsistency([], 'm1', { ...valid, top1MechanismHitRate: 0, top3MechanismHitRate: 0, rootMechanismInconclusive: true, parameterLeakageCount: 1 })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
    expect(() => assertMetricConsistency([], 'm1', { ...valid, top1MechanismHitRate: 0, top3MechanismHitRate: 0, rootMechanismInconclusive: true, unsafeProbeCount: 1 })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
    expect(() => assertMetricConsistency([], 'm1', { ...valid, top1MechanismHitRate: 0, top3MechanismHitRate: 0, rootMechanismInconclusive: false })).toThrow('BENCHMARK_METRIC_INCONSISTENT');
  });
  it('separates planned/executor-entry identity from the actual submitted statement', () => {
    const planned = 'SELECT id FROM orders WHERE status = :status';
    const submitted = buildSubmittedProbeSql(planned, ['status']);
    expect(submitted).toBe('SELECT * FROM (SELECT id FROM orders WHERE status = $1) AS benchmark_probe LIMIT 100');
    expect(hashSourceAtExecutorEntry(submitted)).not.toBe(hashSourceAtExecutorEntry(planned));
  });
  it('rewrites declared parameters by SQL tokens and preserves non-parameter regions', () => {
    const source = `SELECT :customer_id, :status, :status, value::text, ':status', E'prefix\\:status', "column:status"\n-- :status\n/* :status */\n, $$:status$$, $tag$:status$tag$;`;
    expect(buildSubmittedProbeSql(source, ['customer_id', 'status'])).toBe(`SELECT * FROM (SELECT $1, $2, $2, value::text, ':status', E'prefix\\:status', "column:status"\n-- :status\n/* :status */\n, $$:status$$, $tag$:status$tag$) AS benchmark_probe LIMIT 100`);
  });
  it('allows unused definitions, compacts used bindings, and rejects undeclared placeholders', () => {
    expect(buildSubmittedProbeStatement('SELECT :status', ['unused', 'status'])).toEqual({ parameterNames: ['status'], text: 'SELECT * FROM (SELECT $1) AS benchmark_probe LIMIT 100' });
    expect(() => buildSubmittedProbeStatement('SELECT :missing', ['status'])).toThrow('BENCHMARK_PARAMETER_UNDECLARED');
    expect(() => validateProbe({ recommendedProbes: [{ ...base, id: 'p', sql: 'SELECT :missing', parameters: [{ name: 'status', status: 'resolved' }] }], unresolvedParameters: [] }, { ...base, id: 'p', sql: 'SELECT :missing', parameters: [{ name: 'status', status: 'resolved' }] }, { status: 'ok' })).toThrow('BENCHMARK_PARAMETER_UNDECLARED');
  });
  it('preserves the original query error when rollback also fails', async () => {
    const original = new Error('query failed');
    const calls: string[] = [];
    const client = {
      query: async (query: string | { text: string; values: unknown[] }) => {
        const operation = typeof query === 'string' ? query : query.text;
        calls.push(operation);
        if (typeof query !== 'string') throw original;
        if (query === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [] };
      },
    };
    await expect(executeReadOnlyStatement(client, 'SELECT 1', [])).rejects.toBe(original);
    expect(calls).toEqual(['BEGIN READ ONLY', 'SELECT 1', 'ROLLBACK']);
  });
});
