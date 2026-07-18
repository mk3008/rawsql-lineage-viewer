#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildColumnDiagnosticPacket } from '../lineage/diagnostics';
import type { AnalysisWarning } from '../domain/lineage';
import { createInvestigationPlan, investigationInputParameterOrigins, type InvestigationParameterDefinitionInputV1, type InvestigationPlanV1, type InvestigationPlannerParametersV1 } from '../lineage/investigationPlan';
import { discoverInvestigationTargets, resolveInvestigationTarget, type InvestigationTargetDiscoveryV1 } from '../lineage/investigationTargetDiscovery';
import { diagnosticProblemIntents, problemIntentOptions, symptomEffectMap, type DiagnosticConcernEffect, type DiagnosticProblemIntent, type ProblemIntent } from '../lineage/problemIntent';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import type { DdlInput, SchemaFacts } from '../lineage/schemaFacts';
import { parseSchemaFactsFromDdl } from '../lineage/schemaFacts';

interface DiagnoseArgs {
  contractVersion?: number;
  ddl: string[];
  ddlDir: string[];
  out?: string;
  schemaFacts?: string;
  sql?: string;
  symptom?: DiagnosticProblemIntent;
  targetColumn?: string;
}

interface InvestigateArgs extends Omit<DiagnoseArgs, 'symptom' | 'targetColumn'> {
  parameters?: string;
  symptom?: ProblemIntent;
  targetColumn?: string;
  targetId?: string;
  targetNode?: string;
}

interface InvestigationCliDependencies {
  createPlan: typeof createInvestigationPlan;
  discoverTargets: typeof discoverInvestigationTargets;
  resolveTarget: typeof resolveInvestigationTarget;
}

interface SqlDiagnosticReport {
  analysisMode: 'original';
  diagnostics: AnalysisWarning[];
  kind: 'sql-diagnostic-report';
  packets: ReturnType<typeof buildColumnDiagnosticPacket>[];
  schemaFacts?: SchemaFacts;
  sourceArtifact: { artifactKind: 'original_query' };
  symptom?: {
    expectedEffects: DiagnosticConcernEffect[];
    intent: DiagnosticProblemIntent;
    unknownOrNotImplementedEffects: DiagnosticConcernEffect[];
  };
  version: 1;
}

const implementedConcernEffects = new Set<DiagnosticConcernEffect>([
  'aggregate_expression',
  'case_when',
  'exists',
  'grain_change',
  'inner_join_filter',
  'left_join',
  'missing_match',
  'null_extension',
  'null_replacement',
  'output_cap',
  'output_selection',
  'row_filter',
  'row_multiplication',
  'value_transform',
]);

const validProblemIntents = new Set<DiagnosticProblemIntent>(diagnosticProblemIntents);
const validInvestigationSymptoms = new Set<ProblemIntent>(problemIntentOptions);

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

export async function runCli(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'discover') {
    process.stdout.write(`${JSON.stringify(discoverInvestigationTargetsForCli(argv), null, 2)}\n`);
    return;
  }
  if (command === 'investigate') {
    process.stdout.write(`${JSON.stringify(createInvestigationPlanForCli(argv), null, 2)}\n`);
    return;
  }

  const args = parseArgs(command === 'diagnose' ? argv : process.argv.slice(2));
  if (!args.sql) {
    throw new Error('Missing required --sql <file> option.');
  }

  const sql = readTextFile(args.sql);
  const schemaFacts = loadSchemaFacts(args);
  const { lineage } = analyzeSql(sql, { analysisMode: 'original', optimizeConditions: false, schemaFacts });
  const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
  if (!outputNode) {
    throw new Error('Could not find the main output node.');
  }

  const outputColumns = outputNode.columns.filter((column) => column.usage?.role !== 'filter');
  const selectedColumns = args.targetColumn
    ? outputColumns.filter((column) => column.name === args.targetColumn)
    : outputColumns;
  if (args.targetColumn && selectedColumns.length === 0) {
    throw new Error(`Target column was not found in output: ${args.targetColumn}`);
  }

  const report: SqlDiagnosticReport = {
    analysisMode: 'original',
    diagnostics: lineage.analysisWarnings,
    kind: 'sql-diagnostic-report',
    packets: selectedColumns.map((column) =>
      buildColumnDiagnosticPacket(lineage, {
        columnName: column.name,
        nodeId: outputNode.id,
        scopeId: column.scopeId,
      }, { schemaFacts, symptom: args.symptom }),
    ),
    schemaFacts,
    sourceArtifact: { artifactKind: 'original_query' },
    symptom: args.symptom ? {
      expectedEffects: symptomEffectMap[args.symptom],
      intent: args.symptom,
      unknownOrNotImplementedEffects: symptomEffectMap[args.symptom].filter((effect) => !implementedConcernEffects.has(effect)),
    } : undefined,
    version: 1,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}

function parseArgs(argv: string[]): DiagnoseArgs {
  const args: DiagnoseArgs = { ddl: [], ddlDir: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${option}`);
    }
    if (option === '--ddl') {
      args.ddl.push(requireValue(option, value));
      index += 1;
    } else if (option === '--contract-version') {
      args.contractVersion = parseContractVersion(requireValue(option, value));
      index += 1;
    } else if (option === '--ddl-dir') {
      args.ddlDir.push(requireValue(option, value));
      index += 1;
    } else if (option === '--out') {
      args.out = requireValue(option, value);
      index += 1;
    } else if (option === '--schema-facts') {
      args.schemaFacts = requireValue(option, value);
      index += 1;
    } else if (option === '--sql') {
      args.sql = requireValue(option, value);
      index += 1;
    } else if (option === '--target-column') {
      args.targetColumn = requireValue(option, value);
      index += 1;
    } else if (option === '--symptom') {
      args.symptom = parseProblemIntent(requireValue(option, value));
      index += 1;
    } else if (option === '--help' || option === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return args;
}

/**
 * Creates exactly one shared investigation plan from static CLI inputs.
 * This boundary does not execute SQL or manufacture diagnostic/probe SQL.
 */
export function createInvestigationPlanForCli(
  argv: string[],
  dependencies: Partial<InvestigationCliDependencies> = {},
): InvestigationPlanV1 {
  const args = parseInvestigateArgs(argv);
  if (!args.sql) {
    throw new Error('Missing required --sql <file> option.');
  }
  const hasTargetId = args.targetId !== undefined;
  const hasDirectTarget = args.targetNode !== undefined || args.targetColumn !== undefined;
  if (hasTargetId && hasDirectTarget) throw new Error('--target-id cannot be combined with --target-node or --target-column.');
  if (!hasTargetId && (!args.targetNode || !args.targetColumn)) {
    throw new Error('Supply either --target-id <id> or both --target-node <node-id> and --target-column <column-name>.');
  }
  if (args.schemaFacts && (args.ddl.length > 0 || args.ddlDir.length > 0)) {
    throw new Error('Use either --schema-facts <file> or --ddl/--ddl-dir inputs, not both.');
  }

  const ddl = loadDdlInputs(args);
  const schemaFacts = args.schemaFacts ? normalizeLoadedSchemaFacts(JSON.parse(readTextFile(args.schemaFacts))) : undefined;
  const parameters = args.parameters ? parseParameterFile(args.parameters) : undefined;
  const staticInput = {
    ...(ddl.length > 0 ? { ddl } : {}),
    ...(schemaFacts ? { schemaFacts } : {}),
    sql: readTextFile(args.sql),
  };
  const target = args.targetId
    ? (dependencies.resolveTarget ?? resolveInvestigationTarget)((dependencies.discoverTargets ?? discoverInvestigationTargets)(staticInput), args.targetId)
    : { columnName: args.targetColumn!, nodeId: args.targetNode! };
  return (dependencies.createPlan ?? createInvestigationPlan)({
    ...staticInput,
    ...(parameters ? { parameters } : {}),
    symptom: args.symptom,
    target,
  });
}

/** Discovers deterministic investigation targets from static CLI inputs. */
export function discoverInvestigationTargetsForCli(argv: string[]): InvestigationTargetDiscoveryV1 {
  const args = parseArgs(argv);
  if (!args.sql) throw new Error('Missing required --sql <file> option.');
  if (args.out || args.symptom || args.targetColumn) throw new Error('discover accepts only --sql, --ddl, --ddl-dir, --schema-facts, and --contract-version.');
  if (args.schemaFacts && (args.ddl.length > 0 || args.ddlDir.length > 0)) {
    throw new Error('Use either --schema-facts <file> or --ddl/--ddl-dir inputs, not both.');
  }
  const ddl = loadDdlInputs(args);
  const schemaFacts = args.schemaFacts ? normalizeLoadedSchemaFacts(JSON.parse(readTextFile(args.schemaFacts))) : undefined;
  return discoverInvestigationTargets({
    ...(ddl.length > 0 ? { ddl } : {}),
    ...(schemaFacts ? { schemaFacts } : {}),
    sql: readTextFile(args.sql),
  });
}

function parseInvestigateArgs(argv: string[]): InvestigateArgs {
  const args: InvestigateArgs = { ddl: [], ddlDir: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${option}`);
    }
    if (option === '--ddl') {
      args.ddl.push(requireValue(option, value));
      index += 1;
    } else if (option === '--contract-version') {
      args.contractVersion = parseContractVersion(requireValue(option, value));
      index += 1;
    } else if (option === '--ddl-dir') {
      args.ddlDir.push(requireValue(option, value));
      index += 1;
    } else if (option === '--parameters') {
      args.parameters = requireValue(option, value);
      index += 1;
    } else if (option === '--schema-facts') {
      args.schemaFacts = requireValue(option, value);
      index += 1;
    } else if (option === '--sql') {
      args.sql = requireValue(option, value);
      index += 1;
    } else if (option === '--target-column') {
      args.targetColumn = requireValue(option, value);
      index += 1;
    } else if (option === '--target-id') {
      args.targetId = requireValue(option, value);
      index += 1;
    } else if (option === '--target-node') {
      args.targetNode = requireValue(option, value);
      index += 1;
    } else if (option === '--symptom') {
      args.symptom = parseInvestigationSymptom(requireValue(option, value));
      index += 1;
    } else if (option === '--help' || option === '-h') {
      printInvestigateHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return args;
}

function loadSchemaFacts(args: DiagnoseArgs): SchemaFacts | undefined {
  if (args.schemaFacts) {
    return normalizeLoadedSchemaFacts(JSON.parse(readTextFile(args.schemaFacts)));
  }

  const ddlPaths = [
    ...args.ddlDir.flatMap((directory) => collectDdlFiles(resolve(process.cwd(), directory))),
    ...args.ddl.map((filePath) => resolve(process.cwd(), filePath)),
  ].sort((left, right) => left.localeCompare(right));

  if (ddlPaths.length === 0) {
    return undefined;
  }

  return parseSchemaFactsFromDdl(ddlPaths.map((filePath) => ({
    filePath,
    sql: readTextFile(filePath),
  })));
}

function loadDdlInputs(args: Pick<DiagnoseArgs, 'ddl' | 'ddlDir'>): DdlInput[] {
  return [
    ...args.ddlDir.flatMap((directory) => collectDdlFiles(resolve(process.cwd(), directory))),
    ...args.ddl.map((filePath) => resolve(process.cwd(), filePath)),
  ].sort((left, right) => left.localeCompare(right)).map((filePath) => ({ filePath, sql: readTextFile(filePath) }));
}

function normalizeLoadedSchemaFacts(value: unknown): SchemaFacts {
  if (!value || typeof value !== 'object' || !('tables' in value)) {
    throw new Error('SchemaFacts JSON must contain a tables object.');
  }
  const facts = value as Partial<SchemaFacts> & Pick<SchemaFacts, 'tables'>;
  return {
    ...facts,
    kind: 'schema-facts',
    tables: facts.tables,
    version: 1,
  };
}

export function collectDdlFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    throw new Error(`DDL directory does not exist: ${directory}`);
  }
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (excludedDirectories.has(entry)) {
        continue;
      }
      const fullPath = resolve(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && fullPath.toLowerCase().endsWith('.sql')) {
        result.push(fullPath);
      }
    }
  };
  visit(directory);
  return result.sort((left, right) => left.localeCompare(right));
}

function readTextFile(filePath: string): string {
  const resolvedPath = resolve(process.cwd(), filePath);
  try {
    return readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      const failure = new Error(`Path does not exist: ${resolvedPath}`) as Error & { code: 'PATH_NOT_FOUND' };
      failure.code = 'PATH_NOT_FOUND';
      throw failure;
    }
    throw error;
  }
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parseContractVersion(value: string): 1 {
  if (value !== '1') throw new Error(`Unsupported contract version: ${value}. Expected 1.`);
  return 1;
}

export interface CliFailureV1 { code: string; kind: 'invalid_input'; message: string; version: 1 }

export function cliFailure(error: unknown): CliFailureV1 {
  const message = error instanceof Error ? error.message : String(error);
  const typedCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : undefined;
  const code = typedCode ?? (message.startsWith('Unsupported contract version:') ? 'CONTRACT_VERSION_UNSUPPORTED'
    : /ENOENT|does not exist/i.test(message) ? 'PATH_NOT_FOUND'
      : 'INVALID_INPUT');
  return { code, kind: 'invalid_input', message, version: 1 };
}

function parseProblemIntent(value: string): DiagnosticProblemIntent {
  if (validProblemIntents.has(value as DiagnosticProblemIntent)) {
    return value as DiagnosticProblemIntent;
  }
  throw new Error(`Unknown symptom: ${value}. Expected one of: ${[...validProblemIntents].join(', ')}.`);
}

function parseInvestigationSymptom(value: string): ProblemIntent {
  if (validInvestigationSymptoms.has(value as ProblemIntent)) {
    return value as ProblemIntent;
  }
  throw new Error(`Unknown symptom: ${value}. Expected one of: ${[...validInvestigationSymptoms].join(', ')}.`);
}

function parseParameters(value: unknown): InvestigationPlannerParametersV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Parameters JSON must contain separate definitions and bindings fields.');
  }
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.definitions)) {
    throw new Error('Parameters JSON definitions must be an array of parameter objects.');
  }
  if (envelope.bindings !== undefined && (!envelope.bindings || typeof envelope.bindings !== 'object' || Array.isArray(envelope.bindings))) {
    throw new Error('Parameters JSON bindings must be an object keyed by parameter name.');
  }
  const definitions = envelope.definitions.map((parameter, index): InvestigationParameterDefinitionInputV1 => {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
      throw new Error(`Parameter at index ${index} must be an object.`);
    }
    const input = parameter as Record<string, unknown>;
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new Error(`Parameter at index ${index} must include a non-empty string name.`);
    }
    if (!investigationInputParameterOrigins.includes(input.origin as typeof investigationInputParameterOrigins[number])) {
      throw new Error(`Parameter ${input.name} has an invalid origin.`);
    }
    if (input.required !== undefined && typeof input.required !== 'boolean') {
      throw new Error(`Parameter ${input.name} required must be a boolean.`);
    }
    if (input.typeHint !== undefined && typeof input.typeHint !== 'string') {
      throw new Error(`Parameter ${input.name} typeHint must be a string.`);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'value')) {
      throw new Error('Parameter definitions must not contain binding values; use the top-level bindings object.');
    }
    return {
      name: input.name as string,
      origin: input.origin as InvestigationParameterDefinitionInputV1['origin'],
      ...(input.required !== undefined ? { required: input.required as boolean } : {}),
      ...(input.typeHint !== undefined ? { typeHint: input.typeHint as string } : {}),
    };
  });
  const bindings = (envelope.bindings ?? {}) as Record<string, unknown>;
  for (const [name, binding] of Object.entries(bindings)) {
    if (name.length === 0 || binding !== null && !['boolean', 'number', 'string'].includes(typeof binding)) {
      throw new Error('Each parameter binding must have a non-empty name and a scalar or null value.');
    }
  }
  const providedNames = Object.keys(bindings).sort();
  return {
    definitions,
    ...(providedNames.length > 0 ? { bindingPresence: { providedNames } } : {}),
  };
}

function parseParameterFile(filePath: string): InvestigationPlannerParametersV1 {
  const text = readTextFile(filePath);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Parameters file must contain valid JSON.');
  }
  return parseParameters(value);
}

function printHelp(): void {
  process.stdout.write(`rawsql-lineage diagnose --sql <file> [--contract-version 1] [--target-column <name>] [--symptom <intent>] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>] [--out <file>]\nrawsql-lineage discover --sql <file> [--contract-version 1] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>]\n`);
}

function printInvestigateHelp(): void {
  process.stdout.write('rawsql-lineage investigate --sql <file> (--target-id <id> | --target-node <node-id> --target-column <name>) [--contract-version 1] [--symptom <intent>] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>] [--parameters <definitions-and-bindings-file>]\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(cliFailure(error))}\n`);
    process.exit(1);
  });
}
