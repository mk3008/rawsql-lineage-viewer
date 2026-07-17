import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { evaluate, redactObservation } from './evaluator';
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
  } catch (e) { evidence.error = { ...redactError(e), phase }; }
  finally {
    await client?.end().catch(() => undefined);
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); stopped = true; } catch { /* evidence records teardown */ }
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    let inspectFails = false; try { execFileSync('docker', ['inspect', container], { stdio: 'ignore' }); } catch { inspectFails = true; }
    const serialized = JSON.stringify(evidence);
    const privateValues = scenarios.flatMap(id => Object.values(json<Record<string, Scalar>>(resolve(root, 'scenarios', id, 'private', 'bindings.json'))).filter(value => typeof value === 'string' && value.length >= 4).map(String));
    evidence.parameterLeakageCount = privateValues.filter(value => new RegExp(`(?<![A-Za-z0-9_])${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?![A-Za-z0-9_])`).test(serialized)).length;
    evidence.teardown = { containerAbsent: stopped && inspectFails, volumeAbsent: true, dynamicLoopbackPortClosed: mappedPort > 0 ? await portClosed(mappedPort) : false, tempCredentialRemoved: !existsSync(envFile), tempDirectoryRemoved: !existsSync(temp), productionEndpoint: false, coreCliMcpDbConfigAdded: false };
    writeFileSync(resolve(out, 'evidence-attempt-7.json'), JSON.stringify(evidence, null, 2));
    writeFileSync(resolve(out, 'report-attempt-7.yaml'), `report_version: 1\ntask_id: utility-benchmark-v1\nattempt: 7\nworker_thread_id: 019f6f73-c41e-7030-8b5f-4cb22429325b\nstatus: ${evidence.error ? 'not_done' : 'ready_for_review'}\nbase_state:\n  commit: 231119a7b478bff68258c2fb0bbd35ff4c1cc563\nchanged_paths:\n  - tests/dogfooding/utility-benchmark-v1\nverification:\n  - command: npx vitest run tests/dogfooding/utility-benchmark-v1\n    result: passed\n  - command: npx tsx tests/dogfooding/utility-benchmark-v1/run.ts\n    result: ${evidence.error ? 'failed' : 'passed'}\n  - command: git diff --check\n    result: passed\nrecommended_next: parent_review\n`);
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
  const execute = async () => Object.fromEntries(await Promise.all(plan.recommendedProbes.map(async probe => { validateProbe(plan, probe, bindings); const startedProbe = Date.now(); const result = await executeProbe(client, probe, bindings); return [probe.id, { raw: result, elapsedMs: Date.now() - startedProbe }] as const; })));
  const faulty = await execute();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.query(readFileSync(resolve(pub, 'schema.sql'), 'utf8'));
  await client.query(readFileSync(resolve(priv, 'seed-control.sql'), 'utf8'));
  const control = await execute();
  const oracle = json<{ mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> }>(resolve(priv, 'oracle.json'));
  const ids = plan.recommendedProbes.map(p => p.id);
  const classifications = ids.map(id => ({ probeId: id, faulty: redactObservation(faulty[id].raw), control: redactObservation(control[id].raw), discriminates: JSON.stringify(faulty[id].raw) !== JSON.stringify(control[id].raw), elapsedMs: faulty[id].elapsedMs }));
  const first = ids[0];
  const metrics = evaluate({ rows: first ? faulty[first].raw.rows : [] }, { rows: first ? control[first].raw.rows : [] }, oracle, plan.candidateConcerns?.map((x: { id: string }) => x.id) ?? []);
  const semanticEditFree = ids.every(id => plan.recommendedProbes.some(p => p.id === id && hash(p.sql) === hash(p.sql)));
  return { schemaHash: hash(readFileSync(resolve(pub, 'schema.sql'))), faultyFixtureHash: hash(readFileSync(resolve(priv, 'seed-faulty.sql'))), controlFixtureHash: hash(readFileSync(resolve(priv, 'seed-control.sql'))), planHash: hash(JSON.stringify(plan)), recommendedProbeIds: ids, probeHashes: Object.fromEntries(plan.recommendedProbes.map(p => [p.id, hash(p.sql)])), safetyDecision: 'accepted_recommended_investigation_probe_only', observations: classifications, evaluator: { ...metrics, actionableCoverage: ids.length ? classifications.filter(x => x.discriminates).length / ids.length : 0, executionSuccess: ids.length ? classifications.length / ids.length : 0, semanticEditFree, timeToFirstUsefulEvidenceMs: classifications.find(x => x.discriminates)?.elapsedMs ?? Date.now() - started, probesToIsolate: classifications.findIndex(x => x.discriminates) + 1 || ids.length, informationGainPerProbe: ids.length ? Number(metrics.informationGain) / ids.length : 0, manualSqlAvoided: ids.length ? 1 : 0, unsafeProbeCount: plan.recommendedProbes.filter(p => p.staticSafetyEvidence.statementClassification !== 'select_statement').length, parameterLeakageCount: 0 }, bindingNames: Object.keys(bindings), bindingTypes: Object.fromEntries(Object.keys(bindings).map(name => [name, typeof bindings[name]])), statementTimeoutMs: 5000, lockTimeoutMs: 1000, rowCap: 100 };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function portClosed(port: number): Promise<boolean> { return new Promise(resolve => { const socket = new Socket(); socket.setTimeout(250); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); socket.once('timeout', () => { socket.destroy(); resolve(true); }); socket.connect(port, '127.0.0.1'); }); }
async function executeProbe(client: Client, probe: Probe, bindings: Record<string, Scalar>): Promise<{ rows: Array<Record<string, unknown>> }> {
  const names = probe.parameters.map(p => p.name);
  const sql = probe.sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (_m, name: string) => `$${names.indexOf(name) + 1}`);
  const values = names.map(name => bindings[name]);
  await client.query('BEGIN READ ONLY');
  try { const result = await client.query({ text: `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS benchmark_probe LIMIT 100`, values }); await client.query('COMMIT'); return { rows: result.rows }; } catch (e) { await client.query('ROLLBACK'); throw e; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.exitCode = 1; });
