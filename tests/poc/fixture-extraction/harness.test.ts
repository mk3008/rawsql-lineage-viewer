import { SqlParser, SimpleSelectQuery } from 'rawsql-ts';
import { describe, expect, it } from 'vitest';
import { generateFixtureExtractionPlanV0 } from '../../../src/lineage/fixture-extraction/generateFixtureExtractionPlanV0';
import { acceptedHarnessCases } from './cases/acceptedCases';
import { assertExpectedCapture, buildParameterizedInsert, requireExecutableStep } from './harness';
import { compileNamedParameters } from './namedParameters';
import { compareStructuredResults } from './results';

describe('fixture extraction external harness plan gate', () => {
  for (const scenario of acceptedHarnessCases) {
    it(`${scenario.id} honors its accepted plan status without executing SQL`, () => {
      const plan = generateFixtureExtractionPlanV0({
        sql: scenario.sql,
        ddl: [{ sql: scenario.ddl }],
        reproductionKey: scenario.reproductionKey,
      });
      expect(plan.status).toBe(scenario.expectedPlanStatus);

      if (scenario.expectedPlanStatus === 'blocked') {
        expect(plan.steps).toEqual([]);
        expect(plan.suggestedCaptureOrder).toEqual([]);
        expect(plan.blockedReasons.map((reason) => reason.code)).toContain(scenario.expectedBlockedCode);
        return;
      }

      expect(plan.blockedReasons).toEqual([]);
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.map((step) => step.relationName).sort())
        .toEqual(Object.keys(scenario.expectedCaptures ?? {}).sort());
      for (const step of plan.steps) {
        const executable = requireExecutableStep(scenario.id, step);
        expect(SqlParser.parse(executable.sql)).toBeInstanceOf(SimpleSelectQuery);
        expect(executable.sql).not.toMatch(/\blimit\b/i);
        const statement = compileNamedParameters(executable.sql, executable.parameterNames, scenario.bindings);
        expect(statement.text).not.toMatch(/:[A-Za-z_][A-Za-z0-9_]*/);
        expect(statement.values).toHaveLength(executable.parameterNames.length);
      }
    });
  }
});

describe('fixture extraction external harness mechanics', () => {
  it('binds repeated named parameters without altering strings, comments, or casts', () => {
    const statement = compileNamedParameters(
      "select :id, ':ignored', value::integer -- :comment\nfrom sample where id = :id",
      ['id'],
      { id: 7 },
    );
    expect(statement.text).toBe("select $1, ':ignored', value::integer -- :comment\nfrom sample where id = $1");
    expect(statement.values).toEqual([7]);
    expect(statement.mapping).toEqual([{ name: 'id', position: 1 }]);
  });

  it('builds generic INSERT text with positional values only', () => {
    expect(buildParameterizedInsert('public.fixture_row', ['id', 'nullable_value']))
      .toBe('insert into "public"."fixture_row" ("id", "nullable_value") values ($1, $2)');
  });

  it('rejects same-count captures with wrong columns or scalar values', () => {
    expect(() => assertExpectedCapture(
      'synthetic-case',
      'synthetic_relation',
      { columns: ['id', 'state'], rows: [[1, 'active']] },
      { columns: ['id', 'wrong_state'], rows: [[1, 'active']] },
    )).toThrow('did not match exact synthetic columns and rows');
    expect(() => assertExpectedCapture(
      'synthetic-case',
      'synthetic_relation',
      { columns: ['id', 'state'], rows: [[1, 'active']] },
      { columns: ['id', 'state'], rows: [[1, 'paused']] },
    )).toThrow('did not match exact synthetic columns and rows');
  });

  it('compares unordered results as multisets and preserves duplicate and NULL evidence', () => {
    const source = { columns: ['id', 'value'], rows: [[1, null], [1, null], [2, 'x']] } as const;
    const target = { columns: ['id', 'value'], rows: [[2, 'x'], [1, null], [1, null]] } as const;
    expect(compareStructuredResults(source, target, false)).toMatchObject({
      duplicateRowsPreserved: true,
      match: true,
      missingRows: [],
      nullsPreserved: true,
      rowCountMatch: true,
    });
  });

  it('classifies missing and extra rows explicitly', () => {
    const comparison = compareStructuredResults(
      { columns: ['id'], rows: [[1], [1], [2]] },
      { columns: ['id'], rows: [[1], [3]] },
      false,
    );
    expect(comparison.match).toBe(false);
    expect(comparison.missingRows).toHaveLength(2);
    expect(comparison.extraRows).toHaveLength(1);
    expect(comparison.duplicateRowsPreserved).toBe(false);
  });
});
