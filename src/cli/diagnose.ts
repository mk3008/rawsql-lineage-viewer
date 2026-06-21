#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildColumnDiagnosticPacket } from '../lineage/diagnostics';
import type { AnalysisWarning } from '../domain/lineage';
import { diagnosticProblemIntents, symptomEffectMap, type DiagnosticConcernEffect, type DiagnosticProblemIntent } from '../lineage/problemIntent';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import type { SchemaFacts } from '../lineage/schemaFacts';
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

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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
  const command = argv[0] === 'diagnose' ? argv.shift() : undefined;
  void command;

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

function printHelp(): void {
  process.stdout.write(`rawsql-lineage diagnose --sql <file> [--target-column <name>] [--symptom <intent>] [--ddl <file> ...] [--ddl-dir <dir> ...] [--schema-facts <file>] [--out <file>]\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
