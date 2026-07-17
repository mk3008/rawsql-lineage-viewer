import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInvestigationPlanForCli } from './diagnose';

const opaqueBinding = 'opaque-binding-sentinel';

describe('rawsql-lineage diagnose CLI', () => {
  it('delegates investigation planning exactly once with unchanged static inputs', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const ddlPath = resolve(root, 'schema.sql');
      const parametersPath = resolve(root, 'parameters.json');
      writeFileSync(sqlPath, 'select status from orders where status = :status');
      writeFileSync(ddlPath, 'create table orders (status text);');
      writeFileSync(parametersPath, JSON.stringify({
        bindings: { status: opaqueBinding },
        definitions: [{ name: 'status', origin: 'original_query_parameter' }],
      }));
      const calls: unknown[] = [];
      const plan = createInvestigationPlanForCli([
        '--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'status', '--symptom', 'missing_rows', '--parameters', parametersPath, '--ddl', ddlPath,
      ], {
        createPlan: (input) => {
          calls.push(input);
          return { kind: 'investigation-plan', version: 1 } as ReturnType<typeof createInvestigationPlanForCli>;
        },
      });

      expect(plan).toEqual({ kind: 'investigation-plan', version: 1 });
      expect(calls).toEqual([{
        ddl: [{ filePath: ddlPath, sql: 'create table orders (status text);' }],
        parameters: { bindingPresence: { providedNames: ['status'] }, definitions: [{ name: 'status', origin: 'original_query_parameter' }] },
        sql: 'select status from orders where status = :status',
        symptom: 'missing_rows',
        target: { columnName: 'status', nodeId: 'main_output' },
      }]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('emits an investigation plan as JSON without executing supplied SQL', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const parametersPath = resolve(root, 'parameters.json');
      writeFileSync(sqlPath, 'select status from orders where status = :status');
      writeFileSync(parametersPath, JSON.stringify({
        bindings: { status: opaqueBinding },
        definitions: [{ name: 'status', origin: 'original_query_parameter' }],
      }));

      const stdout = execFileSync(process.execPath, [
        '--import', 'tsx', resolve(process.cwd(), 'src/cli/diagnose.ts'), 'investigate', '--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'status', '--parameters', parametersPath,
      ], { encoding: 'utf8' });
      type SerializedParameter = { name: string; status: string };
      type SerializedProbe = { artifactKind: string; interpretation: { assumptions: string[]; doesNotProve: string[]; expectedColumns: unknown[]; nextEvidence: string[]; observationRules: Array<{ candidateConcernIds: string[]; outcome: string }>; version: number }; parameters: SerializedParameter[]; sql: string; staticSafetyEvidence: { assumptions: string[]; basis: string; confidence: string; executionCaveats: string[]; statementClassification: string; version: number } };
      const plan = JSON.parse(stdout) as { deferredProbes: SerializedProbe[]; diagnostics: Array<{ code: string }>; kind: string; nextEvidenceChecklist: Array<{ kind: string; status: string }>; originalQuery: { artifactKind: string; sql: string }; parameters: SerializedParameter[]; recommendedProbes: SerializedProbe[]; target: { columnName: string; nodeId: string } };

      expect(plan.kind).toBe('investigation-plan');
      expect(plan.originalQuery).toEqual({ artifactKind: 'original_query', sql: 'select status from orders where status = :status' });
      expect(plan.target).toEqual({ columnName: 'status', nodeId: 'main_output', symptom: 'logic_review' });
      expect(plan.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'original_sql_only' })]));
      expect(plan.nextEvidenceChecklist).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'condition', status: 'to_verify' }),
        expect.objectContaining({ kind: 'relation', status: 'to_verify' }),
      ]));
      expect(plan.parameters).toContainEqual(expect.objectContaining({ name: 'status', status: 'provided' }));
      expect(plan.parameters.every((parameter) => !Object.prototype.hasOwnProperty.call(parameter, 'value'))).toBe(true);
      expect([...plan.recommendedProbes, ...plan.deferredProbes].every((probe) => probe.artifactKind === 'investigation_probe')).toBe(true);
      expect(plan.recommendedProbes.every((probe) => probe.sql.startsWith('SELECT '))).toBe(true);
      const concernIds = new Set((plan as unknown as { candidateConcerns: Array<{ id: string }> }).candidateConcerns.map((concern) => concern.id));
      for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
        expect(probe.staticSafetyEvidence).toMatchObject({ basis: 'parser_ast', confidence: 'syntax_only', statementClassification: 'select_statement', version: 1 });
        expect(probe.staticSafetyEvidence.assumptions.length).toBeGreaterThan(0);
        expect(probe.staticSafetyEvidence.executionCaveats).toContain('This static classification does not authorize execution.');
        expect(probe.interpretation).toMatchObject({ version: 1 });
        expect(probe.interpretation.expectedColumns.length).toBeGreaterThan(0);
        expect(probe.interpretation.assumptions.length).toBeGreaterThan(0);
        expect(probe.interpretation.doesNotProve.length).toBeGreaterThan(0);
        expect(probe.interpretation.nextEvidence.length).toBeGreaterThan(0);
        expect(probe.interpretation.observationRules.flatMap((rule) => rule.candidateConcernIds).every((id) => concernIds.has(id))).toBe(true);
        expect(probe.parameters.every((parameter) => !Object.prototype.hasOwnProperty.call(parameter, 'value'))).toBe(true);
      }
      expect(stdout).not.toContain('equivalent_rewrite');
      expect(stdout).not.toContain('corrected_query');
      expect(stdout).not.toContain('readOnly');
      expect(stdout).not.toContain('rootCause');
      for (const forbiddenRuntimeField of ['actualRows', 'observedRows', 'bindingValues', 'causalVerdict', 'correctedSql']) {
        expect(stdout).not.toContain(forbiddenRuntimeField);
      }
      expect(stdout).not.toContain(opaqueBinding);
      expect(stdout).not.toContain('"value"');
      for (const unsafeAssuranceTerm of ['safe_to_execute', 'read_only', 'side_effect_free', 'database_validated', 'executed', 'production_safe']) {
        expect(stdout).not.toContain(unsafeAssuranceTerm);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects duplicate parameter names through the CLI boundary without exposing values', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const parametersPath = resolve(root, 'parameters.json');
      writeFileSync(sqlPath, 'select status from orders');
      writeFileSync(parametersPath, JSON.stringify({
        bindings: { status: opaqueBinding },
        definitions: [
          { name: 'status', origin: 'original_query_parameter' },
          { name: 'status', origin: 'investigation_key' },
        ],
      }));
      let thrown: unknown;
      try {
        createInvestigationPlanForCli(['--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'status', '--parameters', parametersPath]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'PARAMETER_NAME_COLLISION' });
      expect(String((thrown as Error).message)).not.toContain(opaqueBinding);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('reports malformed parameter JSON without echoing its contents', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const parametersPath = resolve(root, 'parameters.json');
      writeFileSync(sqlPath, 'select status from orders');
      writeFileSync(parametersPath, `{ "bindings": { "status": "${opaqueBinding}" }`);

      let thrown: unknown;
      try {
        createInvestigationPlanForCli(['--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'status', '--parameters', parametersPath]);
      } catch (error) {
        thrown = error;
      }
      expect(String((thrown as Error).message)).toBe('Parameters file must contain valid JSON.');
      expect(String((thrown as Error).message)).not.toContain(opaqueBinding);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('emits all output column packets with DDL file input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const ddlPath = resolve(root, 'schema.sql');
      writeFileSync(sqlPath, 'select c.* from customers c');
      writeFileSync(ddlPath, 'create table customers (id int primary key, name text not null);');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--ddl',
        ddlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as {
        kind: string;
        packets: Array<{ target: { columnName: string }; diagnostics: Array<{ code: string }> }>;
        schemaFacts: { kind: string; version: number };
      };

      expect(report.kind).toBe('sql-diagnostic-report');
      expect(report.schemaFacts).toMatchObject({ kind: 'schema-facts', version: 1 });
      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['id', 'name']);
      expect(report.packets[0].diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'lineage_metadata_added' }),
        expect.objectContaining({ code: 'schema_facts_used' }),
      ]));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('emits top-level diagnostics when SQL-only analysis cannot build packets', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      writeFileSync(sqlPath, 'select c.* from customers c');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { diagnostics: Array<{ code: string }>; packets: unknown[] };

      expect(report.packets).toEqual([]);
      expect(report.diagnostics).toEqual([
        expect.objectContaining({ code: 'wildcard_unresolved_without_schema' }),
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts SchemaFacts JSON input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const factsPath = resolve(root, 'schema-facts.json');
      writeFileSync(sqlPath, 'select c.* from customers c');
      writeFileSync(factsPath, JSON.stringify({
        tables: {
          customers: {
            columns: {
              id: { name: 'id', nullable: false, type: 'int' },
              name: { name: 'name', nullable: true, type: 'text' },
            },
            name: 'customers',
            primaryKey: ['id'],
          },
        },
      }));

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--schema-facts',
        factsPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { packets: Array<{ target: { columnName: string } }> };

      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['id', 'name']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts combined DDL directory and DDL file input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const ddlDir = resolve(root, 'ddl');
      const extraDdlPath = resolve(root, 'extra.sql');
      writeFileSync(sqlPath, 'select c.name, o.order_id from customers c join orders o on o.customer_id = c.id');
      writeFileSync(extraDdlPath, 'create table orders (order_id int primary key, customer_id int);');
      mkdirSync(ddlDir);
      writeFileSync(resolve(ddlDir, 'customers.sql'), 'create table customers (id int primary key, name text);');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--ddl-dir',
        ddlDir,
        '--ddl',
        extraDdlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { packets: Array<{ target: { columnName: string }; columnLineage: { sourceLeaves: Array<{ nodeLabel: string }> } }> };

      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['name', 'order_id']);
      expect(report.packets.flatMap((packet) => packet.columnLineage.sourceLeaves.map((source) => source.nodeLabel))).toEqual([
        'customers',
        'orders',
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves WHERE candidates unless safe optimization moves a joined-source predicate into JOIN ON', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const movedPredicateSqlPath = resolve(root, 'moved-predicate.sql');
      const wherePredicateSqlPath = resolve(root, 'where-predicate.sql');
      writeFileSync(
        movedPredicateSqlPath,
        'select c.id from customers c join customer_tags ct on ct.customer_id = c.id where ct.is_active = true',
      );
      writeFileSync(
        wherePredicateSqlPath,
        'select c.id from customers c where c.is_active = true',
      );

      const diagnose = (sqlPath: string) => JSON.parse(execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--target-column',
        'id',
        '--symptom',
        'duplicate_rows',
      ], { encoding: 'utf8' })) as {
        packets: Array<{
          rowLineage: { influences: Array<{ expressionSql?: string; mechanism: string }> };
        }>;
      };

      const movedPredicateMechanisms = diagnose(movedPredicateSqlPath).packets[0].rowLineage.influences;
      expect(movedPredicateMechanisms).toEqual(expect.arrayContaining([
        expect.objectContaining({ mechanism: 'join', expressionSql: expect.stringContaining('ct.is_active = true') }),
      ]));
      expect(movedPredicateMechanisms.map((influence) => influence.mechanism)).not.toContain('where');

      const wherePredicateMechanisms = diagnose(wherePredicateSqlPath).packets[0].rowLineage.influences;
      expect(wherePredicateMechanisms).toEqual(expect.arrayContaining([
        expect.objectContaining({ mechanism: 'where', expressionSql: 'c.is_active = true' }),
      ]));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
