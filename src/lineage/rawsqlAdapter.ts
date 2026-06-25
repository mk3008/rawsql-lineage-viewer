import {
  BinarySelectQuery,
  CTECollector,
  CTEQueryDecomposer,
  ColumnReference,
  CreateTableQuery,
  FunctionSource,
  InsertQuery,
  InlineQuery,
  ParenSource,
  SelectQueryParser,
  SelectValueCollector,
  SimpleSelectQuery,
  SqlParser,
  SqlFormatter,
  SubQuerySource,
  TableSource,
  ValuesQuery,
} from 'rawsql-ts';
import type { CommonTable, JoinClause, SelectQuery, SourceExpression } from 'rawsql-ts';
import type {
  AnalysisWarning,
  LineageColumn,
  LineageCaseRule,
  LineageCondition,
  LineageColumnRef,
  LineageUnresolvedColumnReference,
  LineageColumnUsageReason,
  LineageEdge,
  LineageExpressionTree,
  LineageExpressionInfluence,
  LineageJoinInfluence,
  LineageModel,
  LineageNode,
  LineageScope,
  LineageSourceReference,
} from '../domain/lineage';
import { isSimpleColumnReference } from './columnDisplay';
import { attachNodeDependencyProfiles } from './nodeDependencyProfile';
import type { SchemaFacts } from './schemaFacts';
import { createTableColumnResolver } from './schemaFacts';

export interface ParserAdapterResult {
  lineage: LineageModel;
  parserVersion: string;
}

export interface AnalyzeSqlOptions {
  schemaFacts?: SchemaFacts;
}

const parserVersion = 'rawsql-ts';
const appSqlFormatterOptions = {
  indentSize: 2,
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
  exportComment: 'none',
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
  oneLineMaxLength: 40,
  joinConditionOrderByDeclaration: true,
  orderByDefaultDirectionStyle: 'omit',
  columnAliasStyle: 'explicit',
  constraintStyle: 'postgres',
  identifierEscape: 'none',
  identifierEscapeTarget: 'minimal',
  parameterSymbol: ':',
  parameterStyle: 'original',
  sourceAliasStyle: 'explicit',
  castStyle: 'standard',
} as const;
const expressionFormatterOptions = {
  ...appSqlFormatterOptions,
  sourceAliasStyle: appSqlFormatterOptions.sourceAliasStyle === 'explicit' ? 'as' : appSqlFormatterOptions.sourceAliasStyle,
};
const expressionFormatter = new SqlFormatter(expressionFormatterOptions as unknown as ConstructorParameters<typeof SqlFormatter>[0]);
const nodeSqlFormatter = new SqlFormatter({
  ...appSqlFormatterOptions,
  exportComment: 'full',
  sourceAliasStyle: appSqlFormatterOptions.sourceAliasStyle === 'explicit' ? 'as' : appSqlFormatterOptions.sourceAliasStyle,
  withClauseStyle: 'standard',
} as unknown as ConstructorParameters<typeof SqlFormatter>[0]);

function parseLineageSelectQuery(sql: string): SelectQuery {
  let statement: unknown;
  try {
    statement = SqlParser.parse(sql);
  } catch (error) {
    const wrappedSelectSql = extractWrappedSelectSql(sql);
    if (wrappedSelectSql) {
      return parseLineageSelectQuery(wrappedSelectSql);
    }
    throw error;
  }

  if (statement instanceof CreateTableQuery) {
    if (!statement.asSelectQuery) {
      throw new Error('CREATE TABLE lineage requires an AS SELECT query.');
    }
    return statement.asSelectQuery;
  }

  if (statement instanceof InsertQuery) {
    if (!statement.selectQuery || statement.selectQuery instanceof ValuesQuery) {
      throw new Error('INSERT lineage requires a SELECT query.');
    }
    return statement.selectQuery;
  }

  if (isSelectQuery(statement)) {
    return statement;
  }

  throw new Error('Only SELECT, CREATE TABLE AS SELECT, CREATE VIEW AS SELECT, and INSERT SELECT statements are supported.');
}

function isSelectQuery(value: unknown): value is SelectQuery {
  return value instanceof SimpleSelectQuery || value instanceof BinarySelectQuery || value instanceof ValuesQuery;
}

function extractWrappedSelectSql(sql: string): string | undefined {
  const match = sql.match(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)*create\s+(?:or\s+replace\s+)?(?:(?:temporary|temp)\s+)?(?:(?:materialized)\s+)?(?:table|view)\b[\s\S]*?\bas\s+([\s\S]+?)\s*;?\s*$/i);
  return match?.[1]?.trim();
}

export function analyzeSql(sql: string, options: AnalyzeSqlOptions = {}): ParserAdapterResult {
  const warnings: AnalysisWarning[] = [...(options.schemaFacts?.diagnostics ?? []).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.filePath ? `${diagnostic.message} (${diagnostic.filePath})` : diagnostic.message,
  }))];
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const scopes: LineageScope[] = [];
  const derivedCounter = { value: 0 };
  const scalarSubqueryCounter = { value: 0 };
  const scopeCounter = { value: 0 };

  let query: SelectQuery;
  try {
    query = parseLineageSelectQuery(sql);
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
  const cteExecutableSqlByName = collectCteExecutableSql(query, ctes, warnings, cteCommentsByName);

  for (const cte of ctes) {
    const cteName = cte.getSourceAliasName();
    const nodeId = isParameterSelectQuery(cte.query) ? toParameterTableId(cteName) : toCteId(cteName);
    nodes.set(nodeId, {
      id: nodeId,
      type: isParameterSelectQuery(cte.query) ? 'parameter_table' : 'cte',
      label: cteName,
      columns: [],
      comments: cteCommentsByName.get(cteName),
      cteExecutableSql: cteExecutableSqlByName.get(cteName),
      materializationHint: isParameterSelectQuery(cte.query) ? undefined : normalizeMaterializationHint(cte.materialized),
      querySql: cteExecutableSqlByName.get(cteName),
    });
  }

  for (const cte of ctes) {
    const targetId = isParameterSelectQuery(cte.query) ? toParameterTableId(cte.getSourceAliasName()) : toCteId(cte.getSourceAliasName());
    collectQueryEdges({
      query: cte.query,
      targetId,
      targetLabel: cte.getSourceAliasName(),
      recursiveRootId: targetId,
      cteNames,
      nodes,
      edges,
      scopes,
      warnings,
      derivedCounter,
      scalarSubqueryCounter,
      scopeCounter,
      schemaFacts: options.schemaFacts,
    });
  }

  collectQueryEdges({
    query,
    targetId: 'main_output',
    targetLabel: 'Final Result',
    cteNames,
    nodes,
    edges,
    scopes,
    warnings,
    derivedCounter,
    scalarSubqueryCounter,
    scopeCounter,
    schemaFacts: options.schemaFacts,
  });
  nodes.get('main_output')!.querySql = formatOutputQuerySql(query, cteCommentsByName);

  classifyColumnUsage(nodes);

  const dedupedEdges = dedupeEdges(edges);
  warnings.push(...collectUnusedCteWarnings([...nodes.values()], dedupedEdges));

  const lineage: LineageModel = attachNodeDependencyProfiles({
    kind: 'sql-lineage-model',
    modelVersion: 1,
    nodes: [...nodes.values()],
    edges: dedupedEdges,
    scopes,
    analysisWarnings: warnings,
    raw: {
      adapter: 'rawsql-ts-ast',
    },
  });

  return {
    lineage,
    parserVersion,
  };
}

function collectUnusedCteWarnings(nodes: LineageNode[], edges: LineageEdge[]): AnalysisWarning[] {
  const outputNodeIds = nodes.filter((node) => node.type === 'output').map((node) => node.id);
  const reachableNodeIds = collectUpstreamReachableNodeIds(outputNodeIds, edges);

  return nodes
    .filter((node) => node.type === 'cte' && !reachableNodeIds.has(node.id))
    .map((node) => ({
      code: 'unused_cte',
      message: `CTE "${node.label}" is not reachable from the final output.`,
    }));
}

function collectUpstreamReachableNodeIds(rootNodeIds: string[], edges: LineageEdge[]): Set<string> {
  const reachable = new Set(rootNodeIds);
  const incomingByTarget = new Map<string, LineageEdge[]>();

  for (const edge of edges) {
    if (edge.type !== 'dataFlow' || edge.recursive || edge.source === edge.target) {
      continue;
    }
    incomingByTarget.set(edge.target, [...(incomingByTarget.get(edge.target) ?? []), edge]);
  }

  const queue = [...rootNodeIds];
  while (queue.length > 0) {
    const targetId = queue.shift()!;
    for (const edge of incomingByTarget.get(targetId) ?? []) {
      if (!reachable.has(edge.source)) {
        reachable.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  return reachable;
}

interface CollectQueryEdgesOptions {
  query: unknown;
  targetId: string;
  targetLabel: string;
  recursiveRootId?: string;
  cteNames: Set<string>;
  nodes: Map<string, LineageNode>;
  edges: LineageEdge[];
  scopes: LineageScope[];
  warnings: AnalysisWarning[];
  derivedCounter: { value: number };
  scalarSubqueryCounter: { value: number };
  scopeCounter: { value: number };
  parentScopeId?: string;
  schemaFacts?: SchemaFacts;
}

interface ResolvedSource {
  node: LineageNode;
  aliases: string[];
  sourceAlias?: string;
  recursive?: boolean;
  wildcardPassthroughSource?: {
    aliases: string[];
    node: LineageNode;
    sourceAlias?: string;
  };
}

function collectQueryEdges(options: CollectQueryEdgesOptions): void {
  const { query, targetId, targetLabel, cteNames, nodes, edges, scopes, warnings, derivedCounter, recursiveRootId, parentScopeId } = options;

  if (query instanceof SimpleSelectQuery) {
    const fromClause = query.fromClause;
    const scopeId = nextScopeId(options, targetId);
    if (!fromClause) {
      const outputColumns = collectOutputColumns(query, [], options, scopeId);
      scopes.push(createLineageScope(query, [], [], outputColumns, targetId, targetLabel, scopeId, options, parentScopeId));
      setNodeColumns(nodes, targetId, outputColumns);
      if (nodes.get(targetId)?.type !== 'parameter_table') {
        const parameterSource = createParameterTableNode('parameters', nodes);
        addLineageEdge(edges, {
          source: parameterSource.id,
          target: targetId,
          type: 'dataFlow',
          kind: 'value_flow',
          sourceAlias: 'parameters',
          confidence: 'high',
        });
      }
      return;
    }

    const sources = [
      resolveSourceExpression(fromClause.source, cteNames, nodes, edges, scopes, warnings, derivedCounter, options.scalarSubqueryCounter, options.scopeCounter, recursiveRootId, options.schemaFacts),
    ];
    const joins = fromClause.joins ?? [];

    for (const source of sources) {
      addLineageEdge(edges, {
        source: source.node.id,
        target: targetId,
        type: 'dataFlow',
        kind: nodes.get(targetId)?.type === 'scalar_subquery' ? 'row_source' : 'value_flow',
        sourceAlias: source.sourceAlias,
        recursive: source.recursive ? { reason: 'cteSelfReference' } : undefined,
        confidence: 'high',
      });
    }

    for (const join of joins) {
      const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, scopes, warnings, derivedCounter, options.scalarSubqueryCounter, options.scopeCounter, recursiveRootId, options.schemaFacts);
      const joinType = normalizeJoinType(join);
      sources.push(joinedSource);

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'dataFlow',
        kind: nodes.get(targetId)?.type === 'scalar_subquery' ? 'row_source' : 'value_flow',
        label: normalizeJoinLabel(join),
        sourceAlias: joinedSource.sourceAlias,
        joinNullability: toJoinNullability(joinType),
        recursive: joinedSource.recursive ? { reason: 'cteSelfReference' } : undefined,
        confidence: 'high',
      });
    }

    const outputColumns = collectOutputColumns(query, sources, options, scopeId);
    scopes.push(createLineageScope(query, sources, joins, outputColumns, targetId, targetLabel, scopeId, options, parentScopeId));
    setNodeColumns(nodes, targetId, outputColumns);
    setValueSourceColumns(outputColumns, nodes);
    setReferencedSourceColumns(query, sources, nodes, warnings, scopeId);
    collectNestedConditionLineage(query, options);

    return;
  }

  if (query instanceof BinarySelectQuery) {
    const operator = query.operator.value.toUpperCase();
    const parts = collectBinaryParts(query, operator);
    if (parts.length > 2) {
      const partIds = parts.map((part, index) => collectBinaryPart(part, `part_${index + 1}`, operator, options));
      for (const partId of partIds) {
        addLineageEdge(edges, {
          source: partId,
          target: targetId,
          type: 'dataFlow',
          label: operator,
          confidence: 'medium',
        });
      }
      setNodeColumns(nodes, targetId, collectBinaryOutputColumnsFromParts(query, partIds, nodes));
      return;
    }

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
    setNodeColumns(nodes, targetId, collectBinaryOutputColumns(query, leftId, rightId, nodes));
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
    querySql: formatStandaloneQuerySql(query),
  });
  collectQueryEdges({ ...options, query, targetId: id, targetLabel: `${operator} ${side}`, parentScopeId: options.parentScopeId });
  return id;
}

function collectBinaryParts(query: SelectQuery, operator: string): SelectQuery[] {
  if (query instanceof BinarySelectQuery && query.operator.value.toUpperCase() === operator) {
    return [...collectBinaryParts(query.left, operator), ...collectBinaryParts(query.right, operator)];
  }

  return [query];
}

function collectBinaryOutputColumns(query: BinarySelectQuery, leftId: string, rightId: string, nodes: Map<string, LineageNode>): LineageColumn[] {
  const leftColumns = nodes.get(leftId)?.columns ?? [];
  const rightColumns = nodes.get(rightId)?.columns ?? [];
  const names = collectBinaryOutputColumnNames(query, leftColumns, rightColumns);
  return names.map((name, index) => ({
    id: '',
    name,
    upstream: mergeColumnRefs(
      leftColumns[index] ? [{ nodeId: leftId, columnName: leftColumns[index].name }] : [],
      rightColumns[index] ? [{ nodeId: rightId, columnName: rightColumns[index].name }] : [],
    ),
  }));
}

function collectBinaryOutputColumnsFromParts(query: BinarySelectQuery, partIds: string[], nodes: Map<string, LineageNode>): LineageColumn[] {
  const partColumns = partIds.map((partId) => nodes.get(partId)?.columns ?? []);
  const names = collectQueryOutputColumnNames(query);
  const maxLength = Math.max(names.length, ...partColumns.map((columns) => columns.length));
  return Array.from({ length: maxLength }, (_, index) => {
    const upstream = partIds.flatMap((partId, partIndex) => {
      const column = partColumns[partIndex]?.[index];
      return column ? [{ nodeId: partId, columnName: column.name }] : [];
    });
    return {
      id: '',
      name: names[index] ?? partColumns.find((columns) => columns[index])?.[index]?.name ?? `column_${index + 1}`,
      upstream,
    };
  });
}

function collectBinaryOutputColumnNames(query: BinarySelectQuery, leftColumns: LineageColumn[], rightColumns: LineageColumn[]): string[] {
  const leftNames = collectQueryOutputColumnNames(query.left);
  const rightNames = collectQueryOutputColumnNames(query.right);
  const maxLength = Math.max(leftColumns.length, rightColumns.length, leftNames.length, rightNames.length);
  return Array.from({ length: maxLength }, (_, index) => leftNames[index] ?? rightNames[index] ?? leftColumns[index]?.name ?? rightColumns[index]?.name ?? `column_${index + 1}`);
}

function collectQueryOutputColumnNames(query: unknown): string[] {
  if (query instanceof SimpleSelectQuery) {
    return query.selectClause.items.map((item, index) => getSelectItemOutputName(item, index));
  }

  if (query instanceof BinarySelectQuery) {
    return collectQueryOutputColumnNames(query.left);
  }

  return [];
}

function collectCteExecutableSql(
  query: unknown,
  ctes: CommonTable[],
  warnings: AnalysisWarning[],
  cteCommentsByName: Map<string, string[] | undefined>,
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
  const cteByName = new Map(ctes.map((cte) => [cte.getSourceAliasName(), cte]));
  for (const cte of ctes) {
    const cteName = cte.getSourceAliasName();
    try {
      const result = decomposer.extractCTE(query, cteName);
      sqlByName.set(cteName, formatCteExecutableSql(cteName, result.executableSql, result.dependencies, cteByName, cteCommentsByName));
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

function formatCteExecutableSql(
  cteName: string,
  sql: string,
  dependencies: string[],
  cteByName: Map<string, CommonTable>,
  cteCommentsByName: Map<string, string[] | undefined>,
): string {
  const targetCte = cteByName.get(cteName);
  if (targetCte) {
    const formattedTargetSql = prependHeaderCommentsIfMissing(formatNodeQuerySql(targetCte.query), cteCommentsByName.get(cteName));
    if (formattedTargetSql) {
      const dependencySql = dependencies
        .map((dependencyName) => {
          const dependencyCte = cteByName.get(dependencyName);
          const formattedDependencySql = dependencyCte ? formatNodeQuerySql(dependencyCte.query) : undefined;
          return formattedDependencySql ? { name: dependencyName, sql: formattedDependencySql } : null;
        })
        .filter((dependency): dependency is { name: string; sql: string } => dependency !== null);

      if (dependencySql.length === 0) {
        return formattedTargetSql;
      }

      const withSql = dependencySql
        .map((dependency, index) => {
          const suffix = index === dependencySql.length - 1 ? '' : ',';
          const comments = cteCommentsByName.get(dependency.name)?.filter((comment) => !dependency.sql.includes(comment));
          const commentSql = comments?.length ? `${comments.map((comment) => formatLineComment(comment, '  ')).join('\n')}\n` : '';
          return `${commentSql}  ${dependency.name} as (\n${indentSql(dependency.sql)}\n  )${suffix}`;
        })
        .join('\n');
      return `with\n${withSql}\n${formattedTargetSql}`;
    }
  }

  const trimmedSql = sql.trim();
  try {
    return nodeSqlFormatter.format(SelectQueryParser.parse(trimmedSql)).formattedSql.trim();
  } catch {
    return trimmedSql;
  }
}

function formatNodeQuerySql(query: unknown): string | undefined {
  try {
    return nodeSqlFormatter.format(query as Parameters<SqlFormatter['format']>[0]).formattedSql.trim();
  } catch {
    return undefined;
  }
}

function formatStandaloneQuerySql(query: unknown): string | undefined {
  return prependHeaderCommentsIfMissing(formatNodeQuerySql(query), extractQueryNodeComments(query));
}

function formatScopeQuerySql(query: SimpleSelectQuery): string | undefined {
  return formatStandaloneQuerySql(cloneSelectQueryWithoutCtes(query));
}

function cloneSelectQueryWithoutCtes(query: SimpleSelectQuery): SimpleSelectQuery {
  if (!query.withClause) {
    return query;
  }
  return Object.assign(Object.create(Object.getPrototypeOf(query)), query, {
    cteNameCache: new Set(),
    withClause: undefined,
  }) as SimpleSelectQuery;
}

function formatOutputQuerySql(query: unknown, cteCommentsByName: Map<string, string[] | undefined>): string | undefined {
  const formattedSql = formatNodeQuerySql(query);
  if (!formattedSql || cteCommentsByName.size === 0) {
    return formattedSql;
  }
  return restoreCteHeaderComments(formattedSql, cteCommentsByName);
}

function prependHeaderCommentsIfMissing(sql: string | undefined, comments: string[] | undefined): string | undefined {
  if (!sql || !comments?.length || comments.every((comment) => sql.includes(comment))) {
    return sql;
  }
  const missingComments = comments.filter((comment) => !sql.includes(comment));
  return `${missingComments.map((comment) => formatLineComment(comment, '')).join('\n')}\n${sql}`;
}

function restoreCteHeaderComments(sql: string, cteCommentsByName: Map<string, string[] | undefined>): string {
  let restoredSql = sql;
  for (const [cteName, comments] of cteCommentsByName) {
    if (!comments) {
      continue;
    }
    if (!comments.length || comments.every((comment) => restoredSql.includes(comment))) {
      continue;
    }
    const declarationPattern = new RegExp(`^(\\s*)(${escapeRegExp(cteName)}\\s+as\\s*\\()`, 'im');
    restoredSql = restoredSql.replace(declarationPattern, (_match, indent: string, declaration: string) => {
      const commentSql = comments.map((comment) => formatLineComment(comment, indent)).join('\n');
      return `${commentSql}\n${indent}${declaration}`;
    });
  }
  return restoredSql;
}

function formatLineComment(comment: string, indent: string): string {
  return comment
    .split(/\r?\n/)
    .map((line) => `${indent}-- ${line}`)
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indentSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function resolveSourceExpression(
  source: SourceExpression,
  cteNames: Set<string>,
  nodes: Map<string, LineageNode>,
  edges: LineageEdge[],
  scopes: LineageScope[],
  warnings: AnalysisWarning[],
  derivedCounter: { value: number },
  scalarSubqueryCounter: { value: number },
  scopeCounter: { value: number },
  recursiveRootId?: string,
  schemaFacts?: SchemaFacts,
): ResolvedSource {
  const datasource = source.datasource;

  if (datasource instanceof TableSource) {
    const sourceName = datasource.getSourceName();
    const alias = source.aliasExpression ? source.getAliasName() : null;
    const aliases = alias ? [alias, sourceName] : [sourceName];
    if (cteNames.has(sourceName)) {
      const node = findCteSourceNode(sourceName, nodes);
      const cteId = toCteId(sourceName);
      const recursive = cteId === recursiveRootId;
      if (recursive) {
        node.recursive = true;
      }
      return {
        node,
        aliases,
        sourceAlias: alias ?? undefined,
        recursive,
      };
    }
    if (isDualTableName(sourceName)) {
      const node = createParameterTableNode(sourceName, nodes);
      return {
        node,
        aliases,
        sourceAlias: alias ?? 'dual',
      };
    }
    return {
      node: createTableNode(sourceName, nodes, schemaFacts),
      aliases,
      sourceAlias: alias ?? undefined,
    };
  }

  if (datasource instanceof SubQuerySource) {
    derivedCounter.value += 1;
    const alias = source.getAliasName() ?? `subquery_${derivedCounter.value}`;
    if (isParameterSelectQuery(datasource.query)) {
      const node = createParameterTableNode(alias, nodes);
      node.comments = extractQueryNodeComments(datasource.query);
      node.querySql = formatStandaloneQuerySql(datasource.query);
      collectQueryEdges({
        query: datasource.query,
        targetId: node.id,
        targetLabel: alias,
        cteNames,
        nodes,
        edges,
        scopes,
        warnings,
        derivedCounter,
        scalarSubqueryCounter,
        scopeCounter,
        recursiveRootId,
        parentScopeId: undefined,
        schemaFacts,
      });
      return {
        node,
        aliases: [alias],
        sourceAlias: alias,
      };
    }
    const id = `derived_${sanitizeId(alias)}_${derivedCounter.value}`;
    const node: LineageNode = {
      id,
      type: 'derived',
      label: alias,
      columns: [],
      comments: extractQueryNodeComments(datasource.query),
      querySql: formatStandaloneQuerySql(datasource.query),
    };
    nodes.set(id, node);
    collectQueryEdges({
      query: datasource.query,
      targetId: id,
      targetLabel: alias,
        cteNames,
        nodes,
        edges,
        scopes,
        warnings,
        derivedCounter,
        scalarSubqueryCounter,
        scopeCounter,
        recursiveRootId,
        parentScopeId: undefined,
        schemaFacts,
      });
    const wildcardPassthroughSource = resolveSinglePhysicalWildcardPassthroughSource(datasource.query, cteNames, nodes, schemaFacts);
    return {
      node,
      aliases: [alias],
      sourceAlias: alias,
      wildcardPassthroughSource,
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
      scopes,
      warnings,
      derivedCounter,
      scalarSubqueryCounter,
      scopeCounter,
      recursiveRootId,
      schemaFacts,
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

function resolveSinglePhysicalWildcardPassthroughSource(
  query: unknown,
  cteNames: Set<string>,
  nodes: Map<string, LineageNode>,
  schemaFacts?: SchemaFacts,
): ResolvedSource['wildcardPassthroughSource'] | undefined {
  if (!(query instanceof SimpleSelectQuery) || !query.fromClause || (query.fromClause.joins ?? []).length > 0) {
    return undefined;
  }
  if (!hasWildcardSelectItem(query) || query.selectClause.items.some((item) => !(item.value instanceof ColumnReference && item.value.column.name === '*'))) {
    return undefined;
  }

  const source = query.fromClause.source;
  if (!(source.datasource instanceof TableSource)) {
    return undefined;
  }

  const sourceName = source.datasource.getSourceName();
  if (cteNames.has(sourceName) || isDualTableName(sourceName)) {
    return undefined;
  }

  const alias = source.aliasExpression ? source.getAliasName() : null;
  return {
    aliases: alias ? [alias, sourceName] : [sourceName],
    node: createTableNode(sourceName, nodes, schemaFacts),
    sourceAlias: alias ?? undefined,
  };
}

function nextScopeId(options: CollectQueryEdgesOptions, targetId: string): string {
  const baseId = `scope_${sanitizeId(targetId)}`;
  if (!options.scopes.some((scope) => scope.id === baseId)) {
    return baseId;
  }
  options.scopeCounter.value += 1;
  return `${baseId}_${options.scopeCounter.value}`;
}

function createLineageScope(
  query: SimpleSelectQuery,
  sources: ResolvedSource[],
  joins: JoinClause[],
  outputColumns: LineageColumn[],
  targetId: string,
  targetLabel: string,
  scopeId: string,
  options: CollectQueryEdgesOptions,
  parentScopeId?: string,
): LineageScope {
  const where = collectConditionInfluences(query.whereClause?.condition, 'where', scopeId, sources, ['may_filter_rows'], options);
  const having = collectConditionInfluences(query.havingClause?.condition, 'having', scopeId, sources, ['may_filter_rows'], options);
  const groupBy = collectExpressionInfluences(query.groupByClause?.grouping ?? [], 'group_by', scopeId, sources, ['may_change_grain']);
  const orderBy = collectOrderByInfluences(query.orderByClause?.order ?? [], scopeId, sources, targetId, outputColumns);
  const limit = collectLimitInfluence(query.limitClause, 'limit', scopeId);
  const offset = collectLimitInfluence(query.offsetClause, 'offset', scopeId);
  const joinInfluences = joins
    .map((join, index) => createJoinInfluence(join, sources[index + 1], index, scopeId, sources))
    .filter((join): join is LineageJoinInfluence => join !== null);

  return {
    groupBy,
    having,
    id: scopeId,
    joins: joinInfluences,
    kind: nodeIdToScopeKind(targetId),
    label: `${nodeIdToScopeKind(targetId)}:${targetLabel}`,
    limit,
    nodeId: targetId,
    offset,
    orderBy,
    parentScopeId,
    querySql: formatScopeQuerySql(query),
    where,
  };
}

function nodeIdToScopeKind(nodeId: string): LineageScope['kind'] {
  if (nodeId === 'main_output') {
    return 'select';
  }
  if (nodeId.startsWith('cte_')) {
    return 'cte';
  }
  if (nodeId.startsWith('derived_')) {
    return 'derived';
  }
  if (nodeId.startsWith('scalar_subquery_')) {
    return 'scalar_subquery';
  }
  return 'select';
}

function collectConditionInfluences(
  condition: unknown,
  kind: LineageCondition['kind'],
  scopeId: string,
  sources: ResolvedSource[],
  impact: LineageCondition['impact'],
  options?: CollectQueryEdgesOptions,
): LineageCondition[] {
  if (!condition) {
    return [];
  }

  const conditions = kind === 'where' || kind === 'having' ? splitAndConditions(condition) : [condition];
  const splitStrategy: LineageCondition['splitStrategy'] = conditions.length > 1 ? 'top_level_and' : 'whole_expression';
  return conditions.flatMap((item, index) => {
    const expressionSql = formatExpressionSql(item);
    const references = toSourceReferences(
      mergeColumnRefs(resolveColumnReferences(item, sources), options ? collectNestedQueryReferences(item, options) : []),
      scopeId,
      'row_lineage',
    );
    if (!expressionSql && references.length === 0) {
      return [];
    }
    return [{
      expressionSql: expressionSql ?? 'unknown expression',
      id: `${scopeId}_${kind}_${index + 1}`,
      impact,
      kind,
      references,
      scopeId,
      splitStrategy,
    }];
  });
}

function collectOrderByInfluences(
  orderItems: unknown[],
  scopeId: string,
  sources: ResolvedSource[],
  targetId: string,
  outputColumns: LineageColumn[],
): LineageExpressionInfluence[] {
  return orderItems.flatMap((orderItem, index) => {
    const expression = orderItem && typeof orderItem === 'object' && 'value' in orderItem ? (orderItem as { value?: unknown }).value : orderItem;
    const expressionSql = formatExpressionSql(orderItem) ?? formatExpressionSql(expression);
    const outputRefs = resolveOutputColumnReferences(expression, targetId, outputColumns);
    const sourceRefs = outputRefs.length > 0 ? [] : resolveColumnReferences(expression, sources);
    const references = toSourceReferences(mergeColumnRefs(sourceRefs, outputRefs), scopeId, 'row_lineage');
    if (!expressionSql && references.length === 0) {
      return [];
    }
    return [{
      expressionSql: expressionSql ?? 'unknown order expression',
      id: `${scopeId}_order_by_${index + 1}`,
      impact: ['may_change_order'],
      kind: 'order_by',
      references,
      scopeId,
    }];
  });
}

function collectLimitInfluence(
  clause: unknown,
  kind: 'limit' | 'offset',
  scopeId: string,
): LineageExpressionInfluence | undefined {
  if (!clause) {
    return undefined;
  }
  const expressionSql = formatExpressionSql(clause);
  return {
    expressionSql: expressionSql ?? kind,
    id: `${scopeId}_${kind}_1`,
    impact: ['may_limit_rows'],
    kind,
    references: [],
    scopeId,
  };
}

function resolveOutputColumnReferences(value: unknown, targetId: string, outputColumns: LineageColumn[]): LineageColumnRef[] {
  const outputColumnNames = new Set(outputColumns.map((column) => column.name));
  const refs: LineageColumnRef[] = [];
  const seen = new Set<string>();
  for (const reference of collectColumnReferences(value)) {
    const columnName = reference.column.name;
    if (reference.getNamespace() || !outputColumnNames.has(columnName)) {
      continue;
    }
    const key = `${targetId}.${columnName}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ columnName, nodeId: targetId });
    }
  }
  return refs;
}

function collectNestedQueryReferences(value: unknown, options: CollectQueryEdgesOptions): LineageColumnRef[] {
  const refs: LineageColumnRef[] = [];
  for (const query of collectNestedSimpleSelectQueries(value)) {
    refs.push(...collectQueryLocalReferences(query, options));
  }
  return refs;
}

function collectQueryLocalReferences(query: SimpleSelectQuery, options: CollectQueryEdgesOptions): LineageColumnRef[] {
  const fromClause = query.fromClause;
  if (!fromClause) {
    return [];
  }
  const localEdges: LineageEdge[] = [];
  const sources = [
    resolveSourceExpression(
      fromClause.source,
      options.cteNames,
      options.nodes,
      localEdges,
      options.scopes,
      options.warnings,
      options.derivedCounter,
      options.scalarSubqueryCounter,
      options.scopeCounter,
      options.recursiveRootId,
      options.schemaFacts,
    ),
  ];
  for (const join of fromClause.joins ?? []) {
    sources.push(resolveSourceExpression(
      join.source,
      options.cteNames,
      options.nodes,
      localEdges,
      options.scopes,
      options.warnings,
      options.derivedCounter,
      options.scalarSubqueryCounter,
      options.scopeCounter,
      options.recursiveRootId,
      options.schemaFacts,
    ));
  }
  return resolveColumnReferences(query, sources);
}

function collectExpressionInfluences(
  expressions: unknown[],
  kind: LineageExpressionInfluence['kind'],
  scopeId: string,
  sources: ResolvedSource[],
  impact: LineageExpressionInfluence['impact'],
): LineageExpressionInfluence[] {
  return expressions.flatMap((expression, index) => {
    const expressionSql = formatExpressionSql(expression);
    const references = toSourceReferences(resolveColumnReferences(expression, sources), scopeId, 'row_lineage');
    if (!expressionSql && references.length === 0) {
      return [];
    }
    return [{
      expressionSql: expressionSql ?? 'unknown expression',
      id: `${scopeId}_${kind}_${index + 1}`,
      impact,
      kind,
      references,
      scopeId,
    }];
  });
}

function createJoinInfluence(
  join: JoinClause,
  joinedSource: ResolvedSource | undefined,
  index: number,
  scopeId: string,
  sources: ResolvedSource[],
): LineageJoinInfluence | null {
  const joinType = normalizeJoinType(join);
  const condition = collectConditionInfluences(join.condition, 'join_on', scopeId, sources, joinType === 'inner' ? ['may_filter_rows'] : ['may_null_extend_rows'])[0];
  return {
    condition,
    id: `${scopeId}_join_${index + 1}`,
    impact: joinType === 'inner' ? ['may_filter_rows', 'may_multiply_rows'] : ['may_null_extend_rows', 'may_multiply_rows'],
    joinType,
    references: condition?.references ?? [],
    scopeId,
    sourceNodeId: joinedSource?.node.id ?? 'unknown',
  };
}

function toSourceReferences(
  refs: LineageColumnRef[],
  scopeId: string,
  role: LineageSourceReference['role'],
): LineageSourceReference[] {
  return refs.map((ref) => ({
    columnName: ref.columnName,
    nodeId: ref.nodeId,
    role,
    scopeId,
  }));
}

function collectOutputColumns(query: SimpleSelectQuery, sources: ResolvedSource[], options: CollectQueryEdgesOptions, scopeId: string): LineageColumn[] {
  if (hasWildcardSelectItem(query)) {
    if (options.schemaFacts) {
      const rawsqlColumns = collectRawsqlExpandedSelectColumns(query, sources, options, scopeId);
      if (rawsqlColumns.length > 0) {
        return [...rawsqlColumns, ...collectFilterColumns(query, sources, options, scopeId)];
      }
    }

    const sourceExpandedColumns = collectSourceExpandedSelectColumns(query, sources, options, scopeId);
    if (sourceExpandedColumns.unresolvedWildcardCount === 0) {
      return [...sourceExpandedColumns.columns, ...collectFilterColumns(query, sources, options, scopeId)];
    }

    const rawsqlColumns = options.schemaFacts
      ? []
      : collectRawsqlExpandedSelectColumns(query, sources, options, scopeId);
    return [
      ...(rawsqlColumns.length > 0 ? rawsqlColumns : sourceExpandedColumns.columns),
      ...collectFilterColumns(query, sources, options, scopeId),
    ];
  }

  const selectedColumns: LineageColumn[] = query.selectClause.items.map((item, index) =>
    collectSelectItemOutputColumn(query, item, index, index, sources, options, scopeId),
  );
  backfillWildcardPassthroughColumns(selectedColumns, sources, options.nodes);
  return [...selectedColumns, ...collectFilterColumns(query, sources, options, scopeId)];
}

function backfillWildcardPassthroughColumns(columns: LineageColumn[], sources: ResolvedSource[], nodes: Map<string, LineageNode>): void {
  const sourceByNodeId = new Map(sources.map((source) => [source.node.id, source]));
  for (const column of columns) {
    for (const upstream of column.upstream ?? []) {
      const source = sourceByNodeId.get(upstream.nodeId);
      if (!source?.wildcardPassthroughSource) {
        continue;
      }
      const sourceColumn: LineageColumn = {
        id: '',
        name: upstream.columnName,
        expressionSql: formatWildcardColumnExpressionSql(source.wildcardPassthroughSource, upstream.columnName),
        upstream: [{
          nodeId: source.wildcardPassthroughSource.node.id,
          columnName: upstream.columnName,
        }],
      };
      setNodeColumns(nodes, source.node.id, [sourceColumn]);
      setNodeColumns(nodes, source.wildcardPassthroughSource.node.id, [upstream.columnName]);
    }
  }
}

function collectSelectItemOutputColumn(
  query: SimpleSelectQuery,
  item: SimpleSelectQuery['selectClause']['items'][number],
  itemIndex: number,
  outputIndex: number,
  sources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
  scopeId: string,
): LineageColumn {
  const comments = extractSelectItemComments(query.selectClause.items, itemIndex);
  const caseRules = collectExpressionBreakdownRules(item.value, sources);
  const expressionTree = collectExpressionTree(item.value, sources);
  const name = getSelectItemOutputName(item, outputIndex);
  const scalarSubqueryRefs = collectScalarSubqueryLineage(item.value, name, sources, options, scopeId);
  const resolvedReferences = resolveColumnReferencesWithIssues(item.value, sources, { skipInlineQueries: true });
  const unresolvedUpstream = resolvedReferences.unresolved;
  recordUnresolvedColumnWarnings(options.warnings, unresolvedUpstream, scopeId, name);
  const nestedExpressionRefs = scalarSubqueryRefs.length > 0 ? [] : collectNestedExpressionLineage(item.value, options);
  const scalarTargetRefs = isScalarSubqueryTarget(options)
    ? collectScalarTargetPopulationRefs(query, sources)
    : [];
  const upstream = mergeColumnRefs(
    mergeColumnRefs(scalarSubqueryRefs, resolvedReferences.resolved),
    mergeColumnRefs(nestedExpressionRefs, scalarTargetRefs),
  );
  return {
    id: '',
    name,
    comments,
    caseRules,
    expressionTree,
    expressionSql: formatExpressionSql(item.value),
    outputIndex,
    selectItemId: createSelectItemId(scopeId, outputIndex),
    scopeId,
    upstream,
    unresolvedUpstream: unresolvedUpstream.length > 0 ? unresolvedUpstream : undefined,
    usage: isGroupedSelectItem(item.value, query) ? { role: 'condition', reasons: ['groupBy'] } : undefined,
  };
}

function isScalarSubqueryTarget(options: CollectQueryEdgesOptions): boolean {
  return options.nodes.get(options.targetId)?.type === 'scalar_subquery';
}

function collectScalarTargetPopulationRefs(query: SimpleSelectQuery, sources: ResolvedSource[]): LineageColumnRef[] {
  return collectQueryConditionReferences(query).reduce<LineageColumnRef[]>(
    (refs, item) => mergeColumnRefs(refs, resolveColumnReferences(item.refs, sources)),
    [],
  );
}

function collectSourceExpandedSelectColumns(
  query: SimpleSelectQuery,
  sources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
  scopeId: string,
): { columns: LineageColumn[]; unresolvedWildcardCount: number } {
  const columns: LineageColumn[] = [];
  let outputIndex = 0;
  let unresolvedWildcardCount = 0;

  query.selectClause.items.forEach((item, itemIndex) => {
    if (item.value instanceof ColumnReference && item.value.column.name === '*') {
      const wildcardColumns = expandWildcardFromResolvedSources(item.value, sources, scopeId, outputIndex);
      if (wildcardColumns.length === 0) {
        unresolvedWildcardCount += 1;
        return;
      }
      columns.push(...wildcardColumns);
      outputIndex += wildcardColumns.length;
      return;
    }

    columns.push(collectSelectItemOutputColumn(query, item, itemIndex, outputIndex, sources, options, scopeId));
    outputIndex += 1;
  });

  return { columns, unresolvedWildcardCount };
}

function expandWildcardFromResolvedSources(
  reference: ColumnReference,
  sources: ResolvedSource[],
  scopeId: string,
  startOutputIndex: number,
): LineageColumn[] {
  const qualifier = getWildcardQualifier(reference);
  const matchingSources = qualifier
    ? sources.filter((source) => source.aliases.some((alias) => sameIdentifier(alias, qualifier)))
    : sources;
  let offset = 0;

  return matchingSources.flatMap((source) =>
    source.node.columns
      .filter((column) => !column.usage || column.outputIndex !== undefined)
      .map((column) => {
        const outputIndex = startOutputIndex + offset;
        offset += 1;
        return {
          id: '',
          name: column.name,
          outputIndex,
          selectItemId: createSelectItemId(scopeId, outputIndex),
          scopeId,
          expressionSql: formatWildcardColumnExpressionSql(source, column.name),
          upstream: [{
            nodeId: source.node.id,
            columnName: column.name,
          }],
        };
      }),
  );
}

function formatWildcardColumnExpressionSql(source: ResolvedSource, columnName: string): string {
  const qualifier = source.sourceAlias ?? source.aliases[0];
  return qualifier ? `${qualifier}.${columnName}` : columnName;
}

function collectScalarSubqueryLineage(
  value: unknown,
  ownerOutputColumnName: string,
  outerSources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
  parentScopeId: string,
): LineageColumnRef[] {
  const inlineQueries = collectInlineQueries(value);
  if (inlineQueries.length === 0) {
    return [];
  }
  const isWholeColumnExpression = value instanceof InlineQuery && inlineQueries.length === 1;

  return inlineQueries.flatMap((inlineQuery, index) => {
    const query = inlineQuery.selectQuery;
    if (!isSelectQuery(query)) {
      return [];
    }

    options.scalarSubqueryCounter.value += 1;
    const id = `scalar_subquery_${sanitizeId(ownerOutputColumnName)}_${options.scalarSubqueryCounter.value}`;
    const ownerExpressionRole = isWholeColumnExpression ? 'whole_column' : 'expression_part';
    const ownerExpressionPartIndex = ownerExpressionRole === 'expression_part' ? index + 1 : undefined;
    const label = ownerExpressionRole === 'whole_column'
      ? ownerOutputColumnName
      : `${ownerOutputColumnName}_${ownerExpressionPartIndex}`;
    const outputExpressionSql = getScalarSubqueryOutputExpressionSql(query);
    const correlatedRefs = query instanceof SimpleSelectQuery ? collectCorrelationReferences(query, outerSources, options) : [];

    options.nodes.set(id, {
      id,
      type: 'scalar_subquery',
      label,
      columns: [],
      querySql: formatStandaloneQuerySql(query),
      scalarSubquery: {
        correlated: correlatedRefs.length > 0,
        outputExpressionSql,
        ownerOutputColumnName,
        ownerOutputNodeId: options.targetId,
        ownerExpressionRole,
        ownerExpressionPartIndex,
        parentScopeId,
        sql: formatExpressionSql(inlineQuery),
      },
    });

    collectQueryEdges({
      ...options,
      query,
      targetId: id,
      targetLabel: label,
      parentScopeId,
    });

    addLineageEdge(options.edges, {
      source: id,
      target: options.targetId,
      type: 'dataFlow',
      kind: 'subquery_value',
      confidence: 'high',
    });

    const scalarNode = options.nodes.get(id);
    const scalarScopeId = scalarNode?.dependencyProfile?.scopeIds?.[0] ?? options.scopes.find((scope) => scope.nodeId === id)?.id;
    if (scalarNode?.scalarSubquery && scalarScopeId) {
      scalarNode.scalarSubquery.scopeId = scalarScopeId;
      if (query instanceof SimpleSelectQuery) {
        scalarNode.scalarSubquery.correlationConditions = collectCorrelationConditions(query, outerSources, options, scalarScopeId);
      }
    }

    for (const ref of correlatedRefs) {
      addLineageEdge(options.edges, {
        source: ref.nodeId,
        target: id,
        type: 'dataFlow',
        kind: 'correlation',
        sourceAlias: findSourceAlias(ref.nodeId, outerSources),
        confidence: 'medium',
      });
      setNodeColumns(options.nodes, ref.nodeId, [ref.columnName]);
    }

    const outputColumnName = scalarNode?.columns[0]?.name ?? ownerOutputColumnName;
    return [{ nodeId: id, columnName: outputColumnName, scopeId: scalarScopeId }];
  });
}

function collectInlineQueries(value: unknown): InlineQuery[] {
  const queries: InlineQuery[] = [];
  const visited = new Set<unknown>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (current instanceof InlineQuery) {
      queries.push(current);
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
  return queries;
}

function getScalarSubqueryOutputExpressionSql(query: SelectQuery): string | undefined {
  if (!(query instanceof SimpleSelectQuery)) {
    return formatExpressionSql(query);
  }
  const value = query.selectClause.items[0]?.value;
  return value ? formatExpressionSql(value) : undefined;
}

function collectCorrelationReferences(
  query: SimpleSelectQuery,
  outerSources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
): LineageColumnRef[] {
  const innerSources = collectQuerySourcesForReferenceResolution(query, options);
  if (innerSources.length === 0) {
    return [];
  }

  const localRefs = resolveColumnReferences(query, innerSources);
  const localKeys = new Set(localRefs.map((ref) => `${ref.nodeId}.${ref.columnName}`));
  return resolveColumnReferences(query, outerSources)
    .filter((ref) => !localKeys.has(`${ref.nodeId}.${ref.columnName}`));
}

function collectCorrelationConditions(
  query: SimpleSelectQuery,
  outerSources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
  scopeId: string,
): NonNullable<NonNullable<LineageNode['scalarSubquery']>['correlationConditions']> {
  const innerSources = collectQuerySourcesForReferenceResolution(query, options);
  if (innerSources.length === 0) {
    return [];
  }

  return splitAndConditions(query.whereClause?.condition).flatMap((condition) => {
    const outerRefs = resolveColumnReferences(condition, outerSources);
    if (outerRefs.length === 0) {
      return [];
    }
    const innerRefs = resolveColumnReferences(condition, innerSources);
    return [{
      expressionSql: formatExpressionSql(condition) ?? 'unknown correlation condition',
      references: toSourceReferences(mergeColumnRefs(innerRefs, outerRefs), scopeId, 'row_lineage'),
      scopeId,
    }];
  });
}

function collectQuerySourcesForReferenceResolution(
  query: SimpleSelectQuery,
  options: CollectQueryEdgesOptions,
): ResolvedSource[] {
  const fromClause = query.fromClause;
  if (!fromClause) {
    return [];
  }

  const localEdges: LineageEdge[] = [];
  const innerSources = [
    resolveSourceExpression(
      fromClause.source,
      options.cteNames,
      options.nodes,
      localEdges,
      options.scopes,
      options.warnings,
      options.derivedCounter,
      options.scalarSubqueryCounter,
      options.scopeCounter,
      options.recursiveRootId,
      options.schemaFacts,
    ),
  ];
  for (const join of fromClause.joins ?? []) {
    innerSources.push(resolveSourceExpression(
      join.source,
      options.cteNames,
      options.nodes,
      localEdges,
      options.scopes,
      options.warnings,
      options.derivedCounter,
      options.scalarSubqueryCounter,
      options.scopeCounter,
      options.recursiveRootId,
      options.schemaFacts,
    ));
  }
  return innerSources;
}

function findSourceAlias(nodeId: string, sources: ResolvedSource[]): string | undefined {
  return sources.find((source) => source.node.id === nodeId)?.sourceAlias;
}

function hasWildcardSelectItem(query: SimpleSelectQuery): boolean {
  return query.selectClause.items.some((item) =>
    item.value instanceof ColumnReference && item.value.column.name === '*',
  );
}

function collectRawsqlExpandedSelectColumns(
  query: SimpleSelectQuery,
  sources: ResolvedSource[],
  options: CollectQueryEdgesOptions,
  scopeId: string,
): LineageColumn[] {
  const rawsqlValues = new SelectValueCollector(
    options.schemaFacts ? createTableColumnResolver(options.schemaFacts) : null,
  ).collect(query);
  warnIfRawsqlDedupedWildcardColumns(query, sources, rawsqlValues.map((value) => value.name), options);

  if (rawsqlValues.length === 0) {
    options.warnings.push({
      code: 'wildcard_unresolved_without_schema',
      message: 'Wildcard columns could not be expanded because schema facts were not provided or the source columns are unknown.',
    });
    return [];
  }

  return rawsqlValues.map((value, index) => {
    const upstream = mergeColumnRefs(resolveColumnReferences(value.value, sources), collectNestedExpressionLineage(value.value, options));
    const matchingItem = findSelectItemForRawsqlValue(query, value.value);
    const comments = matchingItem ? extractSelectItemComments(query.selectClause.items, query.selectClause.items.indexOf(matchingItem)) : undefined;
    return {
      id: '',
      name: value.name,
      comments,
      caseRules: collectExpressionBreakdownRules(value.value, sources),
      expressionTree: collectExpressionTree(value.value, sources),
      expressionSql: formatExpressionSql(value.value),
      outputIndex: index,
      selectItemId: createSelectItemId(scopeId, index),
      scopeId,
      upstream,
      usage: matchingItem && isGroupedSelectItem(matchingItem.value, query) ? { role: 'condition', reasons: ['groupBy'] } : undefined,
    };
  });
}

function createSelectItemId(scopeId: string, outputIndex: number): string {
  return `${scopeId}_output_${outputIndex + 1}`;
}

function warnIfRawsqlDedupedWildcardColumns(
  query: SimpleSelectQuery,
  sources: ResolvedSource[],
  rawsqlColumnNames: string[],
  options: CollectQueryEdgesOptions,
): void {
  if (!options.schemaFacts) {
    return;
  }

  const expectedColumns = collectExpectedWildcardColumnNames(query, sources);
  if (expectedColumns.length === 0 || rawsqlColumnNames.length >= expectedColumns.length) {
    return;
  }

  const duplicateNames = [...new Set(expectedColumns.filter((name, index) => expectedColumns.indexOf(name) !== index))];
  if (duplicateNames.length === 0) {
    return;
  }

  options.warnings.push({
    code: 'rawsql_duplicate_output_columns_deduped',
    message: `rawsql-ts returned ${rawsqlColumnNames.length} wildcard output column(s), while schema facts indicate ${expectedColumns.length} source column(s). Duplicate output column name(s) appear to have been deduplicated by rawsql-ts: ${duplicateNames.join(', ')}.`,
  });
}

function collectExpectedWildcardColumnNames(query: SimpleSelectQuery, sources: ResolvedSource[]): string[] {
  return query.selectClause.items.flatMap((item) => {
    if (!(item.value instanceof ColumnReference) || item.value.column.name !== '*') {
      return [];
    }

    const qualifier = getWildcardQualifier(item.value);
    const matchingSources = qualifier
      ? sources.filter((source) => source.aliases.some((alias) => sameIdentifier(alias, qualifier)))
      : sources;
    return matchingSources.flatMap((source) => source.node.columns.map((column) => column.name));
  });
}

function getWildcardQualifier(reference: ColumnReference): string | undefined {
  const namespaces = reference.qualifiedName.namespaces;
  if (!namespaces || namespaces.length === 0) {
    return undefined;
  }
  return namespaces.map((namespace) => namespace.name).join('.');
}

function sameIdentifier(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function findSelectItemForRawsqlValue(
  query: SimpleSelectQuery,
  value: unknown,
): SimpleSelectQuery['selectClause']['items'][number] | undefined {
  const valueSql = formatExpressionSql(value);
  return query.selectClause.items.find((item) =>
    !(item.value instanceof ColumnReference && item.value.column.name === '*')
    && formatExpressionSql(item.value) === valueSql,
  );
}

function collectFilterColumns(query: SimpleSelectQuery, sources: ResolvedSource[], options: CollectQueryEdgesOptions, scopeId: string): LineageColumn[] {
  const whereCondition = query.whereClause?.condition;
  if (!whereCondition) {
    return [];
  }

  return splitAndConditions(whereCondition).flatMap((condition, index) => {
    const upstream = mergeColumnRefs(resolveColumnReferences(condition, sources), collectNestedExpressionLineage(condition, options, 'where'));
    if (upstream.length === 0) {
      return [];
    }

    return [
      {
        id: '',
        name: `condition ${index + 1}`,
        expressionSql: formatExpressionSql(condition),
        scopeId,
        upstream,
        usage: { role: 'filter', reasons: ['where'] },
      },
    ];
  });
}

function splitAndConditions(condition: unknown): unknown[] {
  if (isBinaryExpressionLike(condition) && condition.operator.value.toLowerCase() === 'and') {
    return [...splitAndConditions(condition.left), ...splitAndConditions(condition.right)];
  }
  return [condition];
}

// SQL analysis is owned by rawsql-ts. Wildcard select items are expanded through
// SelectValueCollector above; the lineage adapter only enriches those results
// with scopeId, nodeId/upstream mapping, usage metadata, and diagnostics.

function getSelectItemOutputName(item: SimpleSelectQuery['selectClause']['items'][number], index: number): string {
  if (item.identifier) {
    return item.identifier.name;
  }
  if (item.value instanceof ColumnReference) {
    return item.value.column.name;
  }
  return `expr_${index + 1}`;
}

function collectExpressionBreakdownRules(value: unknown, sources: ResolvedSource[]): LineageCaseRule[] | undefined {
  return collectCaseRules(value, sources);
}

function collectCaseRules(value: unknown, sources: ResolvedSource[]): LineageCaseRule[] | undefined {
  const cases = collectCaseExpressions(value);
  if (cases.length === 0) {
    return undefined;
  }

  const directSingleCase = cases.length === 1 && cases[0] === value;
  const collectedRules = cases.flatMap((caseExpression, caseIndex) => collectCaseExpressionRules(caseExpression, caseIndex, undefined, sources));
  const rules = directSingleCase
    ? collectedRules
    : collectedRules.map((rule, index) => ({
        ...rule,
        caseLabel: `case ${index + 1}`,
      }));
  return rules.length > 0 ? rules : undefined;
}

function collectExpressionTree(value: unknown, sources: ResolvedSource[]): LineageExpressionTree | undefined {
  const upstream = resolveColumnReferences(value, sources);
  if (upstream.length < 2) {
    return undefined;
  }

  const expressionSql = formatExpressionSql(value);
  if (!expressionSql || isSimpleColumnReference(expressionSql)) {
    return undefined;
  }

  return collectExpressionTreeNode(value, sources);
}

function collectExpressionTreeNode(value: unknown, sources: ResolvedSource[]): LineageExpressionTree | undefined {
  if (value instanceof ColumnReference) {
    const refs = resolveColumnReferences(value, sources);
    const sql = formatExpressionSql(value);
    if (refs.length !== 1 || !sql) {
      return undefined;
    }
    return { kind: 'column', ref: refs[0], sql };
  }

  if (isBinaryExpressionLike(value)) {
    const sql = formatExpressionSql(value);
    const operator = value.operator.value;
    const left = collectExpressionTreeNode(value.left, sources);
    const right = collectExpressionTreeNode(value.right, sources);
    const upstream = resolveColumnReferences(value, sources);
    if (!sql || !operator || !left || !right || upstream.length < 2) {
      return undefined;
    }

    return {
      children: [left, right],
      kind: 'operator',
      operator,
      sql,
      upstream,
    };
  }

  return undefined;
}

function isBinaryExpressionLike(value: unknown): value is { left: unknown; operator: { value: string }; right: unknown } {
  return (
    value != null &&
    typeof value === 'object' &&
    'left' in value &&
    'right' in value &&
    'operator' in value &&
    typeof (value as { operator?: { value?: unknown } }).operator?.value === 'string'
  );
}

function collectCaseExpressions(value: unknown): unknown[] {
  const cases: unknown[] = [];
  const visited = new Set<unknown>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (isCaseExpressionLike(current)) {
      cases.push(current);
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
  return cases;
}

function collectCaseExpressionRules(caseExpression: unknown, caseIndex: number, caseLabel: string | undefined, sources: ResolvedSource[]): LineageCaseRule[] {
  if (!isCaseExpressionLike(caseExpression)) {
    return [];
  }

  const condition = caseExpression.condition;
  const switchCase = caseExpression.switchCase;
  const branches = Array.isArray(switchCase?.cases) ? switchCase.cases : [];
  const conditionRefs = condition ? resolveColumnReferences(condition, sources) : [];
  const rules: LineageCaseRule[] = [];

  branches.forEach((branch, branchIndex) => {
    if (!branch || typeof branch !== 'object') {
      return;
    }

    const key = (branch as { key?: unknown }).key;
    const result = (branch as { value?: unknown }).value;
    const conditionSql = formatCaseConditionSql(condition, key);
    const resultSql = formatExpressionSql(result);
    rules.push({
      id: `case_${caseIndex + 1}_when_${branchIndex + 1}`,
      label: conditionSql ? `when ${conditionSql}` : `when ${branchIndex + 1}`,
      caseLabel,
      conditionSql,
      expressionSql: formatCaseRuleDisplaySql(conditionSql, resultSql),
      resultSql,
      conditionUpstream: mergeColumnRefs(conditionRefs, resolveColumnReferences(key, sources)),
      resultUpstream: resolveColumnReferences(result, sources),
    });
  });

  if (switchCase && 'elseValue' in switchCase && switchCase.elseValue) {
    rules.push({
      id: `case_${caseIndex + 1}_else`,
      label: 'else',
      caseLabel,
      expressionSql: formatCaseRuleDisplaySql(undefined, formatExpressionSql(switchCase.elseValue)),
      resultSql: formatExpressionSql(switchCase.elseValue),
      conditionUpstream: [],
      resultUpstream: resolveColumnReferences(switchCase.elseValue, sources),
    });
  }

  return rules;
}

function isCaseExpressionLike(value: unknown): value is { condition?: unknown; switchCase?: { cases?: unknown[]; elseValue?: unknown } } {
  if (!value || typeof value !== 'object' || !('switchCase' in value)) {
    return false;
  }

  const switchCase = (value as { switchCase?: unknown }).switchCase;
  return Boolean(switchCase && typeof switchCase === 'object' && Array.isArray((switchCase as { cases?: unknown }).cases));
}

function formatCaseRuleDisplaySql(conditionSql: string | undefined, resultSql: string | undefined): string {
  if (conditionSql) {
    return resultSql ? `${conditionSql} then ${resultSql}` : conditionSql;
  }

  return resultSql ? `else ${resultSql}` : 'else';
}

function formatCaseConditionSql(condition: unknown, key: unknown): string | undefined {
  const keySql = formatExpressionSql(key);
  if (!condition) {
    return keySql;
  }

  const conditionSql = formatExpressionSql(condition);
  if (!conditionSql || !keySql) {
    return conditionSql ?? keySql;
  }
  return `${conditionSql} = ${keySql}`;
}

function isGroupedSelectItem(value: unknown, query: SimpleSelectQuery): boolean {
  const groupingRefs = collectColumnReferences(query.groupByClause?.grouping ?? []);
  if (groupingRefs.length === 0) {
    return false;
  }
  const valueRefs = collectColumnReferences(value);
  return valueRefs.some((valueRef) =>
    groupingRefs.some((groupRef) => valueRef.column.name === groupRef.column.name && valueRef.getNamespace() === groupRef.getNamespace()),
  );
}

function setReferencedSourceColumns(
  query: SimpleSelectQuery,
  sources: ResolvedSource[],
  nodes: Map<string, LineageNode>,
  warnings: AnalysisWarning[],
  scopeId: string,
): void {
  const references = collectQueryConditionReferences(query);
  for (const { reason, refs } of references) {
    const resolvedReferences = resolveColumnReferencesWithIssues(refs, sources);
    recordUnresolvedColumnWarnings(warnings, resolvedReferences.unresolved, scopeId, `${reason} condition`);
    for (const reference of resolvedReferences.resolved) {
      setNodeColumns(nodes, reference.nodeId, [
        {
          id: '',
          name: reference.columnName,
          usage: { role: 'condition', reasons: [reason] },
        },
      ]);
    }
  }
}

function collectNestedConditionLineage(query: SimpleSelectQuery, options: CollectQueryEdgesOptions): void {
  const conditionExpressions: Array<{ reason: LineageColumnUsageReason; value: unknown }> = [
    { reason: 'join', value: (query.fromClause?.joins ?? []).map((join) => join.condition) },
    { reason: 'where', value: query.whereClause?.condition },
    { reason: 'having', value: query.havingClause?.condition },
    { reason: 'orderBy', value: query.orderByClause?.order ?? [] },
  ];

  for (const { reason, value } of conditionExpressions) {
    for (const nestedQuery of collectNestedSimpleSelectQueries(value)) {
      collectNestedQueryLineage(nestedQuery, options, reason);
    }
  }
}

function setValueSourceColumns(columns: LineageColumn[], nodes: Map<string, LineageNode>): void {
  for (const column of columns) {
    if (column.usage?.role === 'filter') {
      continue;
    }
    for (const upstream of column.upstream ?? []) {
      setNodeColumns(nodes, upstream.nodeId, [upstream.columnName]);
    }
  }
}

function resolveColumnReferences(value: unknown, sources: ResolvedSource[]): LineageColumnRef[] {
  return resolveColumnReferencesWithIssues(value, sources).resolved;
}

function resolveColumnReferencesWithIssues(
  value: unknown,
  sources: ResolvedSource[],
  options: { skipInlineQueries?: boolean } = {},
): { resolved: LineageColumnRef[]; unresolved: LineageUnresolvedColumnReference[] } {
  const sourceByAlias = new Map<string, ResolvedSource>();
  for (const source of sources) {
    for (const alias of source.aliases) {
      sourceByAlias.set(alias, source);
    }
  }

  const resolved: LineageColumnRef[] = [];
  const unresolved: LineageUnresolvedColumnReference[] = [];
  const seen = new Set<string>();
  const seenUnresolved = new Set<string>();
  for (const reference of collectColumnReferences(value, options)) {
    const columnName = reference.column.name;
    if (columnName === '*') {
      continue;
    }

    const namespace = reference.getNamespace();
    const resolution = namespace
      ? { source: sourceByAlias.get(namespace) ?? null, unresolved: sourceByAlias.has(namespace) ? undefined : createUnknownQualifiedSource(reference, sources) }
      : resolveUnqualifiedColumnSourceWithIssue(columnName, reference, sources);
    const source = resolution.source;
    if (!source) {
      const issue = resolution.unresolved;
      if (issue) {
        const key = `${issue.reason}:${issue.qualifier ?? ''}:${issue.columnName}:${issue.candidateNodeIds?.join(',') ?? ''}`;
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolved.push(issue);
        }
      }
      continue;
    }

    const key = `${source.node.id}.${columnName}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({
        nodeId: source.node.id,
        columnName,
      });
    }
  }
  return { resolved, unresolved };
}

function resolveUnqualifiedColumnSourceWithIssue(
  columnName: string,
  reference: ColumnReference | undefined,
  sources: ResolvedSource[],
): { source: ResolvedSource | null; unresolved?: LineageUnresolvedColumnReference } {
  if (sources.length === 1) {
    return { source: sources[0] };
  }

  const candidates = sources.filter((source) => source.node.columns.some((column) => column.name === columnName));
  if (candidates.length === 1) {
    return { source: candidates[0] };
  }

  if (candidates.length > 1) {
    return {
      source: null,
      unresolved: {
        candidateNodeIds: candidates.map((source) => source.node.id),
        columnName,
        reason: 'ambiguous_unqualified_column',
        sql: reference ? (formatExpressionSql(reference) ?? columnName) : columnName,
        suggestion: 'Add a table alias to the column reference so the source is explicit.',
      },
    };
  }

  return {
    source: null,
    unresolved: {
      candidateNodeIds: sources.map((source) => source.node.id),
      columnName,
      reason: 'unknown_unqualified_column',
      sql: reference ? (formatExpressionSql(reference) ?? columnName) : columnName,
      suggestion: sources.some((source) => source.node.type === 'table' && source.node.columns.length === 0)
        ? 'Provide DDL/schema facts, or qualify the column with a table alias if the source is known.'
        : 'Check the column name or qualify it with a table alias.',
    },
  };
}

function createUnknownQualifiedSource(reference: ColumnReference, sources: ResolvedSource[]): LineageUnresolvedColumnReference {
  const qualifier = reference.getNamespace();
  return {
    candidateNodeIds: sources.map((source) => source.node.id),
    columnName: reference.column.name,
    qualifier: qualifier ?? undefined,
    reason: 'unknown_qualified_source',
    sql: formatExpressionSql(reference) ?? reference.column.name,
    suggestion: qualifier
      ? `Alias or source "${qualifier}" is not in scope. Check the FROM/JOIN alias, or add the missing alias.`
      : 'Add a table alias to the column reference.',
  };
}

function recordUnresolvedColumnWarnings(
  warnings: AnalysisWarning[],
  unresolved: LineageUnresolvedColumnReference[],
  scopeId: string,
  outputColumnName: string,
): void {
  for (const item of unresolved) {
    const code = `deadlink_${item.reason}`;
    const message = `Column "${outputColumnName}" has unresolved upstream reference "${item.sql}". ${item.suggestion}`;
    if (!warnings.some((warning) => warning.code === code && warning.message === message && warning.scopeId === scopeId)) {
      warnings.push({
        code,
        message,
        scopeId,
      });
    }
  }
}

function collectQueryConditionReferences(query: SimpleSelectQuery): Array<{ reason: LineageColumnUsageReason; refs: ColumnReference[] }> {
  const outputColumnNames = new Set(query.selectClause.items.map((item, index) => getSelectItemOutputName(item, index)));
  const orderByRefs = collectColumnReferences(query.orderByClause?.order ?? [])
    .filter((reference) => reference.getNamespace() || !outputColumnNames.has(reference.column.name));
  const references: Array<{ reason: LineageColumnUsageReason; refs: ColumnReference[] }> = [
    { reason: 'join', refs: collectColumnReferences((query.fromClause?.joins ?? []).map((join) => join.condition)) },
    { reason: 'where', refs: collectColumnReferences(query.whereClause?.condition) },
    { reason: 'groupBy', refs: collectColumnReferences(query.groupByClause?.grouping ?? []) },
    { reason: 'having', refs: collectColumnReferences(query.havingClause?.condition) },
    { reason: 'orderBy', refs: orderByRefs },
  ];
  return references.filter((item) => item.refs.length > 0);
}

function collectNestedExpressionLineage(
  value: unknown,
  options: CollectQueryEdgesOptions,
  usageReason: LineageColumnUsageReason = 'subquery',
): LineageColumnRef[] {
  const refs: LineageColumnRef[] = [];
  for (const query of collectNestedSimpleSelectQueries(value)) {
    refs.push(...collectNestedQueryLineage(query, options, usageReason));
  }
  return refs;
}

function collectNestedQueryLineage(
  query: SimpleSelectQuery,
  options: CollectQueryEdgesOptions,
  usageReason: LineageColumnUsageReason = 'subquery',
): LineageColumnRef[] {
  const { cteNames, nodes, edges, warnings, derivedCounter, targetId, recursiveRootId } = options;
  const fromClause = query.fromClause;
  if (!fromClause) {
    return [];
  }

  const sources = [resolveSourceExpression(fromClause.source, cteNames, nodes, edges, options.scopes, warnings, derivedCounter, options.scalarSubqueryCounter, options.scopeCounter, recursiveRootId, options.schemaFacts)];
  addLineageEdge(edges, {
    source: sources[0].node.id,
    target: targetId,
    type: 'dataFlow',
    sourceAlias: sources[0].sourceAlias,
    recursive: sources[0].recursive ? { reason: 'cteSelfReference' } : undefined,
    confidence: 'medium',
  });

  for (const join of fromClause.joins ?? []) {
    const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, options.scopes, warnings, derivedCounter, options.scalarSubqueryCounter, options.scopeCounter, recursiveRootId, options.schemaFacts);
    sources.push(joinedSource);
    addLineageEdge(edges, {
      source: joinedSource.node.id,
      target: targetId,
      type: 'dataFlow',
      sourceAlias: joinedSource.sourceAlias,
      joinNullability: toJoinNullability(normalizeJoinType(join)),
      recursive: joinedSource.recursive ? { reason: 'cteSelfReference' } : undefined,
      confidence: 'medium',
    });
  }

  setReferencedSourceColumns(query, sources, nodes, warnings, `scope_${sanitizeId(targetId)}_nested`);
  for (const source of sources) {
    for (const reference of resolveColumnReferences(collectColumnReferences(query.selectClause.items.map((item) => item.value)), sources)) {
      if (reference.nodeId === source.node.id) {
        setNodeColumns(nodes, reference.nodeId, [reference.columnName]);
      }
    }
  }

  const nestedRefs = query.selectClause.items.flatMap((item) => collectNestedExpressionLineage(item.value, options));
  const localRefs = resolveColumnReferences(collectColumnReferences(query), sources);
  for (const ref of localRefs) {
    setNodeColumns(nodes, ref.nodeId, [
      usageReason === 'subquery'
        ? {
            id: '',
            name: ref.columnName,
            usage: { role: 'condition', reasons: [usageReason] },
          }
        : ref.columnName,
    ]);
  }

  return mergeColumnRefs(localRefs, nestedRefs);
}

function collectNestedSimpleSelectQueries(value: unknown): SimpleSelectQuery[] {
  const queries: SimpleSelectQuery[] = [];
  const visited = new Set<unknown>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (current instanceof SimpleSelectQuery) {
      queries.push(current);
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
  return queries;
}

function collectColumnReferences(value: unknown, options: { skipInlineQueries?: boolean } = {}): ColumnReference[] {
  const references: ColumnReference[] = [];
  const visited = new Set<unknown>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (options.skipInlineQueries && current instanceof InlineQuery) {
      return;
    }

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
    const caseRules = typeof column === 'string' ? undefined : column.caseRules;
    const expressionTree = typeof column === 'string' ? undefined : column.expressionTree;
    const expressionSql = typeof column === 'string' ? undefined : column.expressionSql;
    const outputIndex = typeof column === 'string' ? undefined : column.outputIndex;
    const selectItemId = typeof column === 'string' ? undefined : column.selectItemId;
    const scopeId = typeof column === 'string' ? undefined : column.scopeId;
    const upstream = typeof column === 'string' ? undefined : column.upstream;
    const unresolvedUpstream = typeof column === 'string' ? undefined : column.unresolvedUpstream;
    const usage = typeof column === 'string' ? undefined : column.usage;
    if (!seen.has(name)) {
      seen.add(name);
      nextColumns.push({
        id: `${nodeId}.${sanitizeId(name)}`,
        name,
        comments,
        caseRules,
        expressionTree,
        expressionSql,
        outputIndex,
        selectItemId,
        scopeId,
        upstream,
        unresolvedUpstream,
        usage,
      });
    } else {
      const existing = nextColumns.find((item) => item.name === name);
      if (existing && upstream && upstream.length > 0) {
        existing.upstream = mergeColumnRefs(existing.upstream ?? [], upstream);
      }
      if (existing && unresolvedUpstream && unresolvedUpstream.length > 0) {
        existing.unresolvedUpstream = mergeUnresolvedColumnReferences(existing.unresolvedUpstream ?? [], unresolvedUpstream);
      }
      if (existing && comments && comments.length > 0) {
        existing.comments = mergeComments(existing.comments, comments);
      }
      if (existing && caseRules && caseRules.length > 0) {
        existing.caseRules = caseRules;
      }
      if (existing && expressionTree) {
        existing.expressionTree = expressionTree;
      }
      if (existing && expressionSql) {
        existing.expressionSql = expressionSql;
      }
      if (existing && outputIndex !== undefined) {
        existing.outputIndex = outputIndex;
      }
      if (existing && selectItemId) {
        existing.selectItemId = selectItemId;
      }
      if (existing && scopeId) {
        existing.scopeId = scopeId;
      }
      if (existing && usage) {
        existing.usage = mergeColumnUsage(existing.usage, usage);
      }
    }
  }
  node.columns = nextColumns;
}

function classifyColumnUsage(nodes: Map<string, LineageNode>): void {
  const valueUsed = new Set<string>();
  const conditionUsed = new Set<string>();

  for (const node of nodes.values()) {
    for (const column of node.columns) {
      if (column.usage?.role === 'filter') {
        continue;
      }
      for (const upstream of column.upstream ?? []) {
        valueUsed.add(columnKey(upstream.nodeId, upstream.columnName));
      }
      if (column.usage?.role === 'condition') {
        conditionUsed.add(columnKey(node.id, column.name));
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.type === 'output') {
      continue;
    }

    node.columns = node.columns.map((column) => {
      const key = columnKey(node.id, column.name);
      if (column.usage?.role === 'condition' && column.usage.reasons?.includes('subquery') && node.type !== 'table') {
        return column;
      }
      if (valueUsed.has(key)) {
        return { ...column, usage: undefined };
      }
      if (conditionUsed.has(key)) {
        if (node.type === 'table') {
          return { ...column, usage: undefined };
        }
        return {
          ...column,
          usage: {
            role: 'condition',
            reasons: column.usage?.reasons,
          },
        };
      }
      if (node.type !== 'table') {
        return {
          ...column,
          usage: {
            role: 'unused',
          },
        };
      }
      return column;
    });
  }
}

function mergeColumnUsage(left: LineageColumn['usage'], right: LineageColumn['usage']): LineageColumn['usage'] {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.role === 'unused' || right.role === 'unused') {
    return left.role === 'unused' ? left : right;
  }
  if (left.role === 'filter' || right.role === 'filter') {
    return left.role === 'filter' ? left : right;
  }
  if (left.reasons?.includes('groupBy')) {
    return left;
  }
  if (right.reasons?.includes('groupBy')) {
    return right;
  }
  return {
    role: 'condition',
    reasons: dedupeUsageReasons([...(left.reasons ?? []), ...(right.reasons ?? [])]),
  };
}

function dedupeUsageReasons(reasons: LineageColumnUsageReason[]): LineageColumnUsageReason[] {
  return [...new Set(reasons)];
}

function columnKey(nodeId: string, columnName: string): string {
  return `${nodeId}.${columnName}`;
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

function extractQueryNodeComments(query: unknown): string[] | undefined {
  return mergeComments(extractComments(query), extractHeaderComments(query));
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

function mergeUnresolvedColumnReferences(
  left: LineageUnresolvedColumnReference[],
  right: LineageUnresolvedColumnReference[],
): LineageUnresolvedColumnReference[] {
  const merged: LineageUnresolvedColumnReference[] = [];
  const seen = new Set<string>();
  for (const ref of [...left, ...right]) {
    const key = `${ref.reason}:${ref.qualifier ?? ''}:${ref.columnName}:${ref.candidateNodeIds?.join(',') ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

function createTableNode(tableName: string, nodes: Map<string, LineageNode>, schemaFacts?: SchemaFacts): LineageNode {
  const id = toTableId(tableName);
  const existing = nodes.get(id);
  if (existing) {
    if (existing.columns.length === 0) {
      const columnNames = resolveSchemaColumnNames(schemaFacts, tableName);
      if (columnNames.length > 0) {
        setNodeColumns(nodes, existing.id, columnNames);
      }
    }
    return existing;
  }
  const columnNames = resolveSchemaColumnNames(schemaFacts, tableName);
  const node: LineageNode = {
    id,
    type: 'table',
    label: tableName,
    columns: columnNames.length > 0
      ? columnNames.map((name) => ({
          id: `${id}.${sanitizeId(name)}`,
          name,
        }))
      : [],
  };
  nodes.set(id, node);
  return node;
}

function createParameterTableNode(label: string, nodes: Map<string, LineageNode>): LineageNode {
  const normalizedLabel = isDualTableName(label) ? 'dual' : label;
  const id = toParameterTableId(normalizedLabel);
  const existing = nodes.get(id);
  if (existing) {
    return existing;
  }
  const node: LineageNode = {
    id,
    type: 'parameter_table',
    label: normalizedLabel === 'parameters' ? 'Parameters' : normalizedLabel,
    columns: [],
  };
  nodes.set(id, node);
  return node;
}

function resolveSchemaColumnNames(schemaFacts: SchemaFacts | undefined, tableName: string): string[] {
  return schemaFacts ? createTableColumnResolver(schemaFacts)(tableName) : [];
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

function findCteSourceNode(cteName: string, nodes: Map<string, LineageNode>): LineageNode {
  const parameterNode = nodes.get(toParameterTableId(cteName));
  if (parameterNode) {
    return parameterNode;
  }
  return nodes.get(toCteId(cteName)) ?? createCteNode(cteName, nodes);
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
  const baseId = `${edge.source}-${edge.target}`;
  edges.push({
    ...edge,
    id: edges.some((existing) => existing.id === baseId) ? uniqueEdgeId(baseId, edge, edges) : baseId,
  });
}

function uniqueEdgeId(baseId: string, edge: Omit<LineageEdge, 'id'>, edges: LineageEdge[]): string {
  const parts = [edge.type, edge.label, edge.sourceAlias].filter((part): part is string => Boolean(part));
  const suffix = sanitizeId(parts.join('_')) || 'edge';
  let id = `${baseId}-${suffix}`;
  let counter = 2;
  while (edges.some((existing) => existing.id === id)) {
    id = `${baseId}-${suffix}_${counter}`;
    counter += 1;
  }
  return id;
}

function normalizeJoinLabel(join: JoinClause): string {
  const value = join.joinType.value.trim();
  return value.length > 0 ? value.toUpperCase() : 'JOIN';
}

function normalizeJoinType(join: JoinClause): 'inner' | 'left' | 'right' | 'full' | 'unknown' {
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

function toJoinNullability(joinType: ReturnType<typeof normalizeJoinType>): LineageEdge['joinNullability'] {
  if (joinType === 'inner' || joinType === 'unknown') {
    return undefined;
  }
  return {
    reason: 'outerJoin',
    joinType,
  };
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

function toParameterTableId(tableName: string): string {
  return `parameter_${sanitizeId(tableName)}`;
}

function toCteId(cteName: string): string {
  return `cte_${sanitizeId(cteName)}`;
}

function isDualTableName(tableName: string): boolean {
  return tableName.split('.').at(-1)?.toLowerCase() === 'dual';
}

function isParameterSelectQuery(query: unknown): query is SimpleSelectQuery {
  return query instanceof SimpleSelectQuery && !query.fromClause;
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
