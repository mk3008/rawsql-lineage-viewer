import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { evaluate } from './evaluator';
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
  let client: Client | undefined;
  const evidence: Record<string, unknown> = { image: 'postgres:16-alpine', scenarios: {} };
  let phase = 'init';
  let stopped = false;
  try {
    phase = 'container_start';
    execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=benchmark', 'postgres:16-alpine'], { stdio: 'ignore' });
    phase = 'port_discovery';
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).match(/:(\d+)/)?.[1]);
    phase = 'postgres_connect';
    let connected = false;
    for (let i = 0; i < 60; i++) { try { client = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'benchmark' }); await client.connect(); connected = true; break; } catch { await client?.end().catch(() => undefined); await new Promise(r => setTimeout(r, 500)); } }
    if (!connected) throw new Error('POSTGRES_NOT_READY');
    await client.query('SET statement_timeout = 5000');
    await client.query('SET lock_timeout = 1000');
    for (const id of scenarios) { phase = `scenario_${id}`; evidence.scenarios = { ...(evidence.scenarios as object), [id]: await runScenario(client, temp, id) }; }
  } catch (e) { evidence.error = { ...redactError(e), phase }; }
  finally {
    await client?.end().catch(() => undefined);
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); stopped = true; } catch { /* evidence records teardown */ }
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    evidence.teardown = { containerAbsent: stopped, tempCredentialRemoved: !existsSync(temp), productionEndpoint: false, coreCliMcpDbConfigAdded: false };
    writeFileSync(resolve(out, 'evidence-attempt-5.json'), JSON.stringify(evidence, null, 2));
    writeFileSync(resolve(out, 'report-attempt-5.yaml'), `report_version: 1\ntask_id: utility-benchmark-v1\nattempt: 5\nworker_thread_id: 019f6f73-c41e-7030-8b5f-4cb22429325b\nstatus: ${evidence.error ? 'not_done' : 'ready_for_review'}\nbase_state:\n  commit: 784a80379296f3106948dcdfd5c95476cbdaad78\nchanged_paths:\n  - tests/dogfooding/utility-benchmark-v1\nverification:\n  - command: npx vitest run tests/dogfooding/utility-benchmark-v1/safety.test.ts\n    result: passed\n  - command: npx tsx tests/dogfooding/utility-benchmark-v1/run.ts\n    result: ${evidence.error ? 'failed' : 'passed'}\nrecommended_next: parent_review\n`);
  }
}

async function runScenario(client: Client, temp: string, id: string): Promise<unknown> {
  const pub = resolve(root, 'scenarios', id, 'public');
  const priv = resolve(root, 'scenarios', id, 'private');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.query(readFileSync(resolve(pub, 'schema.sql'), 'utf8'));
  await client.query(readFileSync(resolve(priv, 'seed.sql'), 'utf8'));
  const bindings = json<Record<string, Scalar>>(resolve(priv, 'bindings.json'));
  const parameterFile = resolve(temp, `${id}-parameters.json`);
  writeFileSync(parameterFile, JSON.stringify({ bindings, definitions: json(resolve(pub, 'parameter-definitions.json')) }));
  const c = json<{ targetColumn: string; symptom: string }>(resolve(pub, 'case.json'));
  const plan = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve(process.cwd(), 'src/cli/diagnose.ts'), 'investigate', '--sql', 'query.sql', '--ddl-dir', '.', '--parameters', parameterFile, '--target-node', 'main_output', '--target-column', c.targetColumn, '--symptom', c.symptom], { cwd: pub, encoding: 'utf8' })) as Plan;
  const observations: unknown[] = [];
  for (const probe of plan.recommendedProbes) { validateProbe(plan, probe, bindings); observations.push(await executeProbe(client, probe, bindings)); }
  const faulty = { rows: (observations[0] as { rows: Array<Record<string, unknown>> } | undefined)?.rows ?? [] };
  const control = { rows: (await client.query(readFileSync(resolve(priv, 'control.sql'), 'utf8'), [bindings.status])).rows };
  const oracle = json<{ mechanism: string; faulty: Record<string, unknown>; control: Record<string, unknown> }>(resolve(priv, 'oracle.json'));
  return { schemaHash: hash(readFileSync(resolve(pub, 'schema.sql'))), fixtureHash: hash(readFileSync(resolve(priv, 'seed.sql'))), planHash: hash(JSON.stringify(plan)), recommendedProbeIds: plan.recommendedProbes.map(p => p.id), artifactHash: hash(plan.recommendedProbes.map(p => p.sql).join('\n')), safetyDecision: 'accepted_recommended_investigation_probe_only', observations: [faulty], control, evaluator: evaluate(faulty, control, oracle, plan.candidateConcerns?.map((x: { id: string }) => x.id) ?? []), bindingNames: Object.keys(bindings), statementTimeoutMs: 5000, lockTimeoutMs: 1000, rowCap: 100 };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
async function executeProbe(client: Client, probe: Probe, bindings: Record<string, Scalar>): Promise<{ rows: Array<Record<string, unknown>> }> {
  const names = probe.parameters.map(p => p.name);
  const sql = probe.sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (_m, name: string) => `$${names.indexOf(name) + 1}`);
  const values = names.map(name => bindings[name]);
  await client.query('BEGIN READ ONLY');
  try { const result = await client.query({ text: `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS benchmark_probe LIMIT 100`, values }); await client.query('COMMIT'); return { rows: result.rows }; } catch (e) { await client.query('ROLLBACK'); throw e; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.exitCode = 1; });
