import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInvestigationPlanForCli } from '../cli/diagnose';
import { createInvestigationPlan } from '../lineage/investigationPlan';
import { McpInputError, normalizeCreateInvestigationPlanInput } from './investigationServer';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('create_investigation_plan MCP adapter', () => {
  it('normalizes approved parameter maps, inline DDL strings, target defaults, and duplicate file paths', () => {
    const workspace = temporaryWorkspace();
    writeFileSync(resolve(workspace, 'query.sql'), 'select status from orders where status = :status');
    mkdirSync(resolve(workspace, 'ddl'));
    writeFileSync(resolve(workspace, 'ddl', 'schema.sql'), 'create table orders (status text);');
    writeFileSync(resolve(workspace, 'parameters.json'), JSON.stringify([{ name: 'status', origin: 'original_query_parameter', value: 'paid' }]));

    const inline = normalizeCreateInvestigationPlanInput(workspace, {
      ddl: 'create table orders (status text);',
      investigationKeys: { customer_id: 10 },
      knownParameters: { status: 'paid' },
      sql: 'select status from orders where status = :status',
      symptom: 'missing_rows',
      targetColumn: 'status',
    });
    const fromFiles = normalizeCreateInvestigationPlanInput(workspace, {
      ddlDirectories: ['ddl'],
      ddlFiles: ['ddl/schema.sql'],
      knownParameters: { status: 'paid' },
      sqlPath: 'query.sql',
      symptom: 'missing_rows',
      targetColumn: 'status',
    });

    expect(inline).toMatchObject({
      parameters: [
        { name: 'customer_id', origin: 'investigation_key', value: 10 },
        { name: 'status', origin: 'original_query_parameter', value: 'paid' },
      ],
      sql: fromFiles.sql,
      symptom: fromFiles.symptom,
      target: fromFiles.target,
    });
    expect(inline.target.nodeId).toBe('main_output');
    expect(fromFiles.ddl).toEqual([{ filePath: resolve(workspace, 'ddl', 'schema.sql'), sql: 'create table orders (status text);' }]);
    const cliPlan = createInvestigationPlanForCli([
      '--sql', resolve(workspace, 'query.sql'), '--ddl', resolve(workspace, 'ddl', 'schema.sql'), '--parameters', resolve(workspace, 'parameters.json'), '--target-node', 'main_output', '--target-column', 'status', '--symptom', 'missing_rows',
    ]);
    const mcpPlan = createInvestigationPlan(fromFiles);
    expect(mcpPlan).toEqual(cliPlan);
    expect(createInvestigationPlan(fromFiles)).toEqual(mcpPlan);
  });

  it('rejects external paths, traversal, excluded folders, binary files, and schema input conflicts before planning', () => {
    const workspace = temporaryWorkspace();
    mkdirSync(resolve(workspace, 'node_modules'));
    writeFileSync(resolve(workspace, 'query.sql'), 'select status from orders');
    writeFileSync(resolve(workspace, 'binary.sql'), Buffer.from([0x00]));
    writeFileSync(resolve(workspace, 'facts.json'), JSON.stringify({ tables: {} }));
    const external = temporaryWorkspace();
    writeFileSync(resolve(external, 'outside.sql'), 'create table outside_table (id int);');
    let symlinkAvailable = true;
    try {
      symlinkSync(resolve(external, 'outside.sql'), resolve(workspace, 'escape.sql'), 'file');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error;
      symlinkAvailable = false;
    }
    const request = { sqlPath: 'query.sql', targetColumn: 'status', targetNode: 'main_output' };

    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlFiles: ['../outside.sql'] })).toThrow(McpInputError);
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlFiles: [resolve(workspace, 'query.sql')] })).toThrow(McpInputError);
    if (symlinkAvailable) expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlFiles: ['escape.sql'] })).toThrow('escapes --workspace');
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlDirectories: ['node_modules'] })).toThrow('excluded directory');
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlFiles: ['binary.sql'] })).toThrow('Binary files are not accepted');
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, ddlFiles: ['query.sql'], schemaFactsPath: 'facts.json' })).toThrow('cannot be combined');
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, knownParameters: { 'not-valid': 'paid' } })).toThrow('valid SQL parameter identifier');
  });

  it('serves exactly one stdio tool, returns structured input errors, isolates repeated calls, and does not write the workspace', async () => {
    const workspace = temporaryWorkspace();
    writeFileSync(resolve(workspace, 'query.sql'), 'select status from orders where status = :status');
    mkdirSync(resolve(workspace, 'ddl'));
    writeFileSync(resolve(workspace, 'ddl', 'schema.sql'), 'create table orders (status text);');
    const before = readFileSync(resolve(workspace, 'query.sql'), 'utf8');
    const transport = new StdioClientTransport({
      args: ['--import', 'tsx', resolve(process.cwd(), 'src/mcp/investigationServer.ts'), '--workspace', workspace],
      command: process.execPath,
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'investigation-server-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['create_investigation_plan']);
      expect(listed.tools[0].description).toContain('static SQL/DDL analysis plan only');
      expect(listed.tools[0].description).toContain('never connects to a database or executes SQL');
      expect(listed.tools[0].description).toContain('candidate concerns are unconfirmed');
      expect(listed.tools[0].description).toContain('investigation-only SELECT statements');
      expect(listed.tools[0].description).toContain('not corrected or production SQL');
      expect(listed.tools[0].description).toContain('without inventing unproven SQL');
      expect(listed.tools[0].description).toContain('DDL must be explicitly supplied');
      expect(listed.tools[0].description).toContain('never fetches database schema');
      expect(listed.tools[0].description).toContain('value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows');
      expect(listed.tools[0].description).toContain('rather than free natural-language symptoms');
      expect(listed.tools[0].description).toContain('for example, {customer_id: 10}');
      expect(listed.tools[0].description).toContain('instead of inferring a key from DDL, primary-key status, or columns');
      const inputProperties = listed.tools[0].inputSchema.properties as Record<string, { description?: string }>;
      expect(Object.values(inputProperties).every((property) => typeof property.description === 'string' && property.description.length > 0)).toBe(true);
      expect(inputProperties.symptom.description).toContain('value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows');
      expect(inputProperties.symptom.description).toContain('rather than free natural-language symptoms');
      expect(inputProperties.investigationKeys.description).toContain('for example {customer_id: 10}');
      expect(inputProperties.investigationKeys.description).toContain('ask for its name and value');
      expect(inputProperties.investigationKeys.description).toContain('never infer it from DDL, primary-key status, or columns');

      const request = { sqlPath: 'query.sql', targetColumn: 'status', targetNode: 'main_output' };
      const first = await client.callTool({ name: 'create_investigation_plan', arguments: request });
      const second = await client.callTool({ name: 'create_investigation_plan', arguments: request });
      expect(first.structuredContent).toEqual(second.structuredContent);
      expect(first.structuredContent).toMatchObject({ kind: 'investigation-plan', target: { columnName: 'status', nodeId: 'main_output' } });

      const invalid = await client.callTool({ name: 'create_investigation_plan', arguments: { sql: 'select 1', sqlPath: 'query.sql', targetColumn: 'x', targetNode: 'main_output' } });
      expect(invalid.isError).toBe(true);
      expect(JSON.parse((invalid.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'SQL_SOURCE_REQUIRED', kind: 'invalid_input' });

      const mapAndDefault = await client.callTool({
        name: 'create_investigation_plan',
        arguments: {
          ddl: 'create table orders (status text);',
          investigationKeys: { customer_id: 10 },
          knownParameters: { status: 'paid' },
          sql: 'select status from orders where status = :status',
          targetColumn: 'status',
        },
      });
      expect(mapAndDefault.structuredContent).toMatchObject({
        parameters: [
          { name: 'customer_id', origin: 'investigation_key', value: 10 },
          { name: 'status', origin: 'original_query_parameter', value: 'paid' },
        ],
        target: { nodeId: 'main_output' },
      });

      const duplicateDdl = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { ddlDirectories: ['ddl'], ddlFiles: ['ddl/schema.sql'], sql: 'select status from orders', targetColumn: 'status' },
      });
      expect(duplicateDdl.isError).not.toBe(true);
      expect(duplicateDdl.structuredContent).toMatchObject({ kind: 'investigation-plan', target: { nodeId: 'main_output' } });
    } finally {
      await client.close();
    }
    expect(readFileSync(resolve(workspace, 'query.sql'), 'utf8')).toBe(before);
  });
});

function temporaryWorkspace(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-mcp-'));
  temporaryDirectories.push(directory);
  return directory;
}
