import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpInputError, normalizeCreateInvestigationPlanInput } from './investigationServer';

const temporaryDirectories: string[] = [];
const symlinkIt = canCreateSymlinks() ? it : it.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('MCP workspace path security', () => {
  symlinkIt('rejects external SQL, DDL file, schema facts, and DDL directory targets before reading their content', () => {
    const workspace = temporaryDirectory('workspace');
    const external = temporaryDirectory('external');
    const marker = 'EXTERNAL_CONTENT_MUST_NOT_LEAK_7f1c';
    const externalSql = resolve(external, 'outside.sql');
    const externalDdl = resolve(external, 'outside-ddl.sql');
    const externalFacts = resolve(external, 'outside-facts.json');
    const externalDdlDirectory = resolve(external, 'ddl');
    mkdirSync(externalDdlDirectory);
    writeFileSync(externalSql, Buffer.concat([Buffer.from(marker), Buffer.alloc(1024 * 1024)]));
    writeFileSync(externalDdl, Buffer.concat([Buffer.from(marker), Buffer.from([0])]));
    writeFileSync(externalFacts, `{not-json:${marker}}`);
    writeFileSync(resolve(externalDdlDirectory, 'schema.sql'), marker);
    symlinkSync(externalSql, resolve(workspace, 'sql-link.sql'), 'file');
    symlinkSync(externalDdl, resolve(workspace, 'ddl-link.sql'), 'file');
    symlinkSync(externalFacts, resolve(workspace, 'facts-link.json'), 'file');
    symlinkSync(externalDdlDirectory, resolve(workspace, 'ddl-link'), 'dir');
    symlinkSync(externalDdlDirectory, resolve(workspace, 'node_modules'), 'dir');

    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: 'sql-link.sql', targetColumn: 'leaked_marker' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlFiles: ['ddl-link.sql'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { schemaFactsPath: 'facts-link.json', sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['ddl-link'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['node_modules'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
  });

  symlinkIt('rejects external nested file, nested directory, and chained symlink targets without leaking markers', () => {
    const workspace = temporaryDirectory('workspace');
    const external = temporaryDirectory('external');
    const marker = 'NESTED_EXTERNAL_MARKER_MUST_NOT_LEAK_b8d2';
    const externalFile = resolve(external, 'schema.sql');
    const externalDirectory = resolve(external, 'ddl');
    mkdirSync(externalDirectory);
    writeFileSync(externalFile, marker);
    writeFileSync(resolve(externalDirectory, 'nested.sql'), marker);

    const nestedFileRoot = resolve(workspace, 'nested-file');
    const nestedDirectoryRoot = resolve(workspace, 'nested-directory');
    const nestedExcludedRoot = resolve(workspace, 'nested-excluded');
    mkdirSync(nestedFileRoot);
    mkdirSync(nestedDirectoryRoot);
    mkdirSync(nestedExcludedRoot);
    symlinkSync(externalFile, resolve(nestedFileRoot, 'schema.sql'), 'file');
    symlinkSync(externalDirectory, resolve(nestedDirectoryRoot, 'external'), 'dir');
    symlinkSync(externalDirectory, resolve(nestedExcludedRoot, 'node_modules'), 'dir');
    symlinkSync(externalFile, resolve(workspace, 'external-hop.sql'), 'file');
    symlinkSync(resolve(workspace, 'external-hop.sql'), resolve(workspace, 'chain.sql'), 'file');

    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['nested-file'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['nested-directory'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['nested-excluded'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: 'chain.sql', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
      marker,
    );
  });

  symlinkIt('allows internal symlink targets and deduplicates DDL by canonical path', () => {
    const workspace = temporaryDirectory('workspace');
    const sources = resolve(workspace, 'sources');
    const ddlDirectory = resolve(workspace, 'ddl');
    mkdirSync(sources);
    mkdirSync(ddlDirectory);
    mkdirSync(resolve(ddlDirectory, 'node_modules'));
    writeFileSync(resolve(sources, 'query.sql'), 'select id from orders');
    writeFileSync(resolve(ddlDirectory, 'schema.sql'), 'create table orders (id int);');
    writeFileSync(resolve(ddlDirectory, 'node_modules', 'ignored.sql'), 'create table ignored (id int);');
    writeFileSync(resolve(workspace, 'facts.json'), JSON.stringify({ tables: {} }));
    symlinkSync(resolve(sources, 'query.sql'), resolve(workspace, 'query-link.sql'), 'file');
    symlinkSync(resolve(ddlDirectory, 'schema.sql'), resolve(workspace, 'schema-link.sql'), 'file');
    symlinkSync(ddlDirectory, resolve(workspace, 'ddl-link'), 'dir');
    symlinkSync(resolve(workspace, 'facts.json'), resolve(workspace, 'facts-link.json'), 'file');

    const fromDdl = normalizeCreateInvestigationPlanInput(workspace, {
      ddlDirectories: ['ddl', 'ddl-link'],
      ddlFiles: ['ddl/schema.sql', 'schema-link.sql'],
      sqlPath: 'query-link.sql',
      targetColumn: 'id',
    });
    const fromFacts = normalizeCreateInvestigationPlanInput(workspace, {
      schemaFactsPath: 'facts-link.json',
      sql: 'select 1 as id',
      targetColumn: 'id',
    });

    expect(fromDdl.sql).toBe('select id from orders');
    expect(fromDdl.ddl).toEqual([{ filePath: realpathSync(resolve(ddlDirectory, 'schema.sql')), sql: 'create table orders (id int);' }]);
    expect(fromFacts.schemaFacts).toMatchObject({ kind: 'schema-facts', tables: {}, version: 1 });
  });

  it('preserves traversal, absolute-path, missing-path, exclusion, extension, and configured limit errors', () => {
    const workspace = temporaryDirectory('workspace');
    writeFileSync(resolve(workspace, 'query.sql'), 'select 1 as id');
    writeFileSync(resolve(workspace, 'schema.txt'), 'create table example (id int);');
    writeFileSync(resolve(workspace, 'oversized.sql'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    mkdirSync(resolve(workspace, 'node_modules'));

    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: '../query.sql', targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: resolve(workspace, 'query.sql'), targetColumn: 'id' }),
      'PATH_OUTSIDE_WORKSPACE',
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: 'missing.sql', targetColumn: 'id' }),
      'PATH_NOT_FOUND',
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['node_modules'], sql: 'select 1 as id', targetColumn: 'id' }),
      'PATH_EXCLUDED',
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlFiles: ['schema.txt'], sql: 'select 1 as id', targetColumn: 'id' }),
      'DDL_FILE_TYPE',
    );
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { sqlPath: 'oversized.sql', targetColumn: 'id' }),
      'FILE_SIZE_LIMIT',
    );

    const tooDeep = resolve(workspace, 'too-deep');
    mkdirSync(tooDeep);
    let current = tooDeep;
    for (let index = 0; index < 9; index += 1) {
      current = resolve(current, `level-${index}`);
      mkdirSync(current);
    }
    writeFileSync(resolve(current, 'schema.sql'), 'create table example (id int);');
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['too-deep'], sql: 'select 1 as id', targetColumn: 'id' }),
      'DDL_DIRECTORY_DEPTH',
    );

    const tooMany = resolve(workspace, 'too-many');
    mkdirSync(tooMany);
    for (let index = 0; index < 129; index += 1) writeFileSync(resolve(tooMany, `${index}.sql`), 'select 1;');
    expectInputError(
      () => normalizeCreateInvestigationPlanInput(workspace, { ddlDirectories: ['too-many'], sql: 'select 1 as id', targetColumn: 'id' }),
      'DDL_FILE_LIMIT',
    );
  });
});

function expectInputError(operation: () => unknown, code: string, forbiddenText?: string): McpInputError {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof McpInputError)) throw error;
    expect(error.code).toBe(code);
    if (forbiddenText) expect(`${error.code}: ${error.message}`).not.toContain(forbiddenText);
    return error;
  }
  throw new Error(`Expected McpInputError with code ${code}.`);
}

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), `rawsql-lineage-mcp-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function canCreateSymlinks(): boolean {
  const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-mcp-symlink-check-'));
  const file = resolve(root, 'file');
  const directory = resolve(root, 'directory');
  try {
    writeFileSync(file, 'test');
    mkdirSync(directory);
    symlinkSync(file, resolve(root, 'file-link'), 'file');
    symlinkSync(directory, resolve(root, 'directory-link'), 'dir');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EACCES', 'EPERM', 'UNKNOWN'].includes(String(error.code))) return false;
    throw error;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
