import {
  BinarySelectQuery,
  CTECollector,
  CTEQueryDecomposer,
  ColumnReference,
  FunctionSource,
  ParenSource,
  SelectQueryParser,
  SimpleSelectQuery,
  SqlFormatter,
  SubQuerySource,
  TableSource,
} from 'rawsql-ts';
import type { CommonTable, JoinClause, SourceExpression } from 'rawsql-ts';
import type { AnalysisWarning, LineageColumn, LineageColumnRef, LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

export interface ParserAdapterResult {
  lineage: LineageModel;
  parserVersion: string;
}

const parserVersion = 'rawsql-ts';
const rawsqlDemoFormatterOptions = {
  indentSize: 4,
  indentChar: 'space',
  newline: 'lf',
  keywordCase: 'lower',
  commaBreak: 'before',
  cteCommaBreak: 'after',
  valuesCommaBreak: 'before',
  andBreak: 'before',
  orBreak: 'before',
  joinOnBreak: 'before',
  joinConditionContinuationIndent: true,
  exportComment: 'full',
  commentStyle: 'smart',
  withClauseStyle: 'standard',
  parenthesesOneLine: true,
  indentNestedParentheses: true,
  betweenOneLine: true,
  inOneLine: true,
  valuesOneLine: true,
  joinOneLine: true,
  caseOneLine: true,
  subqueryOneLine: true,
  insertColumnsOneLine: true,
  whenOneLine: true,
  oneLineMaxLength: 100,
  joinConditionOrderByDeclaration: true,
  orderByDefaultDirectionStyle: 'omit',
  columnAliasStyle: 'explicit',
  constraintStyle: 'postgres',
  identifierEscape: 'none',
  identifierEscapeTarget: 'all',
  parameterSymbol: ':',
  parameterStyle: 'named',
  sourceAliasStyle: 'explicit',
  castStyle: 'standard',
} as const;
const expressionFormatterOptions = {
  ...rawsqlDemoFormatterOptions,
  sourceAliasStyle: rawsqlDemoFormatterOptions.sourceAliasStyle === 'explicit' ? 'as' : rawsqlDemoFormatterOptions.sourceAliasStyle,
};
const expressionFormatter = new SqlFormatter(expressionFormatterOptions as unknown as ConstructorParameters<typeof SqlFormatter>[0]);
const cteExecutableSqlFormatter = new SqlFormatter({
  ...expressionFormatterOptions,
  identifierEscape: 'quote',
  identifierEscapeTarget: 'minimal',
  withClauseStyle: 'standard',
} as unknown as ConstructorParameters<typeof SqlFormatter>[0]);

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
    comments: extractQueryNodeComments(query),
  });

  const ctes = new CTECollector().collect(query);
  const cteNames = new Set(ctes.map((cte) => cte.getSourceAliasName()));
  const cteCommentsByName = new Map(ctes.map((cte) => [cte.getSourceAliasName(), extractCteComments(cte)]));
  const cteSqlCommentsByName = new Map(
    ctes.map((cte) => [cte.getSourceAliasName(), mergeComments(extractCteComments(cte), extractQueryColumnComments(cte.query))]),
  );
  const cteExecutableSqlByName = collectCteExecutableSql(query, ctes, warnings, cteSqlCommentsByName);

  for (const cte of ctes) {
    const cteName = cte.getSourceAliasName();
    nodes.set(toCteId(cteName), {
      id: toCteId(cteName),
      type: 'cte',
      label: cteName,
      columns: [],
      comments: cteCommentsByName.get(cteName),
      cteExecutableSql: cteExecutableSqlByName.get(cteName),
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
  sourceAlias?: string;
}

function collectQueryEdges(options: CollectQueryEdgesOptions): void {
  const { query, targetId, targetLabel, cteNames, nodes, edges, warnings, derivedCounter } = options;

  if (query instanceof SimpleSelectQuery) {
    const fromClause = query.fromClause;
    if (!fromClause) {
      setNodeColumns(nodes, targetId, collectOutputColumns(query, []));
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
        sourceAlias: source.sourceAlias,
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
        sourceAlias: joinedSource.sourceAlias,
        joinType: normalizeJoinType(join),
        confidence: 'high',
      });

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'join',
        label: normalizeJoinLabel(join),
        sourceAlias: joinedSource.sourceAlias,
        joinType: normalizeJoinType(join),
        confidence: 'high',
      });
    }

    setNodeColumns(nodes, targetId, collectOutputColumns(query, sources));
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
    comments: extractQueryNodeComments(query),
  });
  collectQueryEdges({ ...options, query, targetId: id, targetLabel: `${operator} ${side}` });
  return id;
}

function collectCteExecutableSql(
  query: unknown,
  ctes: CommonTable[],
  warnings: AnalysisWarning[],
  cteSqlCommentsByName: Map<string, string[] | undefined>,
): Map<string, string> {
  const sqlByName = new Map<string, string>();
  if (ctes.length === 0) {
    return sqlByName;
  }

  if (!(query instanceof SimpleSelectQuery)) {
    warnings.push({
      code: 'cte-executable-sql-unsupported-query-kind',
      message: 'Executable CTE SQL extraction is only available for simple SELECT queries in the MVP adapter.',
    });
    return sqlByName;
  }

  const decomposer = new CTEQueryDecomposer();
  for (const cte of ctes) {
    const cteName = cte.getSourceAliasName();
    try {
      const result = decomposer.extractCTE(query, cteName);
      sqlByName.set(cteName, formatCteExecutableSql(result.executableSql, collectExecutableSqlComments(cteName, result.executableSql, ctes, cteSqlCommentsByName)));
      for (const warning of result.warnings) {
        warnings.push({
          code: 'cte-executable-sql-warning',
          message: `${cteName}: ${warning}`,
        });
      }
    } catch (error) {
      warnings.push({
        code: 'cte-executable-sql-failed',
        message: `Could not extract executable SQL for CTE ${cteName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return sqlByName;
}

function collectExecutableSqlComments(
  cteName: string,
  sql: string,
  ctes: CommonTable[],
  cteSqlCommentsByName: Map<string, string[] | undefined>,
): string[] | undefined {
  const comments: string[] = [];
  const lowerSql = sql.toLowerCase();
  for (const cte of ctes) {
    const candidateName = cte.getSourceAliasName();
    if (candidateName !== cteName && !lowerSql.includes(candidateName.toLowerCase())) {
      continue;
    }
    comments.push(...(cteSqlCommentsByName.get(candidateName) ?? []));
  }
  return comments.length > 0 ? dedupeComments(comments) : undefined;
}

function formatCteExecutableSql(sql: string, comments?: string[]): string {
  const trimmedSql = sql.trim();
  try {
    return prependSqlComments(cteExecutableSqlFormatter.format(SelectQueryParser.parse(trimmedSql)).formattedSql.trim(), comments);
  } catch {
    return prependSqlComments(trimmedSql, comments);
  }
}

function prependSqlComments(sql: string, comments?: string[]): string {
  if (!comments || comments.length === 0) {
    return sql;
  }
  return `${comments.map((comment) => `-- ${comment.replace(/\r?\n/g, ' ')}`).join('\n')}\n${sql}`;
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
    const alias = source.aliasExpression ? source.getAliasName() : null;
    const aliases = alias ? [alias, sourceName] : [sourceName];
    if (cteNames.has(sourceName)) {
      return {
        node: nodes.get(toCteId(sourceName)) ?? createCteNode(sourceName, nodes),
        aliases,
        sourceAlias: alias ?? undefined,
      };
    }
    return {
      node: createTableNode(sourceName, nodes),
      aliases,
      sourceAlias: alias ?? undefined,
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
      comments: extractQueryNodeComments(datasource.query),
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
      sourceAlias: alias,
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
    const alias = source.aliasExpression ? source.getAliasName() : null;
    return {
      node: createDerivedNode(`function_${sanitizeId(name)}`, name, nodes),
      aliases: [alias ?? name],
      sourceAlias: alias ?? undefined,
    };
  }

  warnings.push({
    code: 'unsupported-source-kind',
    message: `Unsupported source kind ${source.datasource.constructor.name}; created an unknown derived node.`,
  });
  return {
    node: createDerivedNode(`derived_unknown_${nodes.size}`, 'unknown source', nodes),
    aliases: [source.getAliasName() ?? 'unknown source'],
    sourceAlias: source.getAliasName() ?? undefined,
  };
}

function collectOutputColumns(query: SimpleSelectQuery, sources: ResolvedSource[]): LineageColumn[] {
  return query.selectClause.items.map((item, index) => {
    const upstream = resolveColumnReferences(item.value, sources);
    const comments = extractSelectItemComments(query.selectClause.items, index);
    const name = (() => {
    if (item.identifier) {
      return item.identifier.name;
    }
    if (item.value instanceof ColumnReference) {
      return item.value.column.name;
    }
    return `expr_${index + 1}`;
    })();
    return {
      id: '',
      name,
      comments,
      expressionSql: formatExpressionSql(item.value),
      upstream,
    };
  });
}

function setReferencedSourceColumns(query: SimpleSelectQuery, sources: ResolvedSource[], nodes: Map<string, LineageNode>): void {
  const columnsByNode = new Map<string, string[]>();
  for (const reference of resolveColumnReferences(collectQueryColumnReferences(query), sources)) {
    columnsByNode.set(reference.nodeId, [...(columnsByNode.get(reference.nodeId) ?? []), reference.columnName]);
  }

  for (const [nodeId, columns] of columnsByNode) {
    setNodeColumns(nodes, nodeId, columns);
  }
}

function resolveColumnReferences(value: unknown, sources: ResolvedSource[]): LineageColumnRef[] {
  const sourceByAlias = new Map<string, ResolvedSource>();
  for (const source of sources) {
    for (const alias of source.aliases) {
      sourceByAlias.set(alias, source);
    }
  }

  const refs: LineageColumnRef[] = [];
  const seen = new Set<string>();
  for (const reference of Array.isArray(value) ? collectColumnReferences(value) : collectColumnReferences(value)) {
    const columnName = reference.column.name;
    if (columnName === '*') {
      continue;
    }

    const namespace = reference.getNamespace();
    const source = namespace ? sourceByAlias.get(namespace) : sources.length === 1 ? sources[0] : null;
    if (!source) {
      continue;
    }

    const key = `${source.node.id}.${columnName}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({
        nodeId: source.node.id,
        columnName,
      });
    }
  }
  return refs;
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

function setNodeColumns(nodes: Map<string, LineageNode>, nodeId: string, columns: Array<string | LineageColumn>): void {
  const node = nodes.get(nodeId);
  if (!node) {
    return;
  }
  const seen = new Set(node.columns.map((column) => column.name));
  const nextColumns = [...node.columns];
  for (const column of columns) {
    const name = typeof column === 'string' ? column : column.name;
    const comments = typeof column === 'string' ? undefined : column.comments;
    const expressionSql = typeof column === 'string' ? undefined : column.expressionSql;
    const upstream = typeof column === 'string' ? undefined : column.upstream;
    if (!seen.has(name)) {
      seen.add(name);
      nextColumns.push({
        id: `${nodeId}.${sanitizeId(name)}`,
        name,
        comments,
        expressionSql,
        upstream,
      });
    } else {
      const existing = nextColumns.find((item) => item.name === name);
      if (existing && upstream && upstream.length > 0) {
        existing.upstream = mergeColumnRefs(existing.upstream ?? [], upstream);
      }
      if (existing && comments && comments.length > 0) {
        existing.comments = mergeComments(existing.comments, comments);
      }
      if (existing && expressionSql) {
        existing.expressionSql = expressionSql;
      }
    }
  }
  node.columns = nextColumns;
}

function formatExpressionSql(value: unknown): string | undefined {
  try {
    const formatted = expressionFormatter.format(value as Parameters<SqlFormatter['format']>[0]).formattedSql.trim();
    return formatted.length > 0 ? formatted : undefined;
  } catch {
    return undefined;
  }
}

function extractSelectItemComments(items: SimpleSelectQuery['selectClause']['items'], index: number): string[] | undefined {
  const item = items[index];
  const nextItem = items[index + 1];
  return mergeComments(
    extractComments(item, item.value, item.identifier, (item as { aliasPositionedComments?: unknown }).aliasPositionedComments),
    extractPositionedComments(nextItem, 'before'),
  );
}

function extractQueryColumnComments(query: unknown): string[] | undefined {
  if (!(query instanceof SimpleSelectQuery)) {
    return undefined;
  }
  const comments = query.selectClause.items.flatMap((_, index) => extractSelectItemComments(query.selectClause.items, index) ?? []);
  return comments.length > 0 ? dedupeComments(comments) : undefined;
}

function extractQueryNodeComments(query: unknown): string[] | undefined {
  return mergeComments(mergeComments(extractComments(query), extractHeaderComments(query)), extractQueryColumnComments(query));
}

function extractCteComments(cte: CommonTable): string[] | undefined {
  return mergeComments(
    extractComments(cte, cte.aliasExpression, cte.aliasExpression?.table),
    extractHeaderComments((cte as { query?: unknown }).query),
  );
}

function extractComments(...values: unknown[]): string[] | undefined {
  const comments: string[] = [];
  for (const value of values) {
    comments.push(...extractLegacyComments(value));
    comments.push(...extractPositionedComments(value));
  }
  return comments.length > 0 ? dedupeComments(comments) : undefined;
}

function extractLegacyComments(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('comments' in value)) {
    return [];
  }
  const comments = (value as { comments?: unknown }).comments;
  return Array.isArray(comments) ? normalizeComments(comments) : [];
}

function extractHeaderComments(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || !('headerComments' in value)) {
    return undefined;
  }
  const comments = (value as { headerComments?: unknown }).headerComments;
  if (!Array.isArray(comments)) {
    return undefined;
  }
  const normalized = normalizeComments(comments);
  return normalized.length > 0 ? normalized : undefined;
}

function extractPositionedComments(value: unknown, position?: 'before' | 'after'): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const positionedComments = Array.isArray(value)
    ? value
    : 'positionedComments' in value
      ? (value as { positionedComments?: unknown }).positionedComments
      : undefined;
  if (!Array.isArray(positionedComments)) {
    return [];
  }

  return positionedComments.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const positioned = item as { comments?: unknown; position?: unknown };
    if (position && positioned.position !== position) {
      return [];
    }
    return Array.isArray(positioned.comments) ? normalizeComments(positioned.comments) : [];
  });
}

function mergeComments(left?: string[], right?: string[]): string[] | undefined {
  const comments = dedupeComments([...(left ?? []), ...(right ?? [])]);
  return comments.length > 0 ? comments : undefined;
}

function normalizeComments(comments: unknown[]): string[] {
  return comments.map((comment) => String(comment).trim()).filter((comment) => comment.length > 0);
}

function dedupeComments(comments: string[]): string[] {
  return [...new Set(comments)];
}

function mergeColumnRefs(left: LineageColumnRef[], right: LineageColumnRef[]): LineageColumnRef[] {
  const merged: LineageColumnRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...left, ...right]) {
    const key = `${ref.nodeId}.${ref.columnName}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
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
