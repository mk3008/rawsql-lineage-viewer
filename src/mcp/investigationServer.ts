#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createInvestigationPlan, InvestigationPlanInputError, investigationInputParameterOrigins, type InvestigationInputParameterOriginV1, type InvestigationPlanInputV1, type InvestigationPlannerParameterInputV1 } from '../lineage/investigationPlan';
import { diagnosticProblemIntents, problemIntentOptions, type ProblemIntent } from '../lineage/problemIntent';
import type { DdlInput, SchemaFacts } from '../lineage/schemaFacts';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const MAX_DIRECTORY_DEPTH = 8;
const MAX_DDL_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_TARGET_NODE = 'main_output';
const SQL_PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const parameterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const parameterObjectFields = {
  name: z.string().min(1),
  required: z.boolean().optional(),
  typeHint: z.string().optional(),
  value: parameterValueSchema.optional(),
};
const investigationKeyParameterInputSchema = z.union([
  z.record(z.string(), parameterValueSchema),
  z.array(z.object({ ...parameterObjectFields, origin: z.literal('investigation_key').optional() })),
]);
const knownParameterInputSchema = z.union([
  z.record(z.string(), parameterValueSchema),
  z.array(z.object({ ...parameterObjectFields, origin: z.literal('original_query_parameter').optional() })),
]);

export interface CreateInvestigationPlanMcpInput {
  sql?: unknown;
  sqlPath?: unknown;
  ddl?: unknown;
  ddlFiles?: unknown;
  ddlDirectories?: unknown;
  schemaFactsPath?: unknown;
  /** Defaults deterministically to main_output when omitted. */
  targetNode?: unknown;
  targetColumn?: unknown;
  symptom?: unknown;
  investigationKeys?: unknown;
  knownParameters?: unknown;
}

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
  const workspaceRoot = workspaceRealpath(workspace);
  const input = value as Record<string, unknown>;
  const hasSql = input.sql !== undefined;
  const hasSqlPath = input.sqlPath !== undefined;
  if (hasSql === hasSqlPath) {
    throw new McpInputError('SQL_SOURCE_REQUIRED', 'Provide exactly one of sql or sqlPath.');
  }
  const sql = hasSql
    ? validateInlineSql(requiredNonEmptyString(input.sql, 'sql'), 'sql')
    : readWorkspaceText(workspaceRoot, requiredNonEmptyString(input.sqlPath, 'sqlPath'));
  const targetNode = input.targetNode === undefined ? DEFAULT_TARGET_NODE : requiredNonEmptyString(input.targetNode, 'targetNode');
  const targetColumn = requiredNonEmptyString(input.targetColumn, 'targetColumn');
  const symptom = input.symptom === undefined ? undefined : parseSymptom(input.symptom);

  const hasSchemaFacts = input.schemaFactsPath !== undefined;
  const hasDdl = input.ddl !== undefined || input.ddlFiles !== undefined || input.ddlDirectories !== undefined;
  if (hasSchemaFacts && hasDdl) {
    throw new McpInputError('SCHEMA_INPUT_CONFLICT', 'schemaFactsPath cannot be combined with ddl, ddlFiles, or ddlDirectories.');
  }

  const ddl = hasDdl ? loadDdlInputs(workspaceRoot, input) : [];
  const schemaFacts = hasSchemaFacts
    ? parseSchemaFacts(readWorkspaceText(workspaceRoot, requiredNonEmptyString(input.schemaFactsPath, 'schemaFactsPath')))
    : undefined;
  const parameters = normalizeParameters(input.investigationKeys, input.knownParameters);

  return {
    ...(ddl.length > 0 ? { ddl } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(schemaFacts ? { schemaFacts } : {}),
    sql,
    ...(symptom ? { symptom } : {}),
    target: { columnName: targetColumn, nodeId: targetNode },
  };
}

export function createInvestigationMcpServer(workspace: string): McpServer {
  const workspaceRoot = workspaceRealpath(workspace);
  const server = new McpServer({ name: 'rawsql-lineage-investigation', version: '1.0.0' });
  server.registerTool(
    'create_investigation_plan',
    {
      description: 'Create a static SQL/DDL analysis plan only. It never connects to a database or executes SQL, and it does not determine a root cause: candidate concerns are unconfirmed. Recommended probes are investigation-only SELECT statements, not corrected or production SQL; when blocked, the plan reports the block without inventing unproven SQL. DDL must be explicitly supplied inline or from the workspace; the tool never fetches database schema. Use the normalized symptom values value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows rather than free natural-language symptoms. Record-specific investigation may require explicit investigationKeys name/value pairs (for example, {customer_id: 10}); ask for the key name and value instead of inferring a key from DDL, primary-key status, or columns. targetNode defaults to main_output.',
      inputSchema: {
        ddl: z.union([z.string().min(1), z.array(z.string().min(1))]).optional().describe('Optional inline DDL. Supply DDL explicitly when needed; the tool never fetches database schema.'),
        ddlDirectories: z.array(z.string().min(1)).optional().describe('Optional workspace-relative DDL directories to read; cannot be combined with schemaFactsPath.'),
        ddlFiles: z.array(z.string().min(1)).optional().describe('Optional workspace-relative DDL files to read; cannot be combined with schemaFactsPath.'),
        investigationKeys: investigationKeyParameterInputSchema.optional().describe('Optional explicit record-specific key name/value map, for example {customer_id: 10}. When a record-specific investigation needs a key, ask for its name and value; never infer it from DDL, primary-key status, or columns.'),
        knownParameters: knownParameterInputSchema.optional().describe('Optional known original-query parameter name/value map.'),
        schemaFactsPath: z.string().min(1).optional().describe('Optional workspace-relative schema-facts file; cannot be combined with ddl, ddlFiles, or ddlDirectories.'),
        sql: z.string().min(1).optional().describe('SQL text to analyze. Provide exactly one of sql or sqlPath.'),
        sqlPath: z.string().min(1).optional().describe('Workspace-relative SQL file to analyze. Provide exactly one of sql or sqlPath.'),
        symptom: z.enum(diagnosticProblemIntents).optional().describe('Optional normalized symptom. Use value_too_high, value_too_low, value_missing, missing_rows, or duplicate_rows rather than free natural-language symptoms.'),
        targetColumn: z.string().min(1).describe('Target output column name to investigate.'),
        targetNode: z.string().min(1).optional().describe('Optional target node id; defaults to main_output.'),
      },
    },
    async (request) => {
      try {
        const plan = createInvestigationPlan(normalizeCreateInvestigationPlanInput(workspaceRoot, request));
        return { content: [{ type: 'text', text: JSON.stringify(plan) }], structuredContent: plan as unknown as Record<string, unknown> };
      } catch (error) {
        if (error instanceof McpInputError) {
          return { content: [{ type: 'text', text: JSON.stringify({ code: error.code, kind: 'invalid_input', message: error.message }) }], isError: true };
        }
        if (error instanceof InvestigationPlanInputError) {
          return { content: [{ type: 'text', text: JSON.stringify({ code: error.code, kind: 'invalid_input', message: error.message }) }], isError: true };
        }
        throw error;
      }
    },
  );
  return server;
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

function normalizeParameters(investigationKeys: unknown, knownParameters: unknown): InvestigationPlannerParameterInputV1[] {
  const keys = optionalParameters(investigationKeys, 'investigationKeys', 'investigation_key');
  const known = optionalParameters(knownParameters, 'knownParameters', 'original_query_parameter');
  const names = new Set<string>();
  for (const parameter of [...keys, ...known]) {
    if (names.has(parameter.name)) throw new McpInputError('PARAMETER_NAME_COLLISION', 'Parameter names must not appear in both investigationKeys and knownParameters or more than once.');
    names.add(parameter.name);
  }
  return [...keys, ...known];
}

function optionalParameters(
  value: unknown,
  field: string,
  mapOrigin: InvestigationInputParameterOriginV1,
): InvestigationPlannerParameterInputV1[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((item, index) => parameterFromObject(item, `${field}[${index}]`, mapOrigin));
  if (!value || typeof value !== 'object') throw new McpInputError('PARAMETERS_INVALID', `${field} must be a parameter map or array.`);
  return Object.entries(value as Record<string, unknown>).map(([name, parameterValue]) => {
    validateParameterName(name, `${field} key`);
    validateParameterValue(parameterValue, `${field}.${name}`);
    return { name, origin: mapOrigin, value: parameterValue as boolean | number | string | null };
  });
}

function parameterFromObject(item: unknown, field: string, defaultOrigin: InvestigationInputParameterOriginV1): InvestigationPlannerParameterInputV1 {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new McpInputError('PARAMETERS_INVALID', `${field} must be an object.`);
    const parameter = item as Record<string, unknown>;
    const name = requiredNonEmptyString(parameter.name, `${field}.name`);
    validateParameterName(name, `${field}.name`);
    const origin = parameter.origin === undefined ? defaultOrigin : parameter.origin;
    if (!investigationInputParameterOrigins.includes(origin as InvestigationInputParameterOriginV1)) {
      throw new McpInputError('PARAMETER_ORIGIN_INVALID', `${field}.origin is invalid.`);
    }
    if (origin !== defaultOrigin) {
      throw new McpInputError('PARAMETER_ORIGIN_MISMATCH', `${field}.origin must be ${defaultOrigin}.`);
    }
    if (parameter.required !== undefined && typeof parameter.required !== 'boolean') throw new McpInputError('PARAMETERS_INVALID', `${field}.required must be boolean.`);
    if (parameter.typeHint !== undefined && typeof parameter.typeHint !== 'string') throw new McpInputError('PARAMETERS_INVALID', `${field}.typeHint must be a string.`);
    if (Object.prototype.hasOwnProperty.call(parameter, 'value')) validateParameterValue(parameter.value, `${field}.value`);
    return {
      name,
      origin: defaultOrigin,
      ...(parameter.required !== undefined ? { required: parameter.required as boolean } : {}),
      ...(parameter.typeHint !== undefined ? { typeHint: parameter.typeHint as string } : {}),
      ...(Object.prototype.hasOwnProperty.call(parameter, 'value') ? { value: parameter.value as boolean | number | string | null } : {}),
    };
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
  if (!problemIntentOptions.includes(symptom as ProblemIntent)) throw new McpInputError('SYMPTOM_INVALID', `Unknown symptom: ${symptom}.`);
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

async function main(): Promise<void> {
  const server = createInvestigationMcpServer(parseWorkspaceArgument(process.argv.slice(2)));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
