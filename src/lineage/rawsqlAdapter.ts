import {
  BinarySelectQuery,
  CTECollector,
  ColumnReference,
  FunctionSource,
  ParenSource,
  SelectQueryParser,
  SimpleSelectQuery,
  SubQuerySource,
  TableSource,
} from 'rawsql-ts';
import type { CommonTable, JoinClause, SourceExpression } from 'rawsql-ts';
import type { AnalysisWarning, LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

export interface ParserAdapterResult {
  lineage: LineageModel;
  parserVersion: string;
}

const parserVersion = 'rawsql-ts';

export function analyzeSql(sql: string): ParserAdapterResult {
  const warnings: AnalysisWarning[] = [];
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const derivedCounter = { value: 0 };

  let query;
  try {
    query = SelectQueryParser.parse(sql);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  nodes.set('main_output', {
    id: 'main_output',
    type: 'output',
    label: 'Final Result',
    columns: [],
  });

  const ctes = new CTECollector().collect(query);
  const cteNames = new Set(ctes.map((cte) => cte.getSourceAliasName()));

  for (const cte of ctes) {
    const cteName = cte.getSourceAliasName();
    nodes.set(toCteId(cteName), {
      id: toCteId(cteName),
      type: 'cte',
      label: cteName,
      columns: [],
      materializationHint: normalizeMaterializationHint(cte.materialized),
    });
  }

  for (const cte of ctes) {
    collectQueryEdges({
      query: cte.query,
      targetId: toCteId(cte.getSourceAliasName()),
      targetLabel: cte.getSourceAliasName(),
      cteNames,
      nodes,
      edges,
      warnings,
      derivedCounter,
    });
  }

  collectQueryEdges({
    query,
    targetId: 'main_output',
    targetLabel: 'Final Result',
    cteNames,
    nodes,
    edges,
    warnings,
    derivedCounter,
  });

  const lineage: LineageModel = {
    kind: 'sql-lineage-model',
    modelVersion: 1,
    nodes: [...nodes.values()],
    edges: dedupeEdges(edges),
    analysisWarnings: warnings,
    raw: {
      adapter: 'rawsql-ts-ast',
    },
  };

  return {
    lineage,
    parserVersion,
  };
}

interface CollectQueryEdgesOptions {
  query: unknown;
  targetId: string;
  targetLabel: string;
  cteNames: Set<string>;
  nodes: Map<string, LineageNode>;
  edges: LineageEdge[];
  warnings: AnalysisWarning[];
  derivedCounter: { value: number };
}

interface ResolvedSource {
  node: LineageNode;
  aliases: string[];
}

function collectQueryEdges(options: CollectQueryEdgesOptions): void {
  const { query, targetId, targetLabel, cteNames, nodes, edges, warnings, derivedCounter } = options;

  if (query instanceof SimpleSelectQuery) {
    setNodeColumns(nodes, targetId, collectOutputColumns(query));

    const fromClause = query.fromClause;
    if (!fromClause) {
      warnings.push({
        code: 'select-without-source',
        message: `${targetLabel} has no FROM source, so no upstream lineage edge was created.`,
      });
      return;
    }

    const sources = [
      resolveSourceExpression(fromClause.source, cteNames, nodes, edges, warnings, derivedCounter),
    ];
    const joins = fromClause.joins ?? [];

    for (const source of sources) {
      addLineageEdge(edges, {
        source: source.node.id,
        target: targetId,
        type: 'dataFlow',
        confidence: 'high',
      });
    }

    for (const join of joins) {
      const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, warnings, derivedCounter);
      sources.push(joinedSource);

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'dataFlow',
        label: normalizeJoinLabel(join),
        joinType: normalizeJoinType(join),
        confidence: 'high',
      });

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'join',
        label: normalizeJoinLabel(join),
        joinType: normalizeJoinType(join),
        confidence: 'high',
      });
    }

    setReferencedSourceColumns(query, sources, nodes);

    return;
  }

  if (query instanceof BinarySelectQuery) {
    const operator = query.operator.value.toUpperCase();
    const leftId = collectBinaryPart(query.left, 'left', operator, options);
    const rightId = collectBinaryPart(query.right, 'right', operator, options);
    addLineageEdge(edges, {
      source: leftId,
      target: targetId,
      type: 'dataFlow',
      label: operator,
      confidence: 'medium',
    });
    addLineageEdge(edges, {
      source: rightId,
      target: targetId,
      type: 'dataFlow',
      label: operator,
      confidence: 'medium',
    });
    return;
  }

  warnings.push({
    code: 'unsupported-query-kind',
    message: `${targetLabel} uses a query kind that the MVP lineage adapter does not support yet.`,
  });
}

function collectBinaryPart(query: unknown, side: string, operator: string, options: CollectQueryEdgesOptions): string {
  const { nodes, derivedCounter } = options;
  derivedCounter.value += 1;
  const id = `derived_${operator.toLowerCase().replace(/\s+/g, '_')}_${side}_${derivedCounter.value}`;
  nodes.set(id, {
    id,
    type: 'derived',
    label: `${operator} ${side}`,
    columns: [],
  });
  collectQueryEdges({ ...options, query, targetId: id, targetLabel: `${operator} ${side}` });
  return id;
}

function resolveSourceExpression(
  source: SourceExpression,
  cteNames: Set<string>,
  nodes: Map<string, LineageNode>,
  edges: LineageEdge[],
  warnings: AnalysisWarning[],
  derivedCounter: { value: number },
): ResolvedSource {
  const datasource = source.datasource;

  if (datasource instanceof TableSource) {
    const sourceName = datasource.getSourceName();
    const alias = source.getAliasName();
    const aliases = alias ? [alias, sourceName] : [sourceName];
    if (cteNames.has(sourceName)) {
      return {
        node: nodes.get(toCteId(sourceName)) ?? createCteNode(sourceName, nodes),
        aliases,
      };
    }
    return {
      node: createTableNode(sourceName, nodes),
      aliases,
    };
  }

  if (datasource instanceof SubQuerySource) {
    derivedCounter.value += 1;
    const alias = source.getAliasName() ?? `subquery_${derivedCounter.value}`;
    const id = `derived_${sanitizeId(alias)}_${derivedCounter.value}`;
    const node: LineageNode = {
      id,
      type: 'derived',
      label: alias,
      columns: [],
    };
    nodes.set(id, node);
    collectQueryEdges({
      query: datasource.query,
      targetId: id,
      targetLabel: alias,
      cteNames,
      nodes,
      edges,
      warnings,
      derivedCounter,
    });
    return {
      node,
      aliases: [alias],
    };
  }

  if (datasource instanceof ParenSource) {
    return resolveSourceExpression(
      {
        datasource: datasource.source,
        aliasExpression: source.aliasExpression,
      } as SourceExpression,
      cteNames,
      nodes,
      edges,
      warnings,
      derivedCounter,
    );
  }

  if (datasource instanceof FunctionSource) {
    const name = datasource.name instanceof Object && 'name' in datasource.name ? datasource.name.name : String(datasource.name);
    return {
      node: createDerivedNode(`function_${sanitizeId(name)}`, name, nodes),
      aliases: [source.getAliasName() ?? name],
    };
  }

  warnings.push({
    code: 'unsupported-source-kind',
    message: `Unsupported source kind ${source.datasource.constructor.name}; created an unknown derived node.`,
  });
  return {
    node: createDerivedNode(`derived_unknown_${nodes.size}`, 'unknown source', nodes),
    aliases: [source.getAliasName() ?? 'unknown source'],
  };
}

function collectOutputColumns(query: SimpleSelectQuery): string[] {
  return query.selectClause.items.map((item, index) => {
    if (item.identifier) {
      return item.identifier.name;
    }
    if (item.value instanceof ColumnReference) {
      return item.value.column.name;
    }
    return `expr_${index + 1}`;
  });
}

function setReferencedSourceColumns(query: SimpleSelectQuery, sources: ResolvedSource[], nodes: Map<string, LineageNode>): void {
  const sourceByAlias = new Map<string, ResolvedSource>();
  for (const source of sources) {
    for (const alias of source.aliases) {
      sourceByAlias.set(alias, source);
    }
  }

  const columnsByNode = new Map<string, string[]>();
  for (const reference of collectQueryColumnReferences(query)) {
    const columnName = reference.column.name;
    if (columnName === '*') {
      continue;
    }

    const namespace = reference.getNamespace();
    const source = namespace ? sourceByAlias.get(namespace) : sources.length === 1 ? sources[0] : null;
    if (!source) {
      continue;
    }

    columnsByNode.set(source.node.id, [...(columnsByNode.get(source.node.id) ?? []), columnName]);
  }

  for (const [nodeId, columns] of columnsByNode) {
    setNodeColumns(nodes, nodeId, columns);
  }
}

function collectQueryColumnReferences(query: SimpleSelectQuery): ColumnReference[] {
  const roots: unknown[] = [
    ...query.selectClause.items.map((item) => item.value),
    query.whereClause?.condition,
    ...(query.groupByClause?.grouping ?? []),
    query.havingClause?.condition,
    ...(query.orderByClause?.order ?? []),
    ...(query.fromClause?.joins ?? []).map((join) => join.condition),
  ];
  return collectColumnReferences(roots);
}

function collectColumnReferences(value: unknown): ColumnReference[] {
  const references: ColumnReference[] = [];
  const visited = new Set<unknown>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (current instanceof ColumnReference) {
      references.push(current);
      return;
    }

    for (const nested of Object.values(current)) {
      if (Array.isArray(nested)) {
        nested.forEach(visit);
      } else {
        visit(nested);
      }
    }
  };

  visit(value);
  return references;
}

function setNodeColumns(nodes: Map<string, LineageNode>, nodeId: string, columnNames: string[]): void {
  const node = nodes.get(nodeId);
  if (!node) {
    return;
  }
  const seen = new Set(node.columns.map((column) => column.name));
  const nextColumns = [...node.columns];
  for (const name of columnNames) {
    if (!seen.has(name)) {
      seen.add(name);
      nextColumns.push({
        id: `${nodeId}.${sanitizeId(name)}`,
        name,
      });
    }
  }
  node.columns = nextColumns;
}

function createTableNode(tableName: string, nodes: Map<string, LineageNode>): LineageNode {
  const id = toTableId(tableName);
  const existing = nodes.get(id);
  if (existing) {
    return existing;
  }
  const node: LineageNode = {
    id,
    type: 'table',
    label: tableName,
    columns: [],
  };
  nodes.set(id, node);
  return node;
}

function createCteNode(cteName: string, nodes: Map<string, LineageNode>): LineageNode {
  const node: LineageNode = {
    id: toCteId(cteName),
    type: 'cte',
    label: cteName,
    columns: [],
    materializationHint: 'none',
  };
  nodes.set(node.id, node);
  return node;
}

function createDerivedNode(id: string, label: string, nodes: Map<string, LineageNode>): LineageNode {
  const existing = nodes.get(id);
  if (existing) {
    return existing;
  }
  const node: LineageNode = {
    id,
    type: 'derived',
    label,
    columns: [],
  };
  nodes.set(id, node);
  return node;
}

function addLineageEdge(edges: LineageEdge[], edge: Omit<LineageEdge, 'id'>): void {
  edges.push({
    ...edge,
    id: `${edge.source}-${edge.target}${edge.type === 'join' ? `-${sanitizeId(edge.label ?? 'join')}` : ''}`,
  });
}

function normalizeJoinLabel(join: JoinClause): string {
  const value = join.joinType.value.trim();
  return value.length > 0 ? value.toUpperCase() : 'JOIN';
}

function normalizeJoinType(join: JoinClause): LineageEdge['joinType'] {
  const normalized = join.joinType.value.toLowerCase();
  if (normalized.includes('left')) {
    return 'left';
  }
  if (normalized.includes('right')) {
    return 'right';
  }
  if (normalized.includes('full')) {
    return 'full';
  }
  if (normalized.includes('join')) {
    return 'inner';
  }
  return 'unknown';
}

function normalizeMaterializationHint(materialized: CommonTable['materialized']): LineageNode['materializationHint'] {
  if (materialized === true) {
    return 'MATERIALIZED';
  }
  if (materialized === false) {
    return 'NOT MATERIALIZED';
  }
  return 'none';
}

function toTableId(tableName: string): string {
  return `table_${sanitizeId(tableName)}`;
}

function toCteId(cteName: string): string {
  return `cte_${sanitizeId(cteName)}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function dedupeEdges(edges: LineageEdge[]): LineageEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}|${edge.label ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
