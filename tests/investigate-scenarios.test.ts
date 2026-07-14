import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInvestigationPlanForCli } from '../src/cli/diagnose';
import type { InvestigationPlanV1 } from '../src/lineage/investigationPlan';

interface ScenarioExpectation {
  id: string;
  symptom: string;
  targetColumn: string;
}

const scenarioRoot = resolve(process.cwd(), 'tests/scenarios');
const scenarioNames = readdirSync(scenarioRoot)
  .filter((entry) => existsSync(join(scenarioRoot, entry, 'expected.json')))
  .sort();
const temporaryDirectories: string[] = [];
const parameterValue = 'must-not-appear-in-probe-sql';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('rawsql-lineage investigate scenario fixtures', () => {
  it.each(scenarioNames)('creates a static, non-conclusive plan for %s', async (scenarioName) => {
    const scenarioDir = join(scenarioRoot, scenarioName);
    const expected = readJson<ScenarioExpectation>(join(scenarioDir, 'expected.json'));
    const parametersPath = join(await temporaryDirectory(), 'parameters.json');
    writeFileSync(parametersPath, JSON.stringify([
      { name: 'scenario_marker', origin: 'original_query_parameter', value: parameterValue },
    ]));

    const plan = createInvestigationPlanForCli([
      '--sql', join(scenarioDir, 'query.sql'),
      '--ddl', join(scenarioDir, 'schema.sql'),
      '--target-node', 'main_output',
      '--target-column', expected.targetColumn,
      '--symptom', expected.symptom,
      '--parameters', parametersPath,
    ]);

    assertStaticInvestigationPlan(plan, expected, parameterValue);
  });

  it.each(scenarioNames)('only recommends a proven node-query outer filter for the eligible %s fixture', async (scenarioName) => {
    const scenarioDir = join(scenarioRoot, scenarioName);
    const expected = readJson<ScenarioExpectation>(join(scenarioDir, 'expected.json'));
    const parametersPath = join(await temporaryDirectory(), 'parameters.json');
    writeFileSync(parametersPath, JSON.stringify([
      { name: 'customer_id', origin: 'investigation_key', value: 10 },
      { name: 'scenario_marker', origin: 'original_query_parameter', value: parameterValue },
    ]));

    const plan = createInvestigationPlanForCli([
      '--sql', join(scenarioDir, 'query.sql'),
      '--ddl', join(scenarioDir, 'schema.sql'),
      '--target-node', 'main_output',
      '--target-column', expected.targetColumn,
      '--symptom', expected.symptom,
      '--parameters', parametersPath,
    ]);
    const probes = plan.recommendedProbes.filter((probe) => probe.kind === 'node_query_outer_filter');

    if (scenarioName === 'value-too-low-status-filter') {
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({ id: 'probe:node-query-outer-filter:01', nodeId: 'main_output', readOnly: true });
      expect(probes[0].parameters.map((parameter) => parameter.name)).toEqual(['customer_id']);
    } else {
      expect(probes).toEqual([]);
    }
  });
});

function assertStaticInvestigationPlan(plan: InvestigationPlanV1, expected: ScenarioExpectation, forbiddenParameterValue: string): void {
  expect(JSON.parse(JSON.stringify(plan))).toMatchObject({
    analysisMode: 'original',
    kind: 'investigation-plan',
    target: { columnName: expected.targetColumn, nodeId: 'main_output', symptom: expected.symptom },
    version: 1,
  });
  expect(plan.candidateConcerns).not.toHaveLength(0);
  expect(plan.candidateConcerns.every((concern) => concern.status === 'candidate')).toBe(true);
  expect(plan.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'original_sql_only' }),
  ]));
  expect(plan.limitations).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'no_database_access' }),
    expect.objectContaining({ code: 'original_analysis_only' }),
  ]));

  for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
    expect(probe.readOnly).toBe(true);
    expect(probe.sql).toMatch(/^SELECT\s/i);
    expect(probe.sql).not.toContain(forbiddenParameterValue);
  }
  for (const blockedProbe of plan.blockedProbes) {
    expect(blockedProbe.status).toBe('blocked');
  }
  expect(plan.recommendedProbes.length + plan.blockedProbes.length + plan.deferredProbes.length).toBeGreaterThan(0);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rawsql-lineage-investigate-scenarios-'));
  temporaryDirectories.push(directory);
  return directory;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}
