import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureTargetDiscoveryWorkflows } from './run';

const workspace = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-target-discovery-'));

afterAll(() => rmSync(workspace, { force: true, recursive: true }));

describe('target-discovery MCP workflow dogfooding', () => {
  it('measures composable and high-level workflows over repository-owned SQL/DDL-only scenarios', async () => {
    const scenarios = [
      ['value-too-low-status-filter', 'paid_amount'],
      ['value-too-high-join-multiplication', 'total_amount'],
      ['duplicate-rows-duplicate-master', 'id'],
    ] as const;
    for (const [id] of scenarios) {
      const destination = resolve(workspace, id);
      mkdirSync(destination, { recursive: true });
      const source = resolve(process.cwd(), 'tests', 'scenarios', id);
      writeFileSync(resolve(destination, 'query.sql'), readFileSync(resolve(source, 'query.sql')));
      writeFileSync(resolve(destination, 'schema.sql'), readFileSync(resolve(source, 'schema.sql')));
    }
    const client = await connectClient();
    try {
      const evidence = [];
      for (const [scenarioId, targetColumn] of scenarios) {
        const staticArguments = { ddlFiles: [`${scenarioId}/schema.sql`], sqlPath: `${scenarioId}/query.sql` };
        const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: staticArguments });
        const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: staticArguments });
        const target = (discovery.structuredContent as { targets: Array<{ id: string; identity: { column: { name: string }; node: { id: string } }; selection: { status: string } }> }).targets
          .find((candidate) => candidate.identity.node.id === 'main_output' && candidate.identity.column.name === targetColumn && candidate.selection.status === 'selectable');
        expect(target).toBeDefined();
        const composablePlan = await client.callTool({
          name: 'create_investigation_plan',
          arguments: { ...staticArguments, targetId: target!.id },
        });
        const highLevelPlan = await client.callTool({
          name: 'create_investigation_plan',
          arguments: { ...staticArguments, targetColumn },
        });
        expect(composablePlan.structuredContent).toEqual(highLevelPlan.structuredContent);
        evidence.push(measureTargetDiscoveryWorkflows({ analysis, composablePlan, discovery, highLevelPlan, scenarioId }));
      }

      expect(evidence).toHaveLength(3);
      expect(evidence.every((item) => item.composable.completed && item.highLevel.completed)).toBe(true);
      expect(evidence.every((item) => item.composable.callCount === 3 && item.highLevel.callCount === 1)).toBe(true);
      expect(evidence.every((item) => item.composable.intermediateJsonBytes > 0 && item.highLevel.intermediateJsonBytes === 0)).toBe(true);
      expect(evidence.every((item) => item.realLlmToolSelection === 'UNCONFIRMED')).toBe(true);
      expect(new Set(evidence.map((item) => item.composable.boundaryClarity))).toEqual(new Set(['explicit_static_stages']));
    } finally {
      await client.close();
    }
  });

  it('localizes duplicate-output ambiguity before plan creation in the composable workflow', async () => {
    const client = await connectClient();
    try {
      const arguments_ = { sql: 'SELECT 1 AS repeated, 2 AS repeated' };
      const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: arguments_ });
      const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: arguments_ });
      const evidence = measureTargetDiscoveryWorkflows({ analysis, discovery, scenarioId: 'duplicate-output-name' });

      expect(evidence).toMatchObject({
        ambiguityHandling: 'explicit_before_planning',
        composable: { callCount: 2, completed: false, errorLocalization: 'target_discovery' },
        highLevel: { callCount: 0, completed: false, errorLocalization: 'not_attempted' },
        realLlmToolSelection: 'UNCONFIRMED',
      });
      expect(evidence.composable.intermediateJsonBytes).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

async function connectClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    args: ['--import', 'tsx', resolve(process.cwd(), 'src/mcp/investigationServer.ts'), '--workspace', workspace],
    command: process.execPath,
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'target-discovery-dogfooding', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
