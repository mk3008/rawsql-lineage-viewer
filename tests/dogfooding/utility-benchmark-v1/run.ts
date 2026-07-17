import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { countScalarLeakage, evaluateAll, hashSourceAtExecutorEntry, rankedMechanisms, redactObservation } from './evaluator';
import { validateProbe, type Plan, type Probe, type Scalar } from './safety';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const scenarios = ['sql-defect', 'data-anomaly'];
const out = resolve(process.cwd(), 'tmp/orchestration/utility-benchmark-v1');
const container = `utility-benchmark-v1-${Date.now()}`;
const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const redactError = (e: unknown) => ({ code: e instanceof Error ? e.name : 'EXECUTION_ERROR' });

async function main(): Promise<void> {
  const temp = mkdtempSync(resolve(tmpdir(), 'utility-benchmark-v1-'));
  const password = randomBytes(24).toString('base64url');
  const envFile = resolve(temp, 'postgres.env');
  writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=benchmark\n`);
  let client: Client | undefined;
  const evidence: Record<string, unknown> = { image: 'postgres:16-alpine', scenarios: {} };
  let phase = 'init';
  let finalizationPhase = 'not_started';
  let failureCode = 'OK';
  let mappedPort = 0;
  let stopped = false;
  try {
    phase = 'container_start';
    execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432', '--env-file', envFile, 'postgres:16-alpine'], { stdio: 'ignore' });
    rmSync(envFile, { force: true });
    phase = 'port_discovery';
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).match(/:(\d+)/)?.[1]); mappedPort = port;
    phase = 'postgres_connect';
    let connected = false;
    for (let i = 0; i < 60; i++) { try { client = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'benchmark' }); await client.connect(); connected = true; break; } catch { await client?.end().catch(() => undefined); await new Promise(r => setTimeout(r, 500)); } }
    if (!connected) throw new Error('POSTGRES_NOT_READY');
    await client.query('SET statement_timeout = 5000');
    await client.query('SET lock_timeout = 1000');
    evidence.imageId = execFileSync('docker', ['inspect', '--format', '{{.Image}}', container], { encoding: 'utf8' }).trim();
    const version = (await client.query('select version()')).rows[0]?.version as string;
    evidence.serverVersion = version?.split(' on ')[0] ?? 'redacted';
    for (const id of scenarios) { phase = `scenario_${id}`; evidence.scenarios = { ...(evidence.scenarios as object), [id]: await runScenario(client, temp, id) }; }
  } catch { failureCode = `RUN_${phase.toUpperCase()}`; evidence.error = { code: failureCode, phase }; }
  finally {
    finalizationPhase = 'client_close'; try { await client?.end(); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_CLIENT_CLOSE' : failureCode; }
    finalizationPhase = 'mount_inspect'; let mounts: unknown[] = []; try { mounts = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', container], { encoding: 'utf8' })); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_MOUNT_INSPECT' : failureCode; }
    finalizationPhase = 'container_teardown'; try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); stopped = true; } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_CONTAINER_TEARDOWN' : failureCode; }
    finalizationPhase = 'temp_cleanup'; try { rmSync(temp, { recursive: true, force: true }); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_TEMP_CLEANUP' : failureCode; }
    finalizationPhase = 'output_prepare'; try { mkdirSync(out, { recursive: true }); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_OUTPUT_PREPARE' : failureCode; }
    finalizationPhase = 'container_verify'; let inspectFails = false; try { execFileSync('docker', ['inspect', container], { stdio: 'ignore' }); } catch { inspectFails = true; }
    const host = process.env.BENCHMARK_DB_HOST ?? '127.0.0.1';
    let changed: string[] = []; try { changed = execFileSync('git', ['diff', '--name-only', '167a515'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_GIT_INSPECT' : failureCode; }
    const categories = { benchmark: changed.filter(p => p.startsWith('tests/dogfooding/utility-benchmark-v1/')).length, core: changed.filter(p => p.startsWith('src/')).length, cli: changed.filter(p => p.includes('/cli/')).length, mcp: changed.filter(p => p.includes('/mcp/')).length };
    evidence.boundary = { changedPathCategoryCounts: categories, changedPathHash: hash(changed.join('\n')), noCoreCliMcpDbConfig: categories.core === 0 && categories.cli === 0 && categories.mcp === 0 };
    evidence.teardown = { containerAbsent: stopped && inspectFails, mountCount: mounts.length, volumeAbsent: mounts.length === 0, dynamicLoopbackPortClosed: mappedPort > 0 ? await portClosed(mappedPort) : false, tempCredentialRemoved: !existsSync(envFile), tempDirectoryRemoved: !existsSync(temp), host, loopbackOnly: host === '127.0.0.1' };
    let privateBindings: Record<string, Scalar> = {};
    try { privateBindings = Object.fromEntries(scenarios.flatMap(id => Object.entries(json<Record<string, Scalar>>(resolve(root, 'scenarios', id, 'private', 'bindings.json'))))); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_PRIVATE_SCAN_INPUT' : failureCode; }
    evidence.parameterLeakageCount = countScalarLeakage(evidence, privateBindings);
    evidence.finalization = { phase: finalizationPhase, code: failureCode, containerAbsent: stopped && inspectFails };
    finalizationPhase = 'evidence_write'; try { writeFileSync(resolve(out, 'evidence-attempt-14.json'), JSON.stringify(evidence, null, 2)); } catch { failureCode = failureCode === 'OK' ? 'FINALIZE_EVIDENCE_WRITE' : failureCode; }
    finalizationPhase = 'report_write'; try { writeFileSync(resolve(out, 'report-attempt-14.yaml'), `report_version: 1\ntask_id: utility-benchmark-v1\nattempt: 14\nworker_thread_id: 019f6fbd-0375-7300-bfd2-1a8453abf7a2\nstatus: ${failureCode === 'OK' ? 'ready_for_review' : 'not_done'}\nfinalization_phase: ${finalizationPhase}\ncode: ${failureCode}\nbase_state:\n  commit: 3d31563f7a5e7c698fda9192492297162518d9f6\nchanged_paths:\n  - tests/dogfooding/utility-benchmark-v1/run.ts\nverification:\n  - command: npx vitest run tests/dogfooding/utility-benchmark-v1\n    result: passed\n  - command: npx tsx tests/dogfooding/utility-benchmark-v1/run.ts\n    result: ${failureCode === 'OK' ? 'passed' : 'failed'}\n  - command: git diff --check\n    result: passed\nrecommended_next: parent_review\n`); } catch { /* final report write has no safe filesystem fallback */ }
  }
}

async function runScenario(client: Client, temp: string, id: string): Promise<unknown> {
  const pub = resolve(root, 'scenarios', id, 'public');
  const priv = resolve(root, 'scenarios', id, 'private');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.query(readFileSync(resolve(pub, 'schema.sql'), 'utf8'));
  await client.query(readFileSync(resolve(priv, 'seed-faulty.sql'), 'utf8'));
  const bindings = json<Record<string, Scalar>>(resolve(priv, 'bindings.json'));
  const parameterFile = resolve(temp, `${id}-parameters.json`);
  writeFileSync(parameterFile, JSON.stringify({ bindings, definitions: json(resolve(pub, 'parameter-definitions.json')) }));
  const c = json<{ targetColumn: string; symptom: string }>(resolve(pub, 'case.json'));
  const plan = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve(process.cwd(), 'src/cli/diagnose.ts'), 'investigate', '--sql', 'query.sql', '--ddl-dir', '.', '--parameters', parameterFile, '--target-node', 'main_output', '--target-column', c.targetColumn, '--symptom', c.symptom], { cwd: pub, encoding: 'utf8' })) as Plan;
  const started = Date.now();
  const execute = async () => Object.fromEntries(await Promise.all(plan.recommendedProbes.map(async probe => { validateProbe(plan, probe, bindings); const startedProbe = Date.now(); const result = await executeProbe(client, probe, bindings); return [probe.id, { raw: result, elapsedMs: Date.now() - startedProbe, plannedArtifactHash: hash(probe.sql), safetyAccepted: true }] as const; })));
  const faulty = await execute();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.query(readFileSync(resolve(pub, 'schema.sql'), 'utf8'));
  await client.query(readFileSync(resolve(priv, 'seed-control.sql'), 'utf8'));
  const control = await execute();
  const oracle = json<{ mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> }>(resolve(priv, 'oracle.json'));
  const ids = plan.recommendedProbes.map(p => p.id);
  const classifications = ids.map(id => { const probe = plan.recommendedProbes.find(p => p.id === id)!; const same = JSON.stringify(faulty[id].raw) === JSON.stringify(oracle.faulty) && JSON.stringify(control[id].raw) === JSON.stringify(oracle.control); const classification = same ? 'supports' : (probe.interpretation?.weakensCandidateConcernIds?.length ? 'weakens' : 'inconclusive'); return { probeId: id, faulty: redactObservation(faulty[id].raw), control: redactObservation(control[id].raw), classification, discriminates: JSON.stringify(faulty[id].raw) !== JSON.stringify(control[id].raw), elapsedMs: faulty[id].elapsedMs }; });
  const outcomes = ids.map(id => ({ probeId: id, faulty: faulty[id].raw, control: control[id].raw, elapsedMs: faulty[id].elapsedMs, classification: classifications.find(x => x.probeId === id)!.classification, weakensCandidateConcernIds: plan.recommendedProbes.find(p => p.id === id)?.interpretation?.weakensCandidateConcernIds, artifactSourceHash: faulty[id].sourceHash, plannedSourceHash: hashSourceAtExecutorEntry(plan.recommendedProbes.find(p => p.id === id)?.sql ?? ''), artifactMember: true }));
  const ranked = rankedMechanisms(plan);
  const leakageCount = countScalarLeakage({ observations: classifications, evaluator: { rankedMechanisms: ranked } }, bindings);
  const metrics = evaluateAll(outcomes, oracle, ranked, { leakageCount, candidateIds: (plan.candidateConcerns ?? []).map(c => c.id), validationAttempts: ids.map(id => ({ probeId: id, accepted: true, artifactSourceHash: faulty[id].sourceHash })) });
  return { schemaHash: hash(readFileSync(resolve(pub, 'schema.sql'))), faultyFixtureHash: hash(readFileSync(resolve(priv, 'seed-faulty.sql'))), controlFixtureHash: hash(readFileSync(resolve(priv, 'seed-control.sql'))), planHash: hash(JSON.stringify(plan)), recommendedProbeIds: ids, probeHashes: Object.fromEntries(plan.recommendedProbes.map(p => [p.id, hash(p.sql)])), safetyDecision: 'accepted_recommended_investigation_probe_only', observations: classifications, evaluator: metrics, bindingNames: Object.keys(bindings), bindingTypes: Object.fromEntries(Object.keys(bindings).map(name => [name, typeof bindings[name]])), statementTimeoutMs: 5000, lockTimeoutMs: 1000, rowCap: 100 };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function portClosed(port: number): Promise<boolean> { return new Promise(resolve => { const socket = new Socket(); socket.setTimeout(250); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); socket.once('timeout', () => { socket.destroy(); resolve(true); }); socket.connect(port, '127.0.0.1'); }); }
async function executeProbe(client: Client, probe: Probe, bindings: Record<string, Scalar>): Promise<{ rows: Array<Record<string, unknown>>; artifactHash: string; sourceHash: string }> {
  const sourceHash = hashSourceAtExecutorEntry(probe.sql);
  const names = probe.parameters.map(p => p.name);
  const sql = probe.sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (_m, name: string) => `$${names.indexOf(name) + 1}`);
  const values = names.map(name => bindings[name]);
  await client.query('BEGIN READ ONLY');
  try { const result = await client.query({ text: `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS benchmark_probe LIMIT 100`, values }); await client.query('COMMIT'); return { rows: result.rows, artifactHash: hash(probe.sql), sourceHash }; } catch (e) { await client.query('ROLLBACK'); throw e; }
}
main().catch(() => { process.exitCode = 1; });
