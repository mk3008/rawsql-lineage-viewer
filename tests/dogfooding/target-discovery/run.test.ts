import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureTargetDiscoveryWorkflows } from './run';
import type { TargetDiscoveryScenarioEvidenceV1 } from './run';

const workspace = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-target-discovery-'));
const recordedEvidence: TargetDiscoveryScenarioEvidenceV1[] = [];

afterAll(() => {
  process.stdout.write(`[target-discovery-workflow-evidence] ${JSON.stringify(recordedEvidence)}\n`);
  rmSync(workspace, { force: true, recursive: true });
});

describe('target-discovery MCP workflow dogfooding', () => {
  it('compares both workflows from identical repository-owned unknown-target inputs', async () => {
    const scenarioIds = [
      'value-too-low-status-filter',
      'value-too-high-join-multiplication',
      'duplicate-rows-duplicate-master',
    ] as const;
    for (const id of scenarioIds) copyScenario(id);
    const client = await connectClient();
    try {
      const evidence = [];
      for (const scenarioId of scenarioIds) {
        const staticArguments = { ddlFiles: [`${scenarioId}/schema.sql`], sqlPath: `${scenarioId}/query.sql` };
        const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: staticArguments });
        const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: staticArguments });
        const highLevelPreparation = await client.callTool({ name: 'prepare_sql_investigation', arguments: staticArguments });
        const selectable = selectableTargetIds(discovery.structuredContent);
        expect(selectable.length).toBeGreaterThan(1);
        expect(highLevelPreparation.structuredContent).toMatchObject({
          discovery: discovery.structuredContent,
          selection: { reason: 'multiple_selectable_targets', selectableTargetIds: selectable },
          status: 'selection_required',
        });
        expect(highLevelPreparation.structuredContent).not.toHaveProperty('plan');
        const item = measureTargetDiscoveryWorkflows({ analysis, discovery, highLevelPreparation, scenarioId });
        evidence.push(item);
        recordedEvidence.push(item);
      }

      expect(evidence).toHaveLength(3);
      expect(evidence.every((item) => !item.composable.completed && !item.highLevel.completed)).toBe(true);
      expect(evidence.every((item) => item.composable.callCount === 2 && item.highLevel.callCount === 1)).toBe(true);
      expect(evidence.every((item) => item.composable.selectionOutcome === 'selection_required' && item.highLevel.selectionOutcome === 'selection_required')).toBe(true);
      expect(evidence.every((item) => item.composable.intermediateJsonBytes > 0 && item.highLevel.intermediateJsonBytes === 0)).toBe(true);
      expect(evidence.every((item) => item.realLlmToolSelection === 'UNCONFIRMED')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('creates the same plan only when the unknown-target input has one selectable target', async () => {
    const client = await connectClient();
    try {
      const staticArguments = {
        ddl: 'CREATE TABLE orders (status text);',
        sql: 'SELECT COUNT(*) AS row_count FROM orders',
      };
      const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: staticArguments });
      const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: staticArguments });
      const [targetId] = selectableTargetIds(discovery.structuredContent);
      expect(targetId).toBeDefined();
      expect(selectableTargetIds(discovery.structuredContent)).toHaveLength(1);
      const composablePlan = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { ...staticArguments, targetId },
      });
      const highLevelPreparation = await client.callTool({ name: 'prepare_sql_investigation', arguments: staticArguments });
      expect(highLevelPreparation.structuredContent).toMatchObject({
        selection: { mode: 'single_selectable_target', targetId },
        status: 'plan_created',
      });
      expect((highLevelPreparation.structuredContent as { plan: unknown }).plan).toEqual(composablePlan.structuredContent);

      const evidence = measureTargetDiscoveryWorkflows({ analysis, composablePlan, discovery, highLevelPreparation, scenarioId: 'single-selectable-target' });
      recordedEvidence.push(evidence);
      expect(evidence).toMatchObject({
        composable: { callCount: 3, completed: true, errorLocalization: 'none', selectionOutcome: 'plan_created' },
        highLevel: { callCount: 1, completed: true, errorLocalization: 'none', selectionOutcome: 'plan_created' },
        realLlmToolSelection: 'UNCONFIRMED',
      });
      expect(evidence.composable.intermediateJsonBytes).toBeGreaterThan(0);
      expect(evidence.highLevel.intermediateJsonBytes).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('reports duplicate-output ambiguity without either workflow creating a plan', async () => {
    const client = await connectClient();
    try {
      const staticArguments = { sql: 'SELECT 1 AS repeated, 2 AS repeated' };
      const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: staticArguments });
      const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: staticArguments });
      const highLevelPreparation = await client.callTool({ name: 'prepare_sql_investigation', arguments: staticArguments });
      const evidence = measureTargetDiscoveryWorkflows({ analysis, discovery, highLevelPreparation, scenarioId: 'duplicate-output-name' });
      recordedEvidence.push(evidence);

      expect(highLevelPreparation.structuredContent).toMatchObject({
        discovery: discovery.structuredContent,
        selection: { ambiguityCount: 1, reason: 'no_selectable_targets', selectableTargetIds: [] },
        status: 'selection_required',
      });
      expect(highLevelPreparation.structuredContent).not.toHaveProperty('plan');
      expect(evidence).toMatchObject({
        ambiguityHandling: 'explicit_before_planning',
        composable: { callCount: 2, completed: false, errorLocalization: 'none' },
        highLevel: { callCount: 1, completed: false, errorLocalization: 'none' },
        realLlmToolSelection: 'UNCONFIRMED',
      });
    } finally {
      await client.close();
    }
  });

  it('localizes invalid unknown-target input at the failing workflow boundary', async () => {
    const client = await connectClient();
    try {
      const invalidArguments = { sql: 'SELECT 1', sqlPath: 'query.sql' };
      const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: invalidArguments });
      const highLevelPreparation = await client.callTool({ name: 'prepare_sql_investigation', arguments: invalidArguments });
      expect(analysis.isError).toBe(true);
      expect(highLevelPreparation.isError).toBe(true);

      const evidence = measureTargetDiscoveryWorkflows({ analysis, highLevelPreparation, scenarioId: 'conflicting-sql-source' });
      recordedEvidence.push(evidence);
      expect(evidence).toMatchObject({
        composable: { callCount: 1, completed: false, errorLocalization: 'analysis', selectionOutcome: 'failed' },
        highLevel: { callCount: 1, completed: false, errorLocalization: 'preparation', selectionOutcome: 'failed' },
      });
      expect(evidence.composable.intermediateJsonBytes).toBe(0);
      expect(evidence.highLevel.intermediateJsonBytes).toBe(0);
    } finally {
      await client.close();
    }
  });
});

function copyScenario(id: string): void {
  const destination = resolve(workspace, id);
  mkdirSync(destination, { recursive: true });
  const source = resolve(process.cwd(), 'tests', 'scenarios', id);
  writeFileSync(resolve(destination, 'query.sql'), readFileSync(resolve(source, 'query.sql')));
  writeFileSync(resolve(destination, 'schema.sql'), readFileSync(resolve(source, 'schema.sql')));
}

function selectableTargetIds(value: unknown): string[] {
  return (value as { targets: Array<{ id: string; selection: { status: string } }> }).targets
    .filter((target) => target.selection.status === 'selectable')
    .map((target) => target.id);
}

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
