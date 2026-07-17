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
const opaqueBinding = 'opaque-binding-sentinel';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('create_investigation_plan MCP adapter', () => {
  it.each(['value_too_high', 'value_too_low', 'value_missing', 'missing_rows', 'duplicate_rows'])('accepts the public symptom %s', (symptom) => {
    const input = normalizeCreateInvestigationPlanInput(temporaryWorkspace(), { sql: 'select status from orders', symptom, targetColumn: 'status' });
    expect(input.symptom).toBe(symptom);
  });

  it.each(['logic_review', 'all_signals', 'unknown'])('rejects non-public MCP symptom %s', (symptom) => {
    expect(() => normalizeCreateInvestigationPlanInput(temporaryWorkspace(), { sql: 'select status from orders', symptom, targetColumn: 'status' }))
      .toThrow(expect.objectContaining({ code: 'SYMPTOM_INVALID' }));
  });

  it('rejects unsupported public contract versions with a stable code', () => {
    expect(() => normalizeCreateInvestigationPlanInput(temporaryWorkspace(), {
      contractVersion: 2,
      sql: 'select status from orders',
      targetColumn: 'status',
    })).toThrow(expect.objectContaining({ code: 'CONTRACT_VERSION_UNSUPPORTED' }));
  });

  it('leaves the Core symptom default available when MCP symptom is omitted', () => {
    const input = normalizeCreateInvestigationPlanInput(temporaryWorkspace(), { sql: 'select status from orders', targetColumn: 'status' });
    expect(input.symptom).toBeUndefined();
    expect(createInvestigationPlan(input).target.symptom).toBe('logic_review');
  });

  it('round-trips a discovery target id through the same Core plan target', () => {
    const workspace = temporaryWorkspace();
    const request = { sql: 'select status from orders', targetId: 'target:001' };
    const input = normalizeCreateInvestigationPlanInput(workspace, request);

    expect(input.target).toEqual({ columnName: 'status', nodeId: 'main_output' });
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, targetColumn: 'status' }))
      .toThrow(expect.objectContaining({ code: 'TARGET_INPUT_CONFLICT' }));
  });

  it('normalizes approved parameter maps, inline DDL strings, target defaults, and duplicate file paths', () => {
    const workspace = temporaryWorkspace();
    writeFileSync(resolve(workspace, 'query.sql'), 'select status from orders where status = :status');
    mkdirSync(resolve(workspace, 'ddl'));
    writeFileSync(resolve(workspace, 'ddl', 'schema.sql'), 'create table orders (status text);');
    writeFileSync(resolve(workspace, 'parameters.json'), JSON.stringify({
      bindings: { status: opaqueBinding },
      definitions: [{ name: 'status', origin: 'original_query_parameter' }],
    }));

    const inline = normalizeCreateInvestigationPlanInput(workspace, {
      ddl: 'create table orders (status text);',
      parameterBindings: { customer_id: opaqueBinding, status: opaqueBinding },
      parameterDefinitions: [
        { name: 'customer_id', origin: 'investigation_key' },
        { name: 'status', origin: 'original_query_parameter' },
      ],
      sql: 'select status from orders where status = :status',
      symptom: 'missing_rows',
      targetColumn: 'status',
    });
    const fromFiles = normalizeCreateInvestigationPlanInput(workspace, {
      ddlDirectories: ['ddl'],
      ddlFiles: ['ddl/schema.sql'],
      parameterBindings: { status: opaqueBinding },
      parameterDefinitions: [{ name: 'status', origin: 'original_query_parameter' }],
      sqlPath: 'query.sql',
      symptom: 'missing_rows',
      targetColumn: 'status',
    });

    expect(inline).toMatchObject({
      parameters: {
        bindingPresence: { providedNames: ['customer_id', 'status'] },
        definitions: [
          { name: 'customer_id', origin: 'investigation_key' },
          { name: 'status', origin: 'original_query_parameter' },
        ],
      },
      sql: fromFiles.sql,
      symptom: fromFiles.symptom,
      target: fromFiles.target,
    });
    expect(JSON.stringify(inline)).not.toContain(opaqueBinding);
    expect(JSON.stringify(inline)).not.toContain('"value"');
    expect(inline.target.nodeId).toBe('main_output');
    expect(fromFiles.ddl).toEqual([{ filePath: resolve(workspace, 'ddl', 'schema.sql'), sql: 'create table orders (status text);' }]);
    const cliPlan = createInvestigationPlanForCli([
      '--sql', resolve(workspace, 'query.sql'), '--ddl', resolve(workspace, 'ddl', 'schema.sql'), '--parameters', resolve(workspace, 'parameters.json'), '--target-node', 'main_output', '--target-column', 'status', '--symptom', 'missing_rows',
    ]);
    const mcpPlan = createInvestigationPlan(fromFiles);
    expect(mcpPlan).toEqual(cliPlan);
    expect(JSON.stringify(mcpPlan)).toBe(JSON.stringify(cliPlan));
    expect(mcpPlan.originalQuery).toEqual({ artifactKind: 'original_query', sql: fromFiles.sql });
    expect([...mcpPlan.recommendedProbes, ...mcpPlan.deferredProbes].every((probe) => probe.artifactKind === 'investigation_probe')).toBe(true);
    const concernIds = new Set(mcpPlan.candidateConcerns.map((concern) => concern.id));
    for (const probe of [...mcpPlan.recommendedProbes, ...mcpPlan.deferredProbes]) {
      expect(probe.staticSafetyEvidence).toMatchObject({ basis: 'parser_ast', confidence: 'syntax_only', statementClassification: 'select_statement', version: 1 });
      expect(probe.staticSafetyEvidence.assumptions.length).toBeGreaterThan(0);
      expect(probe.staticSafetyEvidence.executionCaveats).toContain('This static classification does not authorize execution.');
      expect(probe.interpretation).toMatchObject({ version: 1 });
      expect(probe.interpretation.expectedColumns.length).toBeGreaterThan(0);
      expect(probe.interpretation.assumptions.length).toBeGreaterThan(0);
      expect(probe.interpretation.doesNotProve.length).toBeGreaterThan(0);
      expect(probe.interpretation.observationRules.flatMap((rule) => rule.candidateConcernIds).every((id) => concernIds.has(id))).toBe(true);
    }
    const serializedPlan = JSON.stringify(mcpPlan);
    expect(serializedPlan).not.toContain('equivalent_rewrite');
    expect(serializedPlan).not.toContain('corrected_query');
    expect(serializedPlan).not.toContain('readOnly');
    expect(serializedPlan).not.toContain('rootCause');
    for (const forbiddenRuntimeField of ['actualRows', 'observedRows', 'bindingValues', 'causalVerdict', 'correctedSql']) {
      expect(serializedPlan).not.toContain(forbiddenRuntimeField);
    }
    expect(serializedPlan).not.toContain(opaqueBinding);
    expect(serializedPlan).not.toContain('"value"');
    for (const unsafeAssuranceTerm of ['safe_to_execute', 'read_only', 'side_effect_free', 'database_validated', 'executed', 'production_safe']) {
      expect(serializedPlan).not.toContain(unsafeAssuranceTerm);
    }
    expect(mcpPlan.nextEvidenceChecklist).toEqual(cliPlan.nextEvidenceChecklist);
    expect(createInvestigationPlan(fromFiles)).toEqual(mcpPlan);
    expect(() => normalizeCreateInvestigationPlanInput(workspace, {
      sql: 'select status from orders', targetColumn: 'status', parameterDefinitions: [{ name: 'customer_id', origin: 'not_an_origin' }],
    })).toThrow(expect.objectContaining({ code: 'PARAMETER_ORIGIN_INVALID' }));
    expect(() => normalizeCreateInvestigationPlanInput(workspace, {
      sql: 'select status from orders', targetColumn: 'status', parameterBindings: { missing: opaqueBinding }, parameterDefinitions: [],
    })).toThrow(expect.objectContaining({ code: 'PARAMETER_BINDING_DEFINITION_MISMATCH' }));
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
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { ...request, parameterBindings: { 'not-valid': opaqueBinding }, parameterDefinitions: [{ name: 'not-valid', origin: 'original_query_parameter' }] })).toThrow('valid SQL parameter identifier');
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { sql: `select '${'é'.repeat(1024 * 1024)}'`, targetColumn: 'status' })).toThrow(expect.objectContaining({ code: 'FILE_SIZE_LIMIT' }));
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { sql: 'select \0', targetColumn: 'status' })).toThrow(expect.objectContaining({ code: 'BINARY_FILE' }));
    expect(() => normalizeCreateInvestigationPlanInput(workspace, { sql: 'select 1', targetColumn: 'status', parameterBindings: { customer_id: opaqueBinding }, parameterDefinitions: [{ name: 'customer_id', origin: 'investigation_key' }, { name: 'customer_id', origin: 'original_query_parameter' }] })).toThrow(expect.objectContaining({ code: 'PARAMETER_NAME_COLLISION' }));
  });

  it('serves composable and high-level tools, returns structured input errors, isolates repeated calls, and does not write the workspace', async () => {
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
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'analyze_investigation_sql',
        'discover_investigation_targets',
        'prepare_sql_investigation',
        'create_investigation_plan',
      ]);
      const prepareTool = listed.tools.find((tool) => tool.name === 'prepare_sql_investigation')!;
      expect(prepareTool.description).toContain('without a pre-known target');
      expect(prepareTool.description).toContain('exactly one selectable target');
      expect(prepareTool.description).toContain('never guesses among candidates');
      expect(prepareTool.inputSchema.properties).not.toHaveProperty('parameterBindings');
      const createTool = listed.tools.find((tool) => tool.name === 'create_investigation_plan')!;
      expect(createTool.description).toContain('static SQL/DDL analysis plan only');
      expect(createTool.description).toContain('never connects to a database or executes SQL');
      expect(createTool.description).toContain('candidate concerns are unconfirmed');
      expect(createTool.description).toContain('investigation-only SELECT statements');
      expect(createTool.description).toContain('not corrected or production SQL');
      expect(createTool.description).toContain('without inventing unproven SQL');
      expect(createTool.description).toContain('DDL must be explicitly supplied');
      expect(createTool.description).toContain('never fetches database schema');
      expect(createTool.description).toContain('value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows');
      expect(createTool.description).toContain('rather than free natural-language symptoms');
      expect(createTool.description).toContain('Parameter definitions and caller-owned bindings are separate inputs');
      expect(createTool.description).toContain('never returned in the plan');
      const inputProperties = createTool.inputSchema.properties as Record<string, { description?: string }>;
      expect(Object.values(inputProperties).every((property) => typeof property.description === 'string' && property.description.length > 0)).toBe(true);
      expect(inputProperties.symptom.description).toContain('value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows');
      expect(inputProperties.symptom.description).toContain('rather than free natural-language symptoms');
      expect(inputProperties.parameterDefinitions.description).toContain('metadata only');
      expect(inputProperties.parameterBindings.description).toContain('never returned in the plan');
      expect((inputProperties.targetColumn as { type?: string }).type).toBe('string');
      expect((inputProperties.targetId as { type?: string }).type).toBe('string');
      expect((inputProperties.symptom as { enum?: string[] }).enum).toEqual(['value_too_high', 'value_too_low', 'value_missing', 'missing_rows', 'duplicate_rows']);
      expect((inputProperties.sql as { type?: string }).type).toBe('string');
      expect((inputProperties.ddlDirectories as { type?: string; items?: { type?: string } }).type).toBe('array');
      expect((inputProperties.ddlDirectories as { items?: { type?: string } }).items?.type).toBe('string');
      const parameterDefinitionItems = (inputProperties.parameterDefinitions as { items?: { properties?: { origin?: { enum?: string[] }; value?: unknown } } }).items;
      expect(parameterDefinitionItems?.properties?.origin?.enum).toEqual(['investigation_key', 'original_query_parameter', 'derived_parameter', 'environment_parameter']);
      expect(parameterDefinitionItems?.properties).not.toHaveProperty('value');

      const staticRequest = { sqlPath: 'query.sql', ddlDirectories: ['ddl'] };
      const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: staticRequest });
      const discovery = await client.callTool({ name: 'discover_investigation_targets', arguments: staticRequest });
      expect(analysis.structuredContent).toMatchObject({ analysisMode: 'original', kind: 'investigation-analysis-summary', version: 1 });
      expect(discovery.structuredContent).toMatchObject({ kind: 'investigation-target-discovery', version: 1 });
      expect((await client.callTool({ name: 'analyze_investigation_sql', arguments: staticRequest })).structuredContent).toEqual(analysis.structuredContent);
      expect((await client.callTool({ name: 'discover_investigation_targets', arguments: staticRequest })).structuredContent).toEqual(discovery.structuredContent);
      const discoveredTarget = (discovery.structuredContent as { targets: Array<{ id: string; identity: { column: { name: string }; node: { id: string } }; selection: { status: string } }> }).targets
        .find((target) => target.identity.node.id === 'main_output' && target.identity.column.name === 'status' && target.selection.status === 'selectable')!;
      const byTargetId = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { ...staticRequest, targetId: discoveredTarget.id },
      });
      expect(byTargetId.structuredContent).toMatchObject({ target: { columnName: 'status', nodeId: 'main_output' } });
      const preparedSingle = await client.callTool({ name: 'prepare_sql_investigation', arguments: staticRequest });
      expect(preparedSingle.structuredContent).toMatchObject({
        discovery: { kind: 'investigation-target-discovery' },
        kind: 'sql-investigation-preparation',
        plan: { kind: 'investigation-plan', target: { columnName: 'status', nodeId: 'main_output' } },
        selection: { mode: 'single_selectable_target', targetId: discoveredTarget.id },
        status: 'plan_created',
        version: 1,
      });
      expect((preparedSingle.structuredContent as { plan: unknown }).plan).toEqual(byTargetId.structuredContent);
      const preparedMultiple = await client.callTool({
        name: 'prepare_sql_investigation',
        arguments: { sql: 'SELECT customer_id, status FROM orders' },
      });
      expect(preparedMultiple.structuredContent).toMatchObject({
        kind: 'sql-investigation-preparation',
        selection: { ambiguityCount: 0, reason: 'multiple_selectable_targets', selectableTargetIds: ['target:001', 'target:002'] },
        status: 'selection_required',
      });
      expect(preparedMultiple.structuredContent).not.toHaveProperty('plan');
      const preparedExplicit = await client.callTool({
        name: 'prepare_sql_investigation',
        arguments: { sql: 'SELECT customer_id, status FROM orders', targetId: 'target:002' },
      });
      expect(preparedExplicit.structuredContent).toMatchObject({
        plan: { target: { columnName: 'status', nodeId: 'main_output' } },
        selection: { mode: 'explicit_target', targetId: 'target:002' },
        status: 'plan_created',
      });
      const unknownTarget = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { ...staticRequest, targetId: 'target:999' },
      });
      expect(unknownTarget.isError).toBe(true);
      expect(JSON.parse((unknownTarget.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'TARGET_NOT_FOUND', kind: 'invalid_input' });

      const duplicateDiscovery = await client.callTool({
        name: 'discover_investigation_targets',
        arguments: { sql: 'SELECT 1 AS repeated, 2 AS repeated' },
      });
      const preparedDuplicate = await client.callTool({
        name: 'prepare_sql_investigation',
        arguments: { sql: 'SELECT 1 AS repeated, 2 AS repeated' },
      });
      expect(preparedDuplicate.structuredContent).toMatchObject({
        selection: { ambiguityCount: 1, reason: 'no_selectable_targets', selectableTargetIds: [] },
        status: 'selection_required',
      });
      expect(preparedDuplicate.structuredContent).not.toHaveProperty('plan');
      const ambiguousTargetId = (duplicateDiscovery.structuredContent as { targets: Array<{ id: string; selection: { status: string } }> }).targets
        .find((target) => target.selection.status === 'ambiguous')!.id;
      const ambiguousTarget = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { sql: 'SELECT 1 AS repeated, 2 AS repeated', targetId: ambiguousTargetId },
      });
      expect(ambiguousTarget.isError).toBe(true);
      expect(JSON.parse((ambiguousTarget.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'TARGET_AMBIGUOUS', kind: 'invalid_input' });

      const unresolvedSql = 'SELECT value FROM table_a JOIN table_b ON a.table_a_id = b.table_a_id';
      const unresolvedDiscovery = await client.callTool({ name: 'discover_investigation_targets', arguments: { sql: unresolvedSql } });
      const unresolvedTarget = (unresolvedDiscovery.structuredContent as { targets: Array<{ id: string; selection: { status: string; unsupportedCode?: string } }> }).targets[0];
      expect(unresolvedTarget).toMatchObject({
        selection: { status: 'unsupported', unsupportedCode: 'unresolved_output_reference' },
      });
      expect(unresolvedDiscovery.structuredContent).toMatchObject({
        unsupported: [expect.objectContaining({ code: 'unresolved_output_reference', targetIds: [unresolvedTarget.id] })],
      });
      const unresolvedByTargetId = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { sql: unresolvedSql, targetId: unresolvedTarget.id },
      });
      expect(unresolvedByTargetId.isError).toBe(true);
      expect(JSON.parse((unresolvedByTargetId.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'TARGET_UNSUPPORTED', kind: 'invalid_input' });
      const unresolvedPreparation = await client.callTool({ name: 'prepare_sql_investigation', arguments: { sql: unresolvedSql } });
      expect(unresolvedPreparation.structuredContent).toMatchObject({
        selection: { reason: 'no_selectable_targets', selectableTargetIds: [], unsupportedIssueCount: 1 },
        status: 'selection_required',
      });
      expect(unresolvedPreparation.structuredContent).not.toHaveProperty('plan');
      for (const explicitTarget of [{ targetId: unresolvedTarget.id }, { targetColumn: 'value' }]) {
        const explicitPreparation = await client.callTool({
          name: 'prepare_sql_investigation',
          arguments: { sql: unresolvedSql, ...explicitTarget },
        });
        expect(explicitPreparation.isError).toBe(true);
        expect(JSON.parse((explicitPreparation.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'TARGET_UNSUPPORTED', kind: 'invalid_input' });
      }
      const compatibleExplicitColumn = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { sql: unresolvedSql, targetColumn: 'value' },
      });
      expect(compatibleExplicitColumn.structuredContent).toMatchObject({
        kind: 'investigation-plan',
        target: { columnName: 'value', nodeId: 'main_output' },
      });

      const request = { sqlPath: 'query.sql', targetColumn: 'status', targetNode: 'main_output' };
      const first = await client.callTool({ name: 'create_investigation_plan', arguments: request });
      const second = await client.callTool({ name: 'create_investigation_plan', arguments: request });
      expect(first.structuredContent).toEqual(second.structuredContent);
      expect(first.structuredContent).toMatchObject({
        kind: 'investigation-plan',
        nextEvidenceChecklist: expect.arrayContaining([expect.objectContaining({ kind: 'condition', status: 'to_verify' })]),
        originalQuery: { artifactKind: 'original_query', sql: 'select status from orders where status = :status' },
        probePrerequisiteFacts: { kind: 'probe-prerequisite-facts', version: 1 },
        target: { columnName: 'status', nodeId: 'main_output' },
      });
      type StructuredProbe = { artifactKind: string; interpretation: { assumptions: string[]; doesNotProve: string[]; expectedColumns: unknown[]; nextEvidence: string[]; observationRules: Array<{ candidateConcernIds: string[]; outcome: string }>; version: number }; staticSafetyEvidence: { assumptions: string[]; executionCaveats: string[]; statementClassification: string } };
      const firstPlan = first.structuredContent as { deferredProbes: StructuredProbe[]; recommendedProbes: StructuredProbe[] };
      expect([...firstPlan.recommendedProbes, ...firstPlan.deferredProbes].every((probe) => probe.artifactKind === 'investigation_probe')).toBe(true);
      for (const probe of [...firstPlan.recommendedProbes, ...firstPlan.deferredProbes]) {
        expect(probe.staticSafetyEvidence.statementClassification).toBe('select_statement');
        expect(probe.staticSafetyEvidence.assumptions.length).toBeGreaterThan(0);
        expect(probe.staticSafetyEvidence.executionCaveats.length).toBeGreaterThan(0);
        expect(probe.interpretation.version).toBe(1);
        expect(probe.interpretation.expectedColumns.length).toBeGreaterThan(0);
        expect(probe.interpretation.assumptions.length).toBeGreaterThan(0);
        expect(probe.interpretation.doesNotProve.length).toBeGreaterThan(0);
        expect(probe.interpretation.nextEvidence.length).toBeGreaterThan(0);
      }
      const serializedStructuredContent = JSON.stringify(first.structuredContent);
      expect(serializedStructuredContent).not.toContain('equivalent_rewrite');
      expect(serializedStructuredContent).not.toContain('corrected_query');
      expect(serializedStructuredContent).not.toContain('readOnly');
      expect(serializedStructuredContent).not.toContain('rootCause');
      for (const forbiddenRuntimeField of ['actualRows', 'observedRows', 'bindingValues', 'causalVerdict', 'correctedSql']) {
        expect(serializedStructuredContent).not.toContain(forbiddenRuntimeField);
      }

      const invalid = await client.callTool({ name: 'create_investigation_plan', arguments: { sql: 'select 1', sqlPath: 'query.sql', targetColumn: 'x', targetNode: 'main_output' } });
      expect(invalid.isError).toBe(true);
      expect(JSON.parse((invalid.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'SQL_SOURCE_REQUIRED', kind: 'invalid_input' });

      const mapAndDefault = await client.callTool({
        name: 'create_investigation_plan',
        arguments: {
          ddl: 'create table orders (status text);',
          parameterBindings: { customer_id: opaqueBinding, status: opaqueBinding },
          parameterDefinitions: [
            { name: 'customer_id', origin: 'investigation_key' },
            { name: 'status', origin: 'original_query_parameter' },
          ],
          sql: 'select status from orders where status = :status',
          targetColumn: 'status',
        },
      });
      expect(mapAndDefault.structuredContent).toMatchObject({
        parameters: [
          { name: 'customer_id', origin: 'investigation_key', status: 'provided' },
          { name: 'status', origin: 'original_query_parameter', status: 'provided' },
        ],
        target: { nodeId: 'main_output' },
      });
      expect(JSON.stringify(mapAndDefault)).not.toContain(opaqueBinding);
      expect(JSON.stringify(mapAndDefault.structuredContent)).not.toContain('"value"');

      const duplicateDdl = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { ddlDirectories: ['ddl'], ddlFiles: ['ddl/schema.sql'], sql: 'select status from orders', targetColumn: 'status' },
      });
      expect(duplicateDdl.isError).not.toBe(true);
      expect(duplicateDdl.structuredContent).toMatchObject({ kind: 'investigation-plan', target: { nodeId: 'main_output' } });

      const duplicateParameter = await client.callTool({
        name: 'create_investigation_plan',
        arguments: {
          parameterBindings: { customer_id: opaqueBinding },
          parameterDefinitions: [
            { name: 'customer_id', origin: 'investigation_key' },
            { name: 'customer_id', origin: 'original_query_parameter' },
          ],
          sql: 'select status from orders',
          targetColumn: 'status',
        },
      });
      expect(duplicateParameter.isError).toBe(true);
      expect(JSON.parse((duplicateParameter.content as Array<{ text: string }>)[0].text)).toMatchObject({ code: 'PARAMETER_NAME_COLLISION', kind: 'invalid_input' });
      expect(JSON.stringify(duplicateParameter)).not.toContain(opaqueBinding);

      const unsupportedVersion = await client.callTool({
        name: 'create_investigation_plan',
        arguments: { contractVersion: 2, sql: 'select status from orders', targetColumn: 'status' },
      });
      expect(unsupportedVersion.isError).toBe(true);
      expect(JSON.parse((unsupportedVersion.content as Array<{ text: string }>)[0].text)).toEqual({
        code: 'CONTRACT_VERSION_UNSUPPORTED',
        kind: 'invalid_input',
        message: 'Unsupported contract version. Expected 1.',
        version: 1,
      });
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
