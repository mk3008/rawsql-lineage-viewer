import { createHash } from 'node:crypto';
import { SqlParser, SimpleSelectQuery } from 'rawsql-ts';
import type { Client } from 'pg';
import { generateFixtureExtractionPlanV0 } from '../../../src/lineage/fixture-extraction/generateFixtureExtractionPlanV0';
import type { FixtureExtractionStepV0 } from '../../../src/lineage/fixture-extraction/fixtureExtractionPlanV0';
import type {
  AcceptedHarnessCase,
  ExpectedCaptureResult,
  Scalar,
  SourceRelationFixture,
} from './cases/acceptedCases';
import { compileNamedParameters } from './namedParameters';
import { compareStructuredResults, type StructuredResult } from './results';

export interface CaptureEvidence {
  readonly boundaryStatus: 'bounded';
  readonly emptyResultRequired: boolean;
  readonly emptyResultRequiredSatisfied: boolean;
  readonly expectedColumnsMatch: true;
  readonly expectedRowsMatch: true;
  readonly executedSqlHash: string;
  readonly generatedSqlHash: string;
  readonly parameterMapping: readonly { readonly name: string; readonly position: number }[];
  readonly relationName: string;
  readonly reparsedAsSelect: true;
  readonly rowCount: number;
  readonly stepId: string;
}

export interface ScenarioEvidence {
  readonly blockedCodes: readonly string[];
  readonly capture: readonly CaptureEvidence[];
  readonly comparison: ReturnType<typeof compareStructuredResults> | null;
  readonly executedCaptureSelectCount: number;
  readonly generatedCaptureSelectCount: number;
  readonly id: string;
  readonly mismatchClassification: 'blocked_zero_execution' | 'match' | 'mismatch';
  readonly planStatus: string;
  readonly sourceOriginalResult: StructuredResult | null;
  readonly targetOriginalResult: StructuredResult | null;
  readonly transferredRowCount: number;
}

export async function runHarnessCase(
  source: Client,
  target: Client,
  scenario: AcceptedHarnessCase,
): Promise<ScenarioEvidence> {
  const plan = generateFixtureExtractionPlanV0({
    sql: scenario.sql,
    ddl: [{ sql: scenario.ddl }],
    reproductionKey: scenario.reproductionKey,
  });
  const blockedCodes = plan.blockedReasons.map((reason) => reason.code);

  if (scenario.expectedPlanStatus === 'blocked') {
    if (plan.status !== 'blocked' || plan.steps.length !== 0 || plan.suggestedCaptureOrder.length !== 0) {
      throw new Error(`${scenario.id}: blocked scenario produced executable capture steps.`);
    }
    if (!scenario.expectedBlockedCode || !blockedCodes.includes(scenario.expectedBlockedCode)) {
      throw new Error(`${scenario.id}: expected blocker ${scenario.expectedBlockedCode ?? 'missing'} was not returned.`);
    }
    return {
      blockedCodes,
      capture: [],
      comparison: null,
      executedCaptureSelectCount: 0,
      generatedCaptureSelectCount: 0,
      id: scenario.id,
      mismatchClassification: 'blocked_zero_execution',
      planStatus: plan.status,
      sourceOriginalResult: null,
      targetOriginalResult: null,
      transferredRowCount: 0,
    };
  }

  if (plan.status !== 'ready' || plan.blockedReasons.length > 0) {
    throw new Error(`${scenario.id}: expected a complete ready plan but received ${plan.status}.`);
  }
  await resetSchema(source);
  await resetSchema(target);
  await source.query(scenario.ddl);
  await target.query(scenario.ddl);
  for (const relation of scenario.sourceRelations) await insertFixtureRows(source, relation);

  const sourceOriginalResult = await executeOriginalQuery(source, scenario);
  if (scenario.expectedResultRows === undefined || sourceOriginalResult.rows.length !== scenario.expectedResultRows) {
    throw new Error(`${scenario.id}: source original query returned an unexpected row count.`);
  }

  const stepById = new Map(plan.steps.map((step) => [step.id, step]));
  const captureByStep = new Map<string, StructuredResult>();
  const capture: CaptureEvidence[] = [];
  for (const stepId of plan.suggestedCaptureOrder) {
    const step = requireExecutableStep(scenario.id, stepById.get(stepId));
    const statement = compileNamedParameters(step.sql, step.parameterNames, scenario.bindings);
    const result = await queryStructured(source, statement.text, statement.values);
    const expected = scenario.expectedCaptures?.[step.relationName];
    if (!expected) throw new Error(`${scenario.id}: ${step.relationName} has no accepted capture oracle.`);
    const exactAssertion = assertExpectedCapture(scenario.id, step.relationName, expected, result);
    const emptyResultRequired = step.resultExpectation.kind === 'empty_result_required';
    if (emptyResultRequired && result.rows.length !== 0) {
      throw new Error(`${scenario.id}: required absence evidence was not empty.`);
    }
    captureByStep.set(step.id, result);
    capture.push({
      boundaryStatus: 'bounded',
      emptyResultRequired,
      emptyResultRequiredSatisfied: emptyResultRequired && result.rows.length === 0,
      expectedColumnsMatch: exactAssertion.expectedColumnsMatch,
      expectedRowsMatch: exactAssertion.expectedRowsMatch,
      executedSqlHash: hash(statement.text),
      generatedSqlHash: hash(step.sql),
      parameterMapping: statement.mapping,
      relationName: step.relationName,
      reparsedAsSelect: true,
      rowCount: result.rows.length,
      stepId: step.id,
    });
  }

  let transferredRowCount = 0;
  for (const stepId of plan.suggestedLoadOrder) {
    const step = requireExecutableStep(scenario.id, stepById.get(stepId));
    const result = captureByStep.get(step.id);
    if (!result) throw new Error(`${scenario.id}: load order referenced an uncaptured step.`);
    transferredRowCount += await insertCapturedRows(target, step.relationName, result);
  }

  const targetOriginalResult = await executeOriginalQuery(target, scenario);
  const comparison = compareStructuredResults(sourceOriginalResult, targetOriginalResult, scenario.orderedResult);
  return {
    blockedCodes,
    capture,
    comparison,
    executedCaptureSelectCount: capture.length,
    generatedCaptureSelectCount: plan.steps.length,
    id: scenario.id,
    mismatchClassification: comparison.match ? 'match' : 'mismatch',
    planStatus: plan.status,
    sourceOriginalResult,
    targetOriginalResult,
    transferredRowCount,
  };
}

export function assertExpectedCapture(
  scenarioId: string,
  relationName: string,
  expected: ExpectedCaptureResult,
  actual: StructuredResult,
): { expectedColumnsMatch: true; expectedRowsMatch: true } {
  const comparison = compareStructuredResults(expected, actual, expected.ordered ?? false);
  if (!comparison.match) {
    throw new Error(`${scenarioId}: ${relationName} capture did not match exact synthetic columns and rows.`);
  }
  return { expectedColumnsMatch: true, expectedRowsMatch: true };
}

export function requireExecutableStep(scenarioId: string, step: FixtureExtractionStepV0 | undefined) {
  if (!step || step.sql === null || step.boundary.status !== 'bounded' || step.blockedReasonCodes.length > 0) {
    throw new Error(`${scenarioId}: refused to execute an absent, partial, unknown, or blocked capture step.`);
  }
  if (!(SqlParser.parse(step.sql) instanceof SimpleSelectQuery)) {
    throw new Error(`${scenarioId}: generated capture SQL did not reparse as SELECT.`);
  }
  return step;
}

export function buildParameterizedInsert(
  relationName: string,
  columns: readonly string[],
): string {
  if (columns.length === 0) throw new Error('Cannot insert a row without columns.');
  const identifiers = columns.map(quoteIdentifier).join(', ');
  const values = columns.map((_column, index) => `$${index + 1}`).join(', ');
  return `insert into ${quoteQualifiedIdentifier(relationName)} (${identifiers}) values (${values})`;
}

async function resetSchema(client: Client): Promise<void> {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
}

async function executeOriginalQuery(client: Client, scenario: AcceptedHarnessCase): Promise<StructuredResult> {
  const statement = compileNamedParameters(scenario.sql, Object.keys(scenario.bindings), scenario.bindings);
  return queryStructured(client, statement.text, statement.values);
}

async function insertFixtureRows(client: Client, fixture: SourceRelationFixture): Promise<void> {
  const statement = buildParameterizedInsert(fixture.name, fixture.columns);
  for (const row of fixture.rows) {
    if (row.length !== fixture.columns.length) throw new Error(`${fixture.name}: fixture row shape does not match its columns.`);
    await client.query(statement, [...row]);
  }
}

async function insertCapturedRows(client: Client, relationName: string, result: StructuredResult): Promise<number> {
  if (result.rows.length === 0) return 0;
  const statement = buildParameterizedInsert(relationName, result.columns);
  for (const row of result.rows) await client.query(statement, [...row]);
  return result.rows.length;
}

async function queryStructured(client: Client, text: string, values: readonly Scalar[]): Promise<StructuredResult> {
  const result = await client.query({ text, values: [...values], rowMode: 'array' });
  return {
    columns: result.fields.map((field) => field.name),
    rows: result.rows as Scalar[][],
  };
}

function quoteQualifiedIdentifier(value: string): string {
  return value.split('.').map(quoteIdentifier).join('.');
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe synthetic identifier: ${value}`);
  return `"${value}"`;
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
