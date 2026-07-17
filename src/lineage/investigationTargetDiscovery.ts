import type { AnalysisWarning, LineageColumn, LineageNode, LineageNodeType } from '../domain/lineage';
import {
  createInvestigationPlan,
  type InvestigationPlanInputV1,
  type InvestigationPlanV1,
} from './investigationPlan';
import { analyzeSql } from './rawsqlAdapter';
import { parseSchemaFactsFromDdl, type DdlInput, type SchemaFacts } from './schemaFacts';

export interface InvestigationTargetDiscoveryInputV1 {
  /** Submitted SQL analyzed without rewriting or execution. */
  sql: string;
  ddl?: DdlInput[];
  schemaFacts?: SchemaFacts;
}

export interface InvestigationAnalysisSummaryV1 {
  analysisMode: 'original';
  ambiguousTargetCount: number;
  kind: 'investigation-analysis-summary';
  nodeCount: number;
  outputColumnCount: number;
  parserVersion: string;
  selectableTargetCount: number;
  targetCount: number;
  targetNodeCount: number;
  unsupportedTargetCount: number;
  version: 1;
  warningCount: number;
  warnings: AnalysisWarning[];
}

export type InvestigationTargetReasonV1 =
  | 'final_output_column'
  | 'named_query_output_column'
  | 'syntax_derived_output_identity';

export interface InvestigationTargetIdentityV1 {
  column: {
    id: string;
    name: string;
    outputIndex?: number;
    selectItemId?: string;
  };
  node: {
    id: string;
    label: string;
    type: LineageNodeType;
  };
}

export interface InvestigationDiscoveredTargetV1 {
  id: string;
  identity: InvestigationTargetIdentityV1;
  order: number;
  reasons: InvestigationTargetReasonV1[];
  selection:
    | { planTarget: { columnName: string; nodeId: string }; status: 'selectable' }
    | { ambiguityCode: 'duplicate_output_name'; status: 'ambiguous' }
    | { unsupportedCode: 'output_identity_unavailable'; status: 'unsupported' };
}

export interface InvestigationTargetAmbiguityV1 {
  code: 'duplicate_output_name';
  columnName: string;
  message: string;
  nodeId: string;
  targetIds: string[];
}

export interface InvestigationTargetUnsupportedV1 {
  code: 'output_identity_unavailable' | 'unresolved_output_reference' | 'wildcard_unresolved_without_schema';
  message: string;
  nodeId?: string;
  targetIds: string[];
}

export interface InvestigationTargetDiscoveryV1 {
  ambiguities: InvestigationTargetAmbiguityV1[];
  analysis: InvestigationAnalysisSummaryV1;
  kind: 'investigation-target-discovery';
  targets: InvestigationDiscoveredTargetV1[];
  unsupported: InvestigationTargetUnsupportedV1[];
  version: 1;
}

export class InvestigationTargetSelectionError extends Error {
  readonly code: 'TARGET_AMBIGUOUS' | 'TARGET_NOT_FOUND' | 'TARGET_UNSUPPORTED';

  constructor(code: InvestigationTargetSelectionError['code']) {
    super(code === 'TARGET_AMBIGUOUS'
      ? 'The discovered target is ambiguous and cannot be used to create a plan.'
      : code === 'TARGET_UNSUPPORTED'
        ? 'The discovered target lacks the syntax-derived identity required to create a plan.'
        : 'The target id does not identify a target in this discovery result.');
    this.name = 'InvestigationTargetSelectionError';
    this.code = code;
  }
}

/** Discovers deterministic plan targets from supplied SQL/DDL only. */
export function discoverInvestigationTargets(input: InvestigationTargetDiscoveryInputV1): InvestigationTargetDiscoveryV1 {
  const schemaFacts = input.schemaFacts ?? (input.ddl ? parseSchemaFactsFromDdl(input.ddl) : undefined);
  const { lineage, parserVersion } = analyzeSql(input.sql, {
    analysisMode: 'original',
    optimizeConditions: false,
    schemaFacts,
  });
  const nodes = lineage.nodes.filter(isTargetNode).sort(compareTargetNodes);
  const candidates = nodes.flatMap((node) => node.columns.map((column) => ({ column, node }))).sort(compareCandidate);
  const duplicateKeys = duplicateOutputKeys(candidates);
  const targets = candidates.map(({ column, node }, index): InvestigationDiscoveredTargetV1 => {
    const id = `target:${String(index + 1).padStart(3, '0')}`;
    const hasIdentity = column.outputIndex !== undefined && column.selectItemId !== undefined;
    const duplicate = duplicateKeys.has(outputKey(node.id, column.name));
    return {
      id,
      identity: {
        column: {
          id: column.id,
          name: column.name,
          ...(column.outputIndex !== undefined ? { outputIndex: column.outputIndex } : {}),
          ...(column.selectItemId !== undefined ? { selectItemId: column.selectItemId } : {}),
        },
        node: { id: node.id, label: node.label, type: node.type },
      },
      order: index,
      reasons: [
        node.id === 'main_output' ? 'final_output_column' : 'named_query_output_column',
        ...(hasIdentity ? ['syntax_derived_output_identity' as const] : []),
      ],
      selection: !hasIdentity
        ? { status: 'unsupported', unsupportedCode: 'output_identity_unavailable' }
        : duplicate
          ? { status: 'ambiguous', ambiguityCode: 'duplicate_output_name' }
          : { status: 'selectable', planTarget: { columnName: column.name, nodeId: node.id } },
    };
  });
  const targetByIdentity = new Map(candidates.map(({ column, node }, index) => [columnIdentityKey(node, column), targets[index]]));
  const ambiguities = [...duplicateKeys].sort().map((key): InvestigationTargetAmbiguityV1 => {
    const [nodeId, columnName] = splitOutputKey(key);
    return {
      code: 'duplicate_output_name',
      columnName,
      message: 'More than one output has this name; the version 1 plan target cannot distinguish them by ordinal.',
      nodeId,
      targetIds: targets.filter((target) => target.identity.node.id === nodeId && target.identity.column.name === columnName).map((target) => target.id),
    };
  });
  const unsupported: InvestigationTargetUnsupportedV1[] = [];
  const missingIdentityIds = targets.filter((target) => target.selection.status === 'unsupported').map((target) => target.id);
  if (missingIdentityIds.length > 0) {
    unsupported.push({
      code: 'output_identity_unavailable',
      message: 'One or more outputs lack a syntax-derived output index or select-item identity.',
      targetIds: missingIdentityIds,
    });
  }
  const unresolvedIds = candidates
    .filter(({ column }) => (column.unresolvedUpstream?.length ?? 0) > 0)
    .map(({ column, node }) => targetByIdentity.get(columnIdentityKey(node, column))!.id);
  if (unresolvedIds.length > 0) {
    unsupported.push({
      code: 'unresolved_output_reference',
      message: 'Static lineage contains unresolved upstream references for these outputs.',
      targetIds: unresolvedIds,
    });
  }
  for (const warning of lineage.analysisWarnings.filter((item) => item.code === 'wildcard_unresolved_without_schema')) {
    unsupported.push({
      code: 'wildcard_unresolved_without_schema',
      message: warning.message,
      targetIds: [],
    });
  }
  return {
    ambiguities,
    analysis: {
      analysisMode: 'original',
      ambiguousTargetCount: targets.filter((target) => target.selection.status === 'ambiguous').length,
      kind: 'investigation-analysis-summary',
      nodeCount: lineage.nodes.length,
      outputColumnCount: targets.filter((target) => target.identity.column.outputIndex !== undefined).length,
      parserVersion,
      selectableTargetCount: targets.filter((target) => target.selection.status === 'selectable').length,
      targetCount: targets.length,
      targetNodeCount: nodes.length,
      unsupportedTargetCount: targets.filter((target) => target.selection.status === 'unsupported').length,
      version: 1,
      warningCount: lineage.analysisWarnings.length,
      warnings: lineage.analysisWarnings,
    },
    kind: 'investigation-target-discovery',
    targets,
    unsupported,
    version: 1,
  };
}

/** Resolves only an unambiguous, fully identified discovery target into the existing plan target shape. */
export function resolveInvestigationTarget(
  discovery: InvestigationTargetDiscoveryV1,
  targetId: string,
): { columnName: string; nodeId: string } {
  const target = discovery.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new InvestigationTargetSelectionError('TARGET_NOT_FOUND');
  if (target.selection.status === 'ambiguous') throw new InvestigationTargetSelectionError('TARGET_AMBIGUOUS');
  if (target.selection.status === 'unsupported') throw new InvestigationTargetSelectionError('TARGET_UNSUPPORTED');
  return target.selection.planTarget;
}

/** Re-discovers and resolves a target against the same supplied static inputs before plan creation. */
export function createInvestigationPlanForTarget(
  input: Omit<InvestigationPlanInputV1, 'target'>,
  targetId: string,
): InvestigationPlanV1 {
  const discovery = discoverInvestigationTargets(input);
  return createInvestigationPlan({ ...input, target: resolveInvestigationTarget(discovery, targetId) });
}

function isTargetNode(node: LineageNode): boolean {
  return node.type === 'output' || node.type === 'cte' || node.type === 'derived';
}

function compareTargetNodes(left: LineageNode, right: LineageNode): number {
  if (left.id === 'main_output') return right.id === 'main_output' ? 0 : -1;
  if (right.id === 'main_output') return 1;
  return left.id.localeCompare(right.id);
}

function compareCandidate(left: { column: LineageColumn; node: LineageNode }, right: { column: LineageColumn; node: LineageNode }): number {
  const nodeOrder = compareTargetNodes(left.node, right.node);
  if (nodeOrder !== 0) return nodeOrder;
  return (left.column.outputIndex ?? Number.MAX_SAFE_INTEGER) - (right.column.outputIndex ?? Number.MAX_SAFE_INTEGER)
    || left.column.name.localeCompare(right.column.name)
    || left.column.id.localeCompare(right.column.id);
}

function duplicateOutputKeys(candidates: Array<{ column: LineageColumn; node: LineageNode }>): Set<string> {
  const counts = new Map<string, number>();
  for (const { column, node } of candidates) {
    const key = outputKey(node.id, column.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function outputKey(nodeId: string, columnName: string): string {
  return `${nodeId}\u0000${columnName}`;
}

function splitOutputKey(key: string): [string, string] {
  const separator = key.indexOf('\u0000');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function columnIdentityKey(node: LineageNode, column: LineageColumn): string {
  return `${node.id}\u0000${column.id}\u0000${column.outputIndex ?? ''}\u0000${column.selectItemId ?? ''}`;
}
