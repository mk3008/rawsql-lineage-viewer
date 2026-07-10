#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildColumnDiagnosticPacket } from '../lineage/diagnostics';
import type { AnalysisWarning } from '../domain/lineage';
import { createInvestigationPlan, type InvestigationPlanV1, type InvestigationPlannerParameterInputV1 } from '../lineage/investigationPlan';
import { diagnosticProblemIntents, problemIntentOptions, symptomEffectMap, type DiagnosticConcernEffect, type DiagnosticProblemIntent, type ProblemIntent } from '../lineage/problemIntent';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import type { DdlInput, SchemaFacts } from '../lineage/schemaFacts';
import { parseSchemaFactsFromDdl } from '../lineage/schemaFacts';

interface DiagnoseArgs {
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
  targetNode?: string;
}

interface InvestigationCliDependencies {
  createPlan: typeof createInvestigationPlan;
}

interface SqlDiagnosticReport {
  diagnostics: AnalysisWarning[];
  kind: 'sql-diagnostic-report';
  packets: ReturnType<typeof buildColumnDiagnosticPacket>[];
  schemaFacts?: SchemaFacts;
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

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
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
  const { lineage } = analyzeSql(sql, { schemaFacts });
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
  dependencies: InvestigationCliDependencies = { createPlan: createInvestigationPlan },
): InvestigationPlanV1 {
  const args = parseInvestigateArgs(argv);
  if (!args.sql) {
    throw new Error('Missing required --sql <file> option.');
  }
  if (!args.targetNode) {
    throw new Error('Missing required --target-node <node-id> option.');
  }
  if (!args.targetColumn) {
    throw new Error('Missing required --target-column <column-name> option.');
  }
  if (args.schemaFacts && (args.ddl.length > 0 || args.ddlDir.length > 0)) {
    throw new Error('Use either --schema-facts <file> or --ddl/--ddl-dir inputs, not both.');
  }

  const ddl = loadDdlInputs(args);
  const schemaFacts = args.schemaFacts ? normalizeLoadedSchemaFacts(JSON.parse(readTextFile(args.schemaFacts))) : undefined;
  const parameters = args.parameters ? parseParameters(JSON.parse(readTextFile(args.parameters))) : undefined;
  return dependencies.createPlan({
    ...(ddl.length > 0 ? { ddl } : {}),
    ...(parameters ? { parameters } : {}),
    ...(schemaFacts ? { schemaFacts } : {}),
    sql: readTextFile(args.sql),
    symptom: args.symptom,
    target: { columnName: args.targetColumn, nodeId: args.targetNode },
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
  return readFileSync(resolve(process.cwd(), filePath), 'utf8');
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
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

function parseParameters(value: unknown): InvestigationPlannerParameterInputV1[] {
  if (!Array.isArray(value)) {
    throw new Error('Parameters JSON must be an array of parameter objects.');
  }
  return value.map((parameter, index) => {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
      throw new Error(`Parameter at index ${index} must be an object.`);
    }
    const input = parameter as Record<string, unknown>;
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new Error(`Parameter at index ${index} must include a non-empty string name.`);
    }
    if (!['investigation_key', 'original_query_parameter', 'derived_parameter', 'environment_parameter'].includes(String(input.origin))) {
      throw new Error(`Parameter ${input.name} has an invalid origin.`);
    }
    if (input.required !== undefined && typeof input.required !== 'boolean') {
      throw new Error(`Parameter ${input.name} required must be a boolean.`);
    }
    if (input.typeHint !== undefined && typeof input.typeHint !== 'string') {
      throw new Error(`Parameter ${input.name} typeHint must be a string.`);
    }
    if (input.value !== undefined && input.value !== null && !['boolean', 'number', 'string'].includes(typeof input.value)) {
      throw new Error(`Parameter ${input.name} value must be null, boolean, number, or string.`);
    }
    return {
      name: input.name as string,
      origin: input.origin as InvestigationPlannerParameterInputV1['origin'],
      ...(input.required !== undefined ? { required: input.required as boolean } : {}),
      ...(input.typeHint !== undefined ? { typeHint: input.typeHint as string } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'value') ? { value: input.value as boolean | number | string | null } : {}),
    };
  });
}

function printHelp(): void {
  process.stdout.write(`rawsql-lineage diagnose --sql <file> [--target-column <name>] [--symptom <intent>] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>] [--out <file>]\n`);
}

function printInvestigateHelp(): void {
  process.stdout.write('rawsql-lineage investigate --sql <file> --target-node <node-id> --target-column <name> [--symptom <intent>] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>] [--parameters <file>]\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
