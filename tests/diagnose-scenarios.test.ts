import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface ScenarioExpectation {
  expectedCorrectRows: Array<Record<string, string>>;
  expectedCheckDomains: string[];
  expectedEffects: string[];
  expectedEvidenceContains: string[];
  expectedMechanisms: string[];
  expectedRows: Array<Record<string, string>>;
  id: string;
  notExpectedEffects: string[];
  primaryEffects: string[];
  rootCauseKind: string;
  symptom: string;
  targetColumn: string;
  wrongSymptom: string;
}

interface DiagnosticReport {
  packets: Array<{
    candidateConcerns: Array<{
      checkDomains: string[];
      effects: string[];
      evidence: string[];
      kind: string;
      mechanisms: string[];
      symptomMatch?: {
        matchedEffects: string[];
      };
    }>;
    rowLineage: {
      influences: Array<{
        effects: string[];
        expressionSql?: string;
        mechanism: string;
      }>;
    };
    target: {
      columnName: string;
    };
  }>;
  symptom?: {
    intent: string;
    unknownOrNotImplementedEffects: string[];
  };
}

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scenarioRoot = resolve(rootDir, 'tests/scenarios');
const scenarioNames = readdirSync(scenarioRoot)
  .filter((entry) => existsSync(join(scenarioRoot, entry, 'expected.json')))
  .sort();
const dockerAvailable = canRunDocker();
const dockerName = `rawsql-lineage-scenarios-${Date.now()}`;

describe.skipIf(!dockerAvailable)('rawsql-lineage diagnose scenario fixtures', () => {
  beforeAll(() => {
    execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      dockerName,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=diagnostics',
      'postgres:16-alpine',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    waitForPostgres(dockerName);
  }, 60_000);

  afterAll(() => {
    try {
      execFileSync('docker', ['rm', '-f', dockerName], { stdio: 'ignore' });
    } catch {
      // The container may already be gone if startup failed.
    }
  });

  it.each(scenarioNames)('verifies real DB symptom and CLI diagnostics for %s', (scenarioName) => {
    const scenarioDir = join(scenarioRoot, scenarioName);
    const expected = readJson<ScenarioExpectation>(join(scenarioDir, 'expected.json'));
    resetDatabase(dockerName);
    runSqlInPostgres(dockerName, readFileSync(join(scenarioDir, 'schema.sql'), 'utf8'));
    runSqlInPostgres(dockerName, readFileSync(join(scenarioDir, 'seed.sql'), 'utf8'));

    const actualRows = queryRows(dockerName, readFileSync(join(scenarioDir, 'query.sql'), 'utf8'));
    expect(actualRows).toEqual(expected.expectedRows);
    const correctRows = queryCorrectRows(dockerName, scenarioDir);
    expect(correctRows).toEqual(expected.expectedCorrectRows);
    expect(correctRows, `${expected.id} should prove the faulty result differs from the correct baseline`).not.toEqual(actualRows);

    const withoutDdl = runDiagnose(scenarioDir, expected, false);
    const withDdl = runDiagnose(scenarioDir, expected, true);
    const wrongSymptom = runDiagnose(scenarioDir, expected, true, expected.wrongSymptom);

    expect(withoutDdl.symptom).toMatchObject({ intent: expected.symptom });
    expect(withDdl.symptom).toMatchObject({ intent: expected.symptom });
    assertReportMatchesScenario(withoutDdl, expected);
    assertReportMatchesScenario(withDdl, expected);
    assertQualityDelta(withoutDdl, withDdl, expected);
    assertWrongSymptomIsWeaker(withDdl, wrongSymptom, expected);
  }, 45_000);
});

function canRunDocker(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForPostgres(containerName: string): void {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 45_000) {
    try {
      execFileSync('docker', [
        'exec',
        containerName,
        'psql',
        '-U',
        'postgres',
        '-d',
        'diagnostics',
        '-X',
        '-A',
        '-t',
        '-c',
        'select 1;',
      ], { stdio: 'ignore' });
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error(`Postgres container did not become ready: ${String(lastError)}`);
}

function resetDatabase(containerName: string): void {
  runSqlInPostgres(containerName, 'drop schema public cascade; create schema public;');
}

function runSqlInPostgres(containerName: string, sql: string): void {
  execFileSync('docker', [
    'exec',
    '-i',
    containerName,
    'psql',
    '-U',
    'postgres',
    '-d',
    'diagnostics',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-f',
    '-',
  ], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
}

function queryRows(containerName: string, sql: string): Array<Record<string, string>> {
  const query = sql.trim().replace(/;$/, '');
  const json = execFileSync('docker', [
    'exec',
    '-i',
    containerName,
    'psql',
    '-U',
    'postgres',
    '-d',
    'diagnostics',
    '-X',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `select coalesce(json_agg(row_to_json(q)), '[]'::json)::text from (${query}) q;`,
  ], { encoding: 'utf8' }).trim();
  return (JSON.parse(json) as Array<Record<string, unknown>>).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? 'null' : String(value)]))
  );
}

function queryCorrectRows(containerName: string, scenarioDir: string): Array<Record<string, string>> {
  const correctSeedPath = join(scenarioDir, 'seed_correct.sql');
  const correctQueryPath = join(scenarioDir, 'query_correct.sql');
  if (existsSync(correctSeedPath)) {
    resetDatabase(containerName);
    runSqlInPostgres(containerName, readFileSync(join(scenarioDir, 'schema.sql'), 'utf8'));
    runSqlInPostgres(containerName, readFileSync(correctSeedPath, 'utf8'));
  }
  const queryPath = existsSync(correctQueryPath) ? correctQueryPath : join(scenarioDir, 'query.sql');
  return queryRows(containerName, readFileSync(queryPath, 'utf8'));
}

function runDiagnose(scenarioDir: string, expected: ScenarioExpectation, withDdl: boolean, symptom = expected.symptom): DiagnosticReport {
  const args = [
    '--import',
    'tsx',
    resolve(rootDir, 'src/cli/diagnose.ts'),
    'diagnose',
    '--sql',
    join(scenarioDir, 'query.sql'),
    '--target-column',
    expected.targetColumn,
    '--symptom',
    symptom,
  ];
  if (withDdl) {
    args.push('--ddl', join(scenarioDir, 'schema.sql'));
  }
  const stdout = execFileSync(process.execPath, args, { cwd: rootDir, encoding: 'utf8' });
  return JSON.parse(stdout) as DiagnosticReport;
}

function assertReportMatchesScenario(report: DiagnosticReport, expected: ScenarioExpectation): void {
  expect(report.packets).toHaveLength(1);
  const packet = report.packets[0];
  expect(packet.target.columnName).toBe(expected.targetColumn);

  const actualEffects = new Set([
    ...packet.rowLineage.influences.flatMap((influence) => influence.effects),
    ...packet.candidateConcerns.flatMap((concern) => concern.effects),
  ]);
  for (const effect of expected.expectedEffects) {
    expect(actualEffects, `${expected.id} should include effect ${effect}`).toContain(effect);
  }
  for (const effect of expected.notExpectedEffects) {
    expect(actualEffects, `${expected.id} should not include effect ${effect}`).not.toContain(effect);
  }

  const actualMechanisms = new Set([
    ...packet.rowLineage.influences.map((influence) => influence.mechanism),
    ...packet.candidateConcerns.flatMap((concern) => concern.mechanisms),
  ]);
  for (const mechanism of expected.expectedMechanisms) {
    expect(actualMechanisms, `${expected.id} should include mechanism ${mechanism}`).toContain(mechanism);
  }

  const evidenceText = [
    ...packet.rowLineage.influences.map((influence) => influence.expressionSql ?? ''),
    ...packet.rowLineage.influences.map((influence) => influence.mechanism),
    ...packet.candidateConcerns.flatMap((concern) => concern.evidence),
    ...packet.candidateConcerns.map((concern) => concern.kind),
    ...packet.candidateConcerns.flatMap((concern) => concern.mechanisms),
  ].join('\n').toLowerCase();
  for (const expectedEvidence of expected.expectedEvidenceContains) {
    expect(evidenceText, `${expected.id} should include evidence ${expectedEvidence}`).toContain(expectedEvidence.toLowerCase());
  }

  const actualDomains = new Set(packet.candidateConcerns.flatMap((concern) => concern.checkDomains));
  for (const domain of expected.expectedCheckDomains) {
    expect(actualDomains, `${expected.id} should include check domain ${domain}`).toContain(domain);
  }

  const matchedEffects = packet.candidateConcerns.flatMap((concern) => concern.symptomMatch?.matchedEffects ?? []);
  expect(matchedEffects.length, `${expected.id} should rank at least one symptom-matching concern`).toBeGreaterThan(0);
}

function assertQualityDelta(withoutDdl: DiagnosticReport, withDdl: DiagnosticReport, expected: ScenarioExpectation): void {
  const withoutMetrics = reportQualityMetrics(withoutDdl);
  const withMetrics = reportQualityMetrics(withDdl);
  expect(withMetrics.candidateCount, `${expected.id} DDL diagnosis should keep Recall@5 candidate volume`).toBeLessThanOrEqual(5);
  expect(withMetrics.matchedEffectCount, `${expected.id} DDL diagnosis should not lose symptom matches`).toBeGreaterThanOrEqual(withoutMetrics.matchedEffectCount);
  expect(withMetrics.schemaDomainCount, `${expected.id} DDL diagnosis should preserve schema-assumption visibility`).toBeGreaterThanOrEqual(withoutMetrics.schemaDomainCount);
}

function assertWrongSymptomIsWeaker(correctSymptom: DiagnosticReport, wrongSymptom: DiagnosticReport, expected: ScenarioExpectation): void {
  expect(wrongSymptom.symptom).toMatchObject({ intent: expected.wrongSymptom });
  const correctMetrics = reportQualityMetrics(correctSymptom);
  const wrongMetrics = reportQualityMetrics(wrongSymptom);
  const correctPrimaryMatches = matchedPrimaryEffectCount(correctSymptom, expected.primaryEffects);
  const wrongPrimaryMatches = matchedPrimaryEffectCount(wrongSymptom, expected.primaryEffects);
  expect(correctPrimaryMatches, `${expected.id} correct symptom should match a primary effect`).toBeGreaterThan(0);
  expect(wrongPrimaryMatches, `${expected.id} wrong symptom should not emphasize the primary effect`).toBeLessThan(correctPrimaryMatches);
  expect(wrongMetrics.matchedEffectCount, `${expected.id} wrong symptom should not look stronger than the correct symptom`).toBeLessThanOrEqual(correctMetrics.matchedEffectCount + 1);
  expect(wrongMetrics.firstConcernMatchedEffectCount, `${expected.id} wrong symptom should not rank a stronger first concern`).toBeLessThanOrEqual(correctMetrics.firstConcernMatchedEffectCount);
}

function matchedPrimaryEffectCount(report: DiagnosticReport, primaryEffects: string[]): number {
  const primary = new Set(primaryEffects);
  return report.packets[0].candidateConcerns
    .flatMap((concern) => concern.symptomMatch?.matchedEffects ?? [])
    .filter((effect) => primary.has(effect)).length;
}

function reportQualityMetrics(report: DiagnosticReport): {
  candidateCount: number;
  firstConcernMatchedEffectCount: number;
  matchedEffectCount: number;
  schemaDomainCount: number;
} {
  const concerns = report.packets[0]?.candidateConcerns ?? [];
  return {
    candidateCount: concerns.length,
    firstConcernMatchedEffectCount: concerns[0]?.symptomMatch?.matchedEffects.length ?? 0,
    matchedEffectCount: concerns.reduce((sum, concern) => sum + (concern.symptomMatch?.matchedEffects.length ?? 0), 0),
    schemaDomainCount: concerns.filter((concern) => concern.checkDomains.includes('schema_assumption')).length,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}
