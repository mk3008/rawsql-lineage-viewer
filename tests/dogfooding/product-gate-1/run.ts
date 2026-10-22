/*
 * Gate 1 intentionally owns fixture data and execution evidence only.  It
 * does not import the Planner: the CLI is exercised as the
 * product boundary a user would use.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Scalar = boolean | number | string | null;
type ParameterDefinition = { name: string; origin: string; required?: boolean; typeHint?: string };
type Request = { targetColumn: string; symptom: string; parameterDefinitions?: ParameterDefinition[] };
type Parameter = { name: string; status: string };
type Probe = { id: string; interpretation: { assumptions: string[]; doesNotProve: string[]; expectedCardinality: string; expectedColumns: unknown[]; inconclusiveHandling: { conditions: string[]; nextEvidence: string[] }; nextEvidence: string[]; observationRules: Array<{ candidateConcernIds: string[]; condition: string; outcome: string }>; supportsCandidateConcernIds: string[]; version: number; weakensCandidateConcernIds: string[] }; sql: string; parameters: Parameter[]; staticSafetyEvidence: { confidence: string; executionCaveats: string[]; statementClassification: string; version: number } };
type Plan = { blockedProbes: Array<{ id: string; status: string }>; candidateConcerns: Array<{ id: string }>; deferredProbes: Probe[]; recommendedProbes: Probe[]; unresolvedParameters: Parameter[] };

const harnessRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const rawRoot = resolve(process.cwd(), 'tmp/dogfooding/product-gate-1/raw');
const cases = [
  'parameterized-where-mismatch', 'missing-composite-join-predicate', 'aggregate-grain',
  'duplicate-master', 'missing-correlated-exists', 'left-join-coalesce-masking',
];
const container = `rawsql-lineage-product-gate-1-${Date.now()}`;

async function main(): Promise<void> {
  rmSync(rawRoot, { force: true, recursive: true });
  mkdirSync(rawRoot, { recursive: true });
  startPostgres();
  try {
    for (const id of cases) await runCase(id);
    writeJson(resolve(rawRoot, 'summary.json'), { cases, status: 'passed', executor: { outputRowCap: 100, readOnlyTransaction: true, statementTimeoutMs: 5000 } });
  } finally {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* preserve captured failure evidence */ }
  }
}

async function runCase(id: string): Promise<void> {
  const publicDir = resolve(harnessRoot, 'public', id);
  const privateDir = resolve(harnessRoot, 'private', id);
  const output = resolve(rawRoot, id);
  mkdirSync(output, { recursive: true });
  const request = readJson<Request>(resolve(publicDir, 'request.json'));
  const bindingsPath = resolve(privateDir, 'bindings.json');
  const bindings = existsSync(bindingsPath) ? readJson<Record<string, Scalar>>(bindingsPath) : {};
  const parameterInputRoot = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-gate-1-bindings-'));
  const parametersPath = resolve(parameterInputRoot, 'parameters.json');
  writeJson(parametersPath, { bindings, definitions: request.parameterDefinitions ?? [] });

  try {
    resetDatabase();
    runPostgres(readFileSync(resolve(publicDir, 'ddl/schema.sql'), 'utf8'));
    runPostgres(readFileSync(resolve(privateDir, 'seed.sql'), 'utf8'));

    const cliPlan = JSON.parse(execFileSync(process.execPath, [
      '--import', 'tsx', resolve(process.cwd(), 'src/cli/diagnose.ts'), 'investigate',
      '--sql', 'query.sql', '--ddl-dir', 'ddl', '--parameters', parametersPath,
      '--target-node', 'main_output', '--target-column', request.targetColumn, '--symptom', request.symptom,
    ], { cwd: publicDir, encoding: 'utf8' })) as Plan;
    writeJson(resolve(output, 'cli-plan.json'), cliPlan);

    writeJson(resolve(output, 'probe-execution.json'), executeListedProbes(cliPlan, id, bindings));
  } finally {
    rmSync(parameterInputRoot, { force: true, recursive: true });
  }
}

function executeListedProbes(plan: Plan, scenario: string, bindings: Record<string, Scalar>): unknown {
  const allowed = new Map(plan.recommendedProbes.map((probe) => [probe.id, probe]));
  const blocked = new Set(plan.blockedProbes.map((probe) => probe.id));
  assertStaticInterpretationContracts(plan, scenario);
  const results: unknown[] = [];
  for (const probe of plan.recommendedProbes) {
    if (!allowed.has(probe.id) || blocked.has(probe.id)) throw new Error(`${scenario}: rejected unknown or blocked probe ${probe.id}`);
    if (probe.staticSafetyEvidence.version !== 1 || probe.staticSafetyEvidence.statementClassification !== 'select_statement' || probe.staticSafetyEvidence.confidence !== 'syntax_only') {
      throw new Error(`${scenario}: rejected probe with unexpected static classification ${probe.id}`);
    }
    if (!probe.staticSafetyEvidence.executionCaveats.includes('This static classification does not authorize execution.')) {
      throw new Error(`${scenario}: rejected probe without the required execution caveat ${probe.id}`);
    }
    if (!/^\s*(?:with\b[\s\S]+?\bselect\b|select\b)/i.test(probe.sql)) throw new Error(`${scenario}: rejected probe outside the external gate SQL policy ${probe.id}`);
    const unresolved = probe.parameters.filter((parameter) => parameter.status === 'unresolved' || !Object.prototype.hasOwnProperty.call(bindings, parameter.name));
    if (unresolved.length > 0 || plan.unresolvedParameters.length > 0) throw new Error(`${scenario}: rejected unresolved parameter(s) for ${probe.id}`);
    const positional = toPositionalParameters(probe.sql, probe.parameters, bindings);
    const preparedSql = `SELECT * FROM (${positional.sql.replace(/;\s*$/, '')}) AS gate_1_probe LIMIT 100`;
    const statementName = `gate_1_probe_${results.length + 1}`;
    const execute = `EXECUTE ${statementName}(${positional.values.map(invocationLiteral).join(', ')})`;
    // Values occur only in EXECUTE arguments.  The prepared SQL has placeholders.
    const stdout = runPostgres(`BEGIN READ ONLY; SET LOCAL statement_timeout = '5000ms'; PREPARE ${statementName} AS ${preparedSql}; ${execute}; DEALLOCATE ${statementName}; COMMIT;`);
    if (Buffer.byteLength(stdout) > 1024 * 1024) throw new Error(`${scenario}: output cap exceeded for ${probe.id}`);
    results.push(toBindingSafeProbeEvidence(probe.id, probe.sql, `PREPARE ${statementName} AS ${preparedSql}`, positional.mapping));
  }
  return { allowedProbeIds: [...allowed.keys()], blockedProbeIds: [...blocked], deferredProbeIds: plan.deferredProbes.map((probe) => probe.id), results };
}

function toPositionalParameters(sql: string, parameters: Parameter[], bindings: Record<string, Scalar>): { sql: string; mapping: Array<{ name: string; position: number }>; values: Scalar[] } {
  const values = new Map(parameters.filter((parameter) => Object.prototype.hasOwnProperty.call(bindings, parameter.name)).map((parameter) => [parameter.name, bindings[parameter.name]]));
  const positions = new Map<string, number>();
  const positionalSql = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (_all, name: string) => {
    if (!values.has(name)) throw new Error(`unresolved SQL placeholder :${name}`);
    if (!positions.has(name)) positions.set(name, positions.size + 1);
    return `$${positions.get(name)}`;
  });
  const mapping = [...positions.entries()].map(([name, position]) => ({ name, position }));
  return { sql: positionalSql, mapping, values: mapping.map(({ name }) => values.get(name) as Scalar) };
}

/** Quotes only the database invocation argument, never the generated/prepared probe SQL. */
function invocationLiteral(value: Scalar): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function startPostgres(): void {
  execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=diagnostics', 'postgres:16-alpine'], { stdio: 'ignore' });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try { runPostgres('select 1;'); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  throw new Error('PostgreSQL did not become ready within 60 seconds.');
}

function resetDatabase(): void { runPostgres('drop schema public cascade; create schema public;'); }

function runPostgres(sql: string): string {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'diagnostics', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function readJson<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }
function writeJson(file: string, value: unknown): void { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

export function assertStaticInterpretationContracts(plan: Plan, scenario: string): void {
  const concernIds = new Set(plan.candidateConcerns.map((concern) => concern.id));
  for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
    const referencedIds = [
      ...probe.interpretation.supportsCandidateConcernIds,
      ...probe.interpretation.weakensCandidateConcernIds,
      ...probe.interpretation.observationRules.flatMap((rule) => rule.candidateConcernIds),
    ];
    const outcomes = new Set(probe.interpretation.observationRules.map((rule) => rule.outcome));
    if (probe.interpretation.version !== 1
      || !['exactly_one_row', 'zero_or_more_rows'].includes(probe.interpretation.expectedCardinality)
      || probe.interpretation.expectedColumns.length === 0
      || probe.interpretation.assumptions.length === 0
      || probe.interpretation.doesNotProve.length === 0
      || probe.interpretation.nextEvidence.length === 0
      || probe.interpretation.supportsCandidateConcernIds.length === 0
      || probe.interpretation.weakensCandidateConcernIds.length === 0
      || probe.interpretation.inconclusiveHandling.conditions.length === 0
      || probe.interpretation.inconclusiveHandling.nextEvidence.length === 0
      || !['supports', 'weakens', 'inconclusive'].every((outcome) => outcomes.has(outcome))
      || probe.interpretation.observationRules.some((rule) => rule.condition.length === 0 || rule.candidateConcernIds.length === 0)
      || probe.interpretation.observationRules.filter((rule) => rule.outcome === 'inconclusive').some((rule) => !probe.interpretation.inconclusiveHandling.conditions.includes(rule.condition))
      || referencedIds.some((id) => !concernIds.has(id))) {
      throw new Error(`${scenario}: rejected incomplete static interpretation contract for ${probe.id}`);
    }
  }
  if (plan.blockedProbes.some((probe) => Object.prototype.hasOwnProperty.call(probe, 'interpretation'))) {
    throw new Error(`${scenario}: rejected fabricated interpretation metadata on a blocked probe`);
  }
}

export function toBindingSafeProbeEvidence(
  probeId: string,
  generatedSql: string,
  preparedStatement: string,
  positionalMapping: Array<{ name: string; position: number }>,
): unknown {
  return { generatedSql, mechanicalTransformationOnly: true, parameterValueInline: 0, positionalMapping, preparedStatement, probeId, resultPersisted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Product gate failed without emitting binding or execution details.\n'); process.exitCode = 1; });
}
