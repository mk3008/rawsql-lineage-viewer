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
import type {
  AnalysisWarning,
  LineageColumn,
  LineageCaseRule,
  LineageColumnRef,
  LineageColumnUsageReason,
  LineageEdge,
  LineageModel,
  LineageNode,
} from '../domain/lineage';

export interface ParserAdapterResult {
  lineage: LineageModel;
  parserVersion: string;
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
const expressionLineMaxLength = appSqlFormatterOptions.oneLineMaxLength;
const expressionIndent = ' '.repeat(appSqlFormatterOptions.indentSize);
const expressionFormatterOptions = {
  ...appSqlFormatterOptions,
  sourceAliasStyle: appSqlFormatterOptions.sourceAliasStyle === 'explicit' ? 'as' : appSqlFormatterOptions.sourceAliasStyle,
};
const expressionFormatter = new SqlFormatter(expressionFormatterOptions as unknown as ConstructorParameters<typeof SqlFormatter>[0]);
const cteExecutableSqlFormatter = new SqlFormatter({
  ...appSqlFormatterOptions,
  sourceAliasStyle: appSqlFormatterOptions.sourceAliasStyle === 'explicit' ? 'as' : appSqlFormatterOptions.sourceAliasStyle,
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

  classifyColumnUsage(nodes);

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
      setNodeColumns(nodes, targetId, collectOutputColumns(query, [], options));
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
      const joinType = normalizeJoinType(join);
      sources.push(joinedSource);

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'dataFlow',
        label: normalizeJoinLabel(join),
        sourceAlias: joinedSource.sourceAlias,
        joinNullability: toJoinNullability(joinType),
        confidence: 'high',
      });
    }

    const outputColumns = collectOutputColumns(query, sources, options);
    setNodeColumns(nodes, targetId, outputColumns);
    setValueSourceColumns(outputColumns, nodes);
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
  });
  collectQueryEdges({ ...options, query, targetId: id, targetLabel: `${operator} ${side}` });
  return id;
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

function collectOutputColumns(query: SimpleSelectQuery, sources: ResolvedSource[], options: CollectQueryEdgesOptions): LineageColumn[] {
  return query.selectClause.items.flatMap((item, index) => {
    const wildcardColumns = expandWildcardSelectItem(item, sources);
    if (wildcardColumns) {
      return wildcardColumns;
    }

    const upstream = mergeColumnRefs(resolveColumnReferences(item.value, sources), collectNestedExpressionLineage(item.value, options));
    const comments = extractSelectItemComments(query.selectClause.items, index);
    const caseRules = collectCaseRules(item.value, sources);
    const name = getSelectItemOutputName(item, index);
    return {
      id: '',
      name,
      comments,
      caseRules,
      expressionSql: formatExpressionSql(item.value),
      upstream,
      usage: isGroupedSelectItem(item.value, query) ? { role: 'condition', reasons: ['groupBy'] } : undefined,
    };
  });
}

function expandWildcardSelectItem(item: SimpleSelectQuery['selectClause']['items'][number], sources: ResolvedSource[]): LineageColumn[] | null {
  if (!(item.value instanceof ColumnReference) || item.value.column.name !== '*') {
    return null;
  }

  const namespace = item.value.getNamespace();
  const targetSources = namespace
    ? sources.filter((source) => source.aliases.includes(namespace))
    : sources;
  const columns = targetSources.flatMap((source) =>
    source.node.columns.map((column) => ({
      id: '',
      name: column.name,
      expressionSql: namespace ? `${namespace}.${column.name}` : column.name,
      upstream: [{ nodeId: source.node.id, columnName: column.name }],
    })),
  );

  return columns.length > 0 ? columns : null;
}

function getSelectItemOutputName(item: SimpleSelectQuery['selectClause']['items'][number], index: number): string {
  if (item.identifier) {
    return item.identifier.name;
  }
  if (item.value instanceof ColumnReference) {
    return item.value.column.name;
  }
  return `expr_${index + 1}`;
}

function collectCaseRules(value: unknown, sources: ResolvedSource[]): LineageCaseRule[] | undefined {
  const cases = collectCaseExpressions(value);
  if (cases.length === 0) {
    return undefined;
  }

  const directSingleCase = cases.length === 1 && cases[0] === value;
  const rules = cases.flatMap((caseExpression, caseIndex) => {
    const caseLabel = directSingleCase ? undefined : `case ${caseIndex + 1}`;
    return collectCaseExpressionRules(caseExpression, caseIndex, caseLabel, sources);
  });
  return rules.length > 0 ? rules : undefined;
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
    return resultSql ? `${conditionSql} then\n${expressionIndent}${resultSql}` : conditionSql;
  }

  return resultSql ? `else\n${expressionIndent}${resultSql}` : 'else';
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

function setReferencedSourceColumns(query: SimpleSelectQuery, sources: ResolvedSource[], nodes: Map<string, LineageNode>): void {
  const references = collectQueryConditionReferences(query);
  for (const { reason, refs } of references) {
    for (const reference of resolveColumnReferences(refs, sources)) {
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

function setValueSourceColumns(columns: LineageColumn[], nodes: Map<string, LineageNode>): void {
  for (const column of columns) {
    for (const upstream of column.upstream ?? []) {
      setNodeColumns(nodes, upstream.nodeId, [upstream.columnName]);
    }
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
    const source = namespace ? sourceByAlias.get(namespace) : resolveUnqualifiedColumnSource(columnName, sources);
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

function resolveUnqualifiedColumnSource(columnName: string, sources: ResolvedSource[]): ResolvedSource | null {
  if (sources.length === 1) {
    return sources[0];
  }

  const candidates = sources.filter((source) => source.node.columns.some((column) => column.name === columnName));
  return candidates.length === 1 ? candidates[0] : null;
}

function collectQueryConditionReferences(query: SimpleSelectQuery): Array<{ reason: LineageColumnUsageReason; refs: ColumnReference[] }> {
  const references: Array<{ reason: LineageColumnUsageReason; refs: ColumnReference[] }> = [
    { reason: 'join', refs: collectColumnReferences((query.fromClause?.joins ?? []).map((join) => join.condition)) },
    { reason: 'where', refs: collectColumnReferences(query.whereClause?.condition) },
    { reason: 'groupBy', refs: collectColumnReferences(query.groupByClause?.grouping ?? []) },
    { reason: 'having', refs: collectColumnReferences(query.havingClause?.condition) },
    { reason: 'orderBy', refs: collectColumnReferences(query.orderByClause?.order ?? []) },
  ];
  return references.filter((item) => item.refs.length > 0);
}

function collectNestedExpressionLineage(value: unknown, options: CollectQueryEdgesOptions): LineageColumnRef[] {
  const refs: LineageColumnRef[] = [];
  for (const query of collectNestedSimpleSelectQueries(value)) {
    refs.push(...collectNestedQueryLineage(query, options));
  }
  return refs;
}

function collectNestedQueryLineage(query: SimpleSelectQuery, options: CollectQueryEdgesOptions): LineageColumnRef[] {
  const { cteNames, nodes, edges, warnings, derivedCounter, targetId } = options;
  const fromClause = query.fromClause;
  if (!fromClause) {
    return [];
  }

  const sources = [resolveSourceExpression(fromClause.source, cteNames, nodes, edges, warnings, derivedCounter)];
  addLineageEdge(edges, {
    source: sources[0].node.id,
    target: targetId,
    type: 'dataFlow',
    sourceAlias: sources[0].sourceAlias,
    confidence: 'medium',
  });

  for (const join of fromClause.joins ?? []) {
    const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, warnings, derivedCounter);
    sources.push(joinedSource);
    addLineageEdge(edges, {
      source: joinedSource.node.id,
      target: targetId,
      type: 'dataFlow',
      sourceAlias: joinedSource.sourceAlias,
      joinNullability: toJoinNullability(normalizeJoinType(join)),
      confidence: 'medium',
    });
  }

  setReferencedSourceColumns(query, sources, nodes);
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
      {
        id: '',
        name: ref.columnName,
        usage: { role: 'condition', reasons: ['subquery'] },
      },
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
    const caseRules = typeof column === 'string' ? undefined : column.caseRules;
    const expressionSql = typeof column === 'string' ? undefined : column.expressionSql;
    const upstream = typeof column === 'string' ? undefined : column.upstream;
    const usage = typeof column === 'string' ? undefined : column.usage;
    if (!seen.has(name)) {
      seen.add(name);
      nextColumns.push({
        id: `${nodeId}.${sanitizeId(name)}`,
        name,
        comments,
        caseRules,
        expressionSql,
        upstream,
        usage,
      });
    } else {
      const existing = nextColumns.find((item) => item.name === name);
      if (existing && upstream && upstream.length > 0) {
        existing.upstream = mergeColumnRefs(existing.upstream ?? [], upstream);
      }
      if (existing && comments && comments.length > 0) {
        existing.comments = mergeComments(existing.comments, comments);
      }
      if (existing && caseRules && caseRules.length > 0) {
        existing.caseRules = caseRules;
      }
      if (existing && expressionSql) {
        existing.expressionSql = expressionSql;
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
      if (column.usage?.role === 'condition' && column.usage.reasons?.includes('subquery')) {
        return column;
      }
      if (valueUsed.has(key)) {
        return { ...column, usage: undefined };
      }
      if (conditionUsed.has(key)) {
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
    const wrapped = wrapLongExpressionSql(formatted);
    return wrapped.length > 0 ? wrapped : undefined;
  } catch {
    return undefined;
  }
}

function wrapLongExpressionSql(sql: string): string {
  if (!sql.split('\n').some((line) => line.length > expressionLineMaxLength)) {
    return sql;
  }

  return sql
    .replace(/\bcase\s+when\b/gi, `case\n${expressionIndent}when`)
    .replace(/\s+when\s+/gi, `\n${expressionIndent}when `)
    .replace(/\s+then\s+/gi, ` then\n${expressionIndent}${expressionIndent}`)
    .replace(/\s+else\s+/gi, `\n${expressionIndent}else\n${expressionIndent}${expressionIndent}`)
    .replace(/\s+end\b/gi, '\nend')
    .split('\n')
    .flatMap((line) => wrapExpressionLine(line, expressionLineMaxLength))
    .join('\n');
}

function wrapExpressionLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }

  if (line.includes('--')) {
    return [line];
  }

  const indent = line.match(/^\s*/)?.[0] ?? '';
  const continuationIndent = `${indent}    `;
  const tokens = line.trim().split(/\s+/);
  const lines: string[] = [];
  let current = indent;

  for (const token of tokens) {
    const separator = current.trim().length === 0 ? '' : ' ';
    if (current.length + separator.length + token.length > maxLength && current.trim().length > 0) {
      lines.push(current);
      current = continuationIndent + token;
      continue;
    }

    current += separator + token;
  }

  if (current.trim().length > 0) {
    lines.push(current);
  }

  return lines;
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
    id: `${edge.source}-${edge.target}`,
  });
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
