#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createInvestigationPlan, InvestigationPlanInputError, investigationInputParameterOrigins, type InvestigationInputParameterOriginV1, type InvestigationParameterDefinitionInputV1, type InvestigationPlanInputV1, type InvestigationPlannerParametersV1 } from '../lineage/investigationPlan';
import { discoverInvestigationTargets, InvestigationTargetSelectionError, resolveInvestigationTarget, type InvestigationTargetDiscoveryInputV1 } from '../lineage/investigationTargetDiscovery';
import { diagnosticProblemIntents, type ProblemIntent } from '../lineage/problemIntent';
import type { DdlInput, SchemaFacts } from '../lineage/schemaFacts';
import { FixtureExtractionInputError, type FixtureExtractionInput } from '../lineage/fixture-extraction/fixtureExtractionPlan';
import { generateFixtureExtractionPlan } from '../lineage/fixture-extraction/generateFixtureExtractionPlan';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const MAX_DIRECTORY_DEPTH = 8;
const MAX_DDL_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_TARGET_NODE = 'main_output';
const SQL_PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const parameterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const parameterDefinitionFields = {
  name: z.string().min(1),
  origin: z.enum(investigationInputParameterOrigins),
  required: z.boolean().optional(),
  typeHint: z.string().optional(),
};
const parameterDefinitionsInputSchema = z.array(z.object(parameterDefinitionFields).strict());
const parameterBindingsInputSchema = z.record(z.string(), parameterValueSchema);
const staticAnalysisInputSchema = {
  contractVersion: z.number().int().optional().describe('Optional public contract version; version 1 is the only supported value.'),
  ddl: z.union([z.string().min(1), z.array(z.string().min(1))]).optional().describe('Optional inline DDL. Supply DDL explicitly when needed; the tool never fetches database schema.'),
  ddlDirectories: z.array(z.string().min(1)).optional().describe('Optional workspace-relative DDL directories to read; cannot be combined with schemaFactsPath.'),
  ddlFiles: z.array(z.string().min(1)).optional().describe('Optional workspace-relative DDL files to read; cannot be combined with schemaFactsPath.'),
  schemaFactsPath: z.string().min(1).optional().describe('Optional workspace-relative schema-facts file; cannot be combined with ddl, ddlFiles, or ddlDirectories.'),
  sql: z.string().min(1).optional().describe('SQL text to analyze. Provide exactly one of sql or sqlPath.'),
  sqlPath: z.string().min(1).optional().describe('Workspace-relative SQL file to analyze. Provide exactly one of sql or sqlPath.'),
};

export interface CreateInvestigationPlanMcpInput {
  contractVersion?: unknown;
  sql?: unknown;
  sqlPath?: unknown;
  ddl?: unknown;
  ddlFiles?: unknown;
  ddlDirectories?: unknown;
  schemaFactsPath?: unknown;
  /** Defaults deterministically to main_output when omitted. */
  targetNode?: unknown;
  targetColumn?: unknown;
  targetId?: unknown;
  symptom?: unknown;
  parameterBindings?: unknown;
  parameterDefinitions?: unknown;
}

export type InvestigationStaticAnalysisMcpInput = Omit<CreateInvestigationPlanMcpInput,
  'parameterBindings' | 'parameterDefinitions' | 'symptom' | 'targetColumn' | 'targetId' | 'targetNode'>;

/** Value-free request for the experimental static fixture-capture planner. */
export interface CreateFixtureExtractionPlanMcpInput extends InvestigationStaticAnalysisMcpInput {
  reproductionKey?: unknown;
}

const fixtureReproductionKeySchema = z.object({
  parameterNames: z.array(z.string()).optional().describe('SQL parameter names only; never supply parameter values.'),
  rootColumns: z.array(z.string()).optional().describe('Optional root-relation columns matched by the reproduction-key parameters.'),
  rootRelation: z.string().optional().describe('Optional root physical relation used to bound capture SELECT steps.'),
}).catchall(z.unknown()).describe('Explicit value-free reproduction-key metadata. Binding values and row values are forbidden.');
const fixtureExtractionInputSchema = z.object({
  ...staticAnalysisInputSchema,
  reproductionKey: fixtureReproductionKeySchema.describe('Required explicit reproduction-key metadata. It may contain parameterNames, rootRelation, and rootColumns only; all parameter or row values are forbidden.'),
}).passthrough();
const fixtureInputAllowedKeys = new Set([...Object.keys(staticAnalysisInputSchema), 'reproductionKey']);
const fixtureInputValueBearingKeys = new Set(['binding', 'bindings', 'bindingValue', 'bindingValues', 'parameterBindings', 'providedValues', 'value', 'values']);

export type PrepareSqlInvestigationMcpInput = InvestigationStaticAnalysisMcpInput & {
  symptom?: unknown;
  targetColumn?: unknown;
  targetId?: unknown;
  targetNode?: unknown;
};

export type PrepareSqlInvestigationResultV1 =
  | {
      discovery: ReturnType<typeof discoverInvestigationTargets>;
      kind: 'sql-investigation-preparation';
      plan: ReturnType<typeof createInvestigationPlan>;
      selection: { mode: 'explicit_target' | 'single_selectable_target'; targetId?: string };
      status: 'plan_created';
      version: 1;
    }
  | {
      discovery: ReturnType<typeof discoverInvestigationTargets>;
      kind: 'sql-investigation-preparation';
      selection: {
        ambiguityCount: number;
        reason: 'multiple_selectable_targets' | 'no_selectable_targets';
        selectableTargetIds: string[];
        unsupportedIssueCount: number;
      };
      status: 'selection_required';
      version: 1;
    };

export class McpInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpInputError';
    this.code = code;
  }
}

/** Converts a workspace-confined MCP request into the unchanged Planner input; absent targetNode means main_output. */
export function normalizeCreateInvestigationPlanInput(
  workspace: string,
  value: CreateInvestigationPlanMcpInput,
): InvestigationPlanInputV1 {
  const input = value as Record<string, unknown>;
  validateContractVersion(input.contractVersion);
  const staticInput = normalizeInvestigationStaticAnalysisInput(workspace, value);
  const hasTargetId = input.targetId !== undefined;
  const hasExplicitTarget = input.targetColumn !== undefined || input.targetNode !== undefined;
  if (hasTargetId && hasExplicitTarget) {
    throw new McpInputError('TARGET_INPUT_CONFLICT', 'targetId cannot be combined with targetColumn or targetNode.');
  }
  const target = hasTargetId
    ? resolveInvestigationTarget(discoverInvestigationTargets(staticInput), requiredNonEmptyString(input.targetId, 'targetId'))
    : {
        columnName: requiredNonEmptyString(input.targetColumn, 'targetColumn'),
        nodeId: input.targetNode === undefined ? DEFAULT_TARGET_NODE : requiredNonEmptyString(input.targetNode, 'targetNode'),
      };
  const symptom = input.symptom === undefined ? undefined : parseSymptom(input.symptom);
  const parameters = normalizeParameters(input.parameterDefinitions, input.parameterBindings);

  return {
    ...staticInput,
    ...(parameters ? { parameters } : {}),
    ...(symptom ? { symptom } : {}),
    target,
  };
}

export function normalizeInvestigationStaticAnalysisInput(
  workspace: string,
  value: InvestigationStaticAnalysisMcpInput,
): InvestigationTargetDiscoveryInputV1 {
  const workspaceRoot = workspaceRealpath(workspace);
  const input = value as Record<string, unknown>;
  validateContractVersion(input.contractVersion);
  const hasSql = input.sql !== undefined;
  const hasSqlPath = input.sqlPath !== undefined;
  if (hasSql === hasSqlPath) {
    throw new McpInputError('SQL_SOURCE_REQUIRED', 'Provide exactly one of sql or sqlPath.');
  }
  const sql = hasSql
    ? validateInlineSql(requiredNonEmptyString(input.sql, 'sql'), 'sql')
    : readWorkspaceText(workspaceRoot, requiredNonEmptyString(input.sqlPath, 'sqlPath'));
  const hasSchemaFacts = input.schemaFactsPath !== undefined;
  const hasDdl = input.ddl !== undefined || input.ddlFiles !== undefined || input.ddlDirectories !== undefined;
  if (hasSchemaFacts && hasDdl) {
    throw new McpInputError('SCHEMA_INPUT_CONFLICT', 'schemaFactsPath cannot be combined with ddl, ddlFiles, or ddlDirectories.');
  }
  const ddl = hasDdl ? loadDdlInputs(workspaceRoot, input) : [];
  const schemaFacts = hasSchemaFacts
    ? parseSchemaFacts(readWorkspaceText(workspaceRoot, requiredNonEmptyString(input.schemaFactsPath, 'schemaFactsPath')))
    : undefined;
  return {
    ...(ddl.length > 0 ? { ddl } : {}),
    ...(schemaFacts ? { schemaFacts } : {}),
    sql,
  };
}

/** Reuses MCP workspace confinement while keeping fixture extraction strictly value-free. */
export function normalizeCreateFixtureExtractionPlanInput(
  workspace: string,
  value: CreateFixtureExtractionPlanMcpInput,
): FixtureExtractionInput {
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (fixtureInputValueBearingKeys.has(key)) throw new FixtureExtractionInputError('VALUE_BEARING_INPUT_FORBIDDEN');
    if (!fixtureInputAllowedKeys.has(key)) throw new FixtureExtractionInputError('INPUT_SHAPE_INVALID');
  }
  const staticInput = normalizeInvestigationStaticAnalysisInput(workspace, value);
  const input: FixtureExtractionInput = {
    ...staticInput,
    reproductionKey: value.reproductionKey as FixtureExtractionInput['reproductionKey'],
  };
  return input;
}

/**
 * High-level static workflow from an unknown-target starting state. It never
 * guesses among multiple selectable targets.
 */
export function prepareSqlInvestigation(
  workspace: string,
  value: PrepareSqlInvestigationMcpInput,
): PrepareSqlInvestigationResultV1 {
  const input = value as Record<string, unknown>;
  const staticInput = normalizeInvestigationStaticAnalysisInput(workspace, value);
  const discovery = discoverInvestigationTargets(staticInput);
  const hasExplicitTarget = input.targetId !== undefined || input.targetColumn !== undefined || input.targetNode !== undefined;
  if (hasExplicitTarget) {
    const planInput = normalizeCreateInvestigationPlanInput(workspace, value);
    if (input.targetId === undefined) {
      const matches = discovery.targets.filter((target) => target.identity.node.id === planInput.target.nodeId && target.identity.column.name === planInput.target.columnName);
      if (matches.length === 0) throw new InvestigationTargetSelectionError('TARGET_NOT_FOUND');
      if (matches.length > 1) throw new InvestigationTargetSelectionError('TARGET_AMBIGUOUS');
      resolveInvestigationTarget(discovery, matches[0].id);
    }
    const plan = createInvestigationPlan(planInput);
    return {
      discovery,
      kind: 'sql-investigation-preparation',
      plan,
      selection: {
        mode: 'explicit_target',
        ...(typeof input.targetId === 'string' ? { targetId: input.targetId } : {}),
      },
      status: 'plan_created',
      version: 1,
    };
  }
  const selectable = discovery.targets.filter((target) => target.selection.status === 'selectable');
  if (selectable.length !== 1) {
    return {
      discovery,
      kind: 'sql-investigation-preparation',
      selection: {
        ambiguityCount: discovery.ambiguities.length,
        reason: selectable.length === 0 ? 'no_selectable_targets' : 'multiple_selectable_targets',
        selectableTargetIds: selectable.map((target) => target.id),
        unsupportedIssueCount: discovery.unsupported.length,
      },
      status: 'selection_required',
      version: 1,
    };
  }
  const plan = createInvestigationPlan(normalizeCreateInvestigationPlanInput(workspace, {
    ...value,
    targetId: selectable[0].id,
  }));
  return {
    discovery,
    kind: 'sql-investigation-preparation',
    plan,
    selection: { mode: 'single_selectable_target', targetId: selectable[0].id },
    status: 'plan_created',
    version: 1,
  };
}

export function createInvestigationMcpServer(workspace: string): McpServer {
  const workspaceRoot = workspaceRealpath(workspace);
  const server = new McpServer({ name: 'rawsql-lineage-investigation', version: '1.0.0' });
  server.registerTool(
    'analyze_investigation_sql',
    {
      description: 'Summarize deterministic static analysis of supplied SQL/DDL. This tool does not connect to a database, execute SQL, choose a target, or determine a root cause.',
      inputSchema: staticAnalysisInputSchema,
    },
    async (request) => {
      try {
        const result = discoverInvestigationTargets(normalizeInvestigationStaticAnalysisInput(workspaceRoot, request)).analysis;
        return mcpSuccess(result);
      } catch (error) {
        const failure = mcpFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  );
  server.registerTool(
    'discover_investigation_targets',
    {
      description: 'Discover stable static investigation target identities from supplied SQL/DDL. Ambiguous and unsupported outputs remain explicit and cannot be selected for plan creation.',
      inputSchema: staticAnalysisInputSchema,
    },
    async (request) => {
      try {
        return mcpSuccess(discoverInvestigationTargets(normalizeInvestigationStaticAnalysisInput(workspaceRoot, request)));
      } catch (error) {
        const failure = mcpFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  );
  server.registerTool(
    'prepare_sql_investigation',
    {
      description: 'Prepare a static investigation from supplied SQL/DDL without a pre-known target. The tool creates a plan only when exactly one selectable target exists or a target is explicitly supplied; otherwise it returns discovery with selection_required and never guesses among candidates. It does not connect to a database, execute SQL, inspect results, or determine a root cause.',
      inputSchema: {
        ...staticAnalysisInputSchema,
        symptom: z.enum(diagnosticProblemIntents).optional().describe('Optional normalized symptom used only if a plan can be created.'),
        targetColumn: z.string().min(1).optional().describe('Optional explicit target column; use instead of targetId.'),
        targetId: z.string().min(1).optional().describe('Optional explicit target id returned by discovery; use instead of targetColumn and targetNode.'),
        targetNode: z.string().min(1).optional().describe('Optional explicit target node used with targetColumn; defaults to main_output.'),
      },
    },
    async (request) => {
      try {
        return mcpSuccess(prepareSqlInvestigation(workspaceRoot, request));
      } catch (error) {
        const failure = mcpFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  );
  server.registerTool(
    'create_investigation_plan',
    {
      description: 'Create a static SQL/DDL analysis plan only. It never connects to a database or executes SQL, and it does not determine a root cause: candidate concerns are unconfirmed. Recommended probes are investigation-only SELECT statements, not corrected or production SQL; when blocked, the plan reports the block without inventing unproven SQL. DDL must be explicitly supplied inline or from the workspace; the tool never fetches database schema. Use the normalized symptom values value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows rather than free natural-language symptoms. Parameter definitions and caller-owned bindings are separate inputs; bindings are reduced to non-secret presence metadata and are never returned in the plan. Supply either a discovery targetId or targetColumn with optional targetNode; targetNode defaults to main_output.',
      inputSchema: {
        ...staticAnalysisInputSchema,
        parameterBindings: parameterBindingsInputSchema.optional().describe('Optional caller-owned binding map. Values are used only to mark matching definitions as provided and are never returned in the plan.'),
        parameterDefinitions: parameterDefinitionsInputSchema.optional().describe('Optional emit-safe parameter definitions with name, origin, required, and typeHint metadata only.'),
        symptom: z.enum(diagnosticProblemIntents).optional().describe('Optional normalized symptom. Use value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows rather than free natural-language symptoms.'),
        targetColumn: z.string().min(1).optional().describe('Target output column name to investigate; use instead of targetId.'),
        targetId: z.string().min(1).optional().describe('Target id returned by discover_investigation_targets; use instead of targetColumn and targetNode.'),
        targetNode: z.string().min(1).optional().describe('Optional target node id; defaults to main_output.'),
      },
    },
    async (request) => {
      try {
        return mcpSuccess(createInvestigationPlan(normalizeCreateInvestigationPlanInput(workspaceRoot, request)));
      } catch (error) {
        const failure = mcpFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  );
  server.registerTool(
    'create_fixture_extraction_plan',
    {
      description: 'Generate an experimental, static, fail-closed fixture-capture SELECT plan from SQL, explicit DDL/schema facts, and a value-free reproduction key. It never connects to a database, executes SQL, reads rows, accepts parameter values, or loads fixtures. The result is only bounded capture SELECT text or an explicit partial/blocked plan; it is not arbitrary-SQL or production migration automation.',
      inputSchema: fixtureExtractionInputSchema,
    },
    async (request) => {
      try {
        return mcpSuccess(generateFixtureExtractionPlan(normalizeCreateFixtureExtractionPlanInput(workspaceRoot, request)));
      } catch (error) {
        const failure = mcpFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  );
  return server;
}

function mcpSuccess(value: object): { content: Array<{ text: string; type: 'text' }>; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

function mcpFailure(error: unknown): { content: Array<{ text: string; type: 'text' }>; isError: true } | undefined {
  if (!(error instanceof McpInputError || error instanceof InvestigationPlanInputError || error instanceof InvestigationTargetSelectionError || error instanceof FixtureExtractionInputError)) return undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify({ code: error.code, kind: 'invalid_input', message: error.message, version: 1 }) }],
    isError: true,
  };
}

function validateContractVersion(value: unknown): void {
  if (value !== undefined && value !== 1) {
    throw new McpInputError('CONTRACT_VERSION_UNSUPPORTED', 'Unsupported contract version. Expected 1.');
  }
}

function workspaceRealpath(workspace: string): string {
  if (!workspace || !isAbsolute(workspace)) {
    throw new McpInputError('WORKSPACE_REQUIRED', 'The server requires an absolute --workspace path.');
  }
  try {
    const real = realpathSync(workspace);
    if (!statSync(real).isDirectory()) {
      throw new McpInputError('WORKSPACE_INVALID', '--workspace must name a directory.');
    }
    return real;
  } catch (error) {
    if (error instanceof McpInputError) throw error;
    throw new McpInputError('WORKSPACE_INVALID', '--workspace must name an existing directory.');
  }
}

function resolveWorkspacePath(workspace: string, suppliedPath: string, deferExcludedPathError = false): string {
  const segments = suppliedPath.split(/[\\/]+/);
  if (isAbsolute(suppliedPath) || segments.includes('..')) {
    throw new McpInputError('PATH_OUTSIDE_WORKSPACE', 'Paths must be relative to --workspace and must not contain .. segments.');
  }
  const isSuppliedExcluded = hasExcludedPathSegment(segments);
  const candidate = resolve(workspace, suppliedPath);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    if (isSuppliedExcluded && !deferExcludedPathError) {
      throw new McpInputError('PATH_EXCLUDED', `Path is inside an excluded directory: ${suppliedPath}`);
    }
    throw new McpInputError('PATH_NOT_FOUND', `Workspace path does not exist: ${suppliedPath}`);
  }
  const fromWorkspace = relative(workspace, real);
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new McpInputError('PATH_OUTSIDE_WORKSPACE', `Workspace path escapes --workspace: ${suppliedPath}`);
  }
  const isCanonicalExcluded = hasExcludedPathSegment(fromWorkspace.split(/[\\/]+/));
  if (isCanonicalExcluded && (!deferExcludedPathError || !isSuppliedExcluded)) {
    throw new McpInputError('PATH_EXCLUDED', `Path resolves inside an excluded directory: ${suppliedPath}`);
  }
  if (isSuppliedExcluded && !deferExcludedPathError) {
    throw new McpInputError('PATH_EXCLUDED', `Path is inside an excluded directory: ${suppliedPath}`);
  }
  return real;
}

function hasExcludedPathSegment(segments: string[]): boolean {
  return segments.some((segment) => EXCLUDED_DIRECTORIES.has(normalizePathSegment(segment)));
}

function normalizePathSegment(segment: string): string {
  return process.platform === 'win32' ? segment.toLowerCase() : segment;
}

function readWorkspaceText(workspace: string, suppliedPath: string): string {
  const filePath = resolveWorkspacePath(workspace, suppliedPath);
  if (!statSync(filePath).isFile()) {
    throw new McpInputError('PATH_NOT_FILE', `Expected a file: ${suppliedPath}`);
  }
  return readBoundedText(filePath);
}

function loadDdlInputs(workspace: string, input: Record<string, unknown>): DdlInput[] {
  const inlineDdl = optionalStringOrArray(input.ddl, 'ddl');
  const filePaths = optionalStringArray(input.ddlFiles, 'ddlFiles').map((path) => resolveWorkspacePath(workspace, path));
  const directoryPaths = optionalStringArray(input.ddlDirectories, 'ddlDirectories').flatMap((path) => collectDdlFiles(workspace, path));
  const allFiles = [...new Set([...directoryPaths, ...filePaths])].sort((left, right) => left.localeCompare(right));
  if (allFiles.length + inlineDdl.length > MAX_DDL_FILES) {
    throw new McpInputError('DDL_FILE_LIMIT', `At most ${MAX_DDL_FILES} DDL inputs are allowed.`);
  }
  let totalBytes = 0;
  const fromFiles = allFiles.map((filePath) => {
    if (!filePath.toLowerCase().endsWith('.sql')) throw new McpInputError('DDL_FILE_TYPE', `DDL file must end in .sql: ${filePath}`);
    const sql = readBoundedText(filePath);
    totalBytes += Buffer.byteLength(sql);
    if (totalBytes > MAX_TOTAL_BYTES) throw new McpInputError('DDL_TOTAL_SIZE', `DDL input exceeds ${MAX_TOTAL_BYTES} bytes.`);
    return { filePath, sql };
  });
  const fromInline = inlineDdl.map((sql, index) => {
    ensureTextSize(sql, `ddl[${index}]`);
    totalBytes += Buffer.byteLength(sql);
    if (totalBytes > MAX_TOTAL_BYTES) throw new McpInputError('DDL_TOTAL_SIZE', `DDL input exceeds ${MAX_TOTAL_BYTES} bytes.`);
    return { filePath: `<inline:${index + 1}>`, sql };
  });
  return [...fromFiles, ...fromInline];
}

function collectDdlFiles(workspace: string, suppliedDirectory: string): string[] {
  const root = resolveWorkspacePath(workspace, suppliedDirectory);
  if (!statSync(root).isDirectory()) throw new McpInputError('PATH_NOT_DIRECTORY', `Expected a directory: ${suppliedDirectory}`);
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DIRECTORY_DEPTH) throw new McpInputError('DDL_DIRECTORY_DEPTH', `DDL directory recursion exceeds ${MAX_DIRECTORY_DEPTH} levels.`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = resolve(directory, entry.name);
      const resolved = resolveWorkspacePath(workspace, relative(workspace, candidate), true);
      if (hasExcludedPathSegment([entry.name])) continue;
      const stat = statSync(resolved);
      if (stat.isDirectory()) visit(resolved, depth + 1);
      else if (stat.isFile() && resolved.toLowerCase().endsWith('.sql')) {
        files.push(resolved);
        if (files.length > MAX_DDL_FILES) throw new McpInputError('DDL_FILE_LIMIT', `At most ${MAX_DDL_FILES} DDL files are allowed.`);
      }
    }
  };
  visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

function readBoundedText(filePath: string): string {
  const size = statSync(filePath).size;
  if (size > MAX_FILE_BYTES) throw new McpInputError('FILE_SIZE_LIMIT', `File exceeds ${MAX_FILE_BYTES} bytes: ${filePath}`);
  const bytes = readFileSync(filePath);
  if (bytes.includes(0)) throw new McpInputError('BINARY_FILE', `Binary files are not accepted: ${filePath}`);
  return bytes.toString('utf8');
}

function normalizeParameters(definitionsValue: unknown, bindingsValue: unknown): InvestigationPlannerParametersV1 | undefined {
  const definitions = parameterDefinitions(definitionsValue);
  const bindings = parameterBindings(bindingsValue);
  if (definitions.length === 0 && bindings.length === 0) return undefined;

  const definitionNames = new Set<string>();
  for (const definition of definitions) {
    if (definitionNames.has(definition.name)) throw new McpInputError('PARAMETER_NAME_COLLISION', 'Parameter definition names must be unique.');
    definitionNames.add(definition.name);
  }
  if (bindings.some((name) => !definitionNames.has(name))) {
    throw new McpInputError('PARAMETER_BINDING_DEFINITION_MISMATCH', 'Every binding must identify exactly one parameter definition.');
  }
  return {
    definitions,
    ...(bindings.length > 0 ? { bindingPresence: { providedNames: bindings } } : {}),
  };
}

function parameterDefinitions(value: unknown): InvestigationParameterDefinitionInputV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new McpInputError('PARAMETERS_INVALID', 'parameterDefinitions must be an array.');
  return value.map((item, index) => {
    const field = `parameterDefinitions[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new McpInputError('PARAMETERS_INVALID', `${field} must be an object.`);
    const parameter = item as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(parameter, 'value')) {
      throw new McpInputError('PARAMETERS_INVALID', 'Parameter definitions must not contain binding values.');
    }
    const name = requiredNonEmptyString(parameter.name, `${field}.name`);
    validateParameterName(name, `${field}.name`);
    if (!investigationInputParameterOrigins.includes(parameter.origin as InvestigationInputParameterOriginV1)) {
      throw new McpInputError('PARAMETER_ORIGIN_INVALID', `${field}.origin is invalid.`);
    }
    if (parameter.required !== undefined && typeof parameter.required !== 'boolean') throw new McpInputError('PARAMETERS_INVALID', `${field}.required must be boolean.`);
    if (parameter.typeHint !== undefined && typeof parameter.typeHint !== 'string') throw new McpInputError('PARAMETERS_INVALID', `${field}.typeHint must be a string.`);
    return {
      name,
      origin: parameter.origin as InvestigationInputParameterOriginV1,
      ...(parameter.required !== undefined ? { required: parameter.required as boolean } : {}),
      ...(parameter.typeHint !== undefined ? { typeHint: parameter.typeHint as string } : {}),
    };
  });
}

function parameterBindings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpInputError('PARAMETERS_INVALID', 'parameterBindings must be an object keyed by parameter name.');
  return Object.entries(value as Record<string, unknown>).map(([name, binding]) => {
    validateParameterName(name, 'parameterBindings key');
    validateParameterValue(binding, 'parameterBindings value');
    return name;
  }).sort();
}

function parseSchemaFacts(text: string): SchemaFacts {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new McpInputError('SCHEMA_FACTS_INVALID', 'schemaFactsPath must contain JSON.');
  }
  if (!value || typeof value !== 'object' || !('tables' in value)) throw new McpInputError('SCHEMA_FACTS_INVALID', 'SchemaFacts JSON must contain a tables object.');
  const facts = value as Partial<SchemaFacts> & Pick<SchemaFacts, 'tables'>;
  return { ...facts, kind: 'schema-facts', tables: facts.tables, version: 1 };
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new McpInputError('INPUT_REQUIRED', `${field} must be a non-empty string.`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new McpInputError('INPUT_INVALID', `${field} must be an array of strings.`);
  return value.map((entry, index) => requiredNonEmptyString(entry, `${field}[${index}]`));
}

function optionalStringOrArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [requiredNonEmptyString(value, field)];
  return optionalStringArray(value, field);
}

function validateParameterName(name: string, field: string): void {
  if (!SQL_PARAMETER_NAME.test(name)) throw new McpInputError('PARAMETER_NAME_INVALID', `${field} must be a valid SQL parameter identifier.`);
}

function validateParameterValue(value: unknown, field: string): void {
  if (value !== null && !['boolean', 'number', 'string'].includes(typeof value)) throw new McpInputError('PARAMETERS_INVALID', `${field} must be null, boolean, number, or string.`);
}

function parseSymptom(value: unknown): ProblemIntent {
  const symptom = requiredNonEmptyString(value, 'symptom');
  if (!diagnosticProblemIntents.includes(symptom as typeof diagnosticProblemIntents[number])) {
    throw new McpInputError('SYMPTOM_INVALID', `Unknown symptom: ${symptom}. Accepted values: ${diagnosticProblemIntents.join(', ')}.`);
  }
  return symptom as ProblemIntent;
}

function ensureTextSize(text: string, field: string): void {
  if (text.includes('\0')) throw new McpInputError('BINARY_FILE', `${field} contains a NUL byte.`);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new McpInputError('FILE_SIZE_LIMIT', `${field} exceeds ${MAX_FILE_BYTES} bytes.`);
}

function validateInlineSql(text: string, field: string): string {
  ensureTextSize(text, field);
  return text;
}

function parseWorkspaceArgument(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--workspace') throw new McpInputError('WORKSPACE_REQUIRED', 'Usage: investigation-server --workspace <absolute-path>');
  return argv[1];
}

export async function runInvestigationMcpServer(): Promise<void> {
  const server = createInvestigationMcpServer(parseWorkspaceArgument(process.argv.slice(2)));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInvestigationMcpServer().catch((error: unknown) => {
    const failure = error instanceof McpInputError
      ? { code: error.code, kind: 'invalid_input', message: error.message, version: 1 }
      : { code: 'INVALID_INPUT', kind: 'invalid_input', message: error instanceof Error ? error.message : String(error), version: 1 };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  });
}
