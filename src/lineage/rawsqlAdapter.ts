import {
  BinarySelectQuery,
  CTECollector,
  CTEQueryDecomposer,
  ColumnReference,
  CreateTableQuery,
  FunctionSource,
  ParenSource,
  SelectQueryParser,
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
  LineageColumnRef,
  LineageColumnUsageReason,
  LineageEdge,
  LineageExpressionTree,
  LineageModel,
  LineageNode,
} from '../domain/lineage';
import { isSimpleColumnReference } from './columnDisplay';

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
  const statement = SqlParser.parse(sql);
  if (statement instanceof CreateTableQuery) {
    if (!statement.asSelectQuery) {
      throw new Error('CREATE TABLE lineage requires an AS SELECT query.');
    }
    return statement.asSelectQuery;
  }

  if (isSelectQuery(statement)) {
    return statement;
  }

  throw new Error('Only SELECT and CREATE TABLE AS SELECT statements are supported.');
}

function isSelectQuery(value: unknown): value is SelectQuery {
  return value instanceof SimpleSelectQuery || value instanceof BinarySelectQuery || value instanceof ValuesQuery;
}

export function analyzeSql(sql: string): ParserAdapterResult {
  const warnings: AnalysisWarning[] = [];
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const derivedCounter = { value: 0 };

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
  const cteExecutableSqlByName = collectCteExecutableSql(query, ctes, warnings);

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
      querySql: cteExecutableSqlByName.get(cteName),
    });
  }

  for (const cte of ctes) {
    collectQueryEdges({
      query: cte.query,
      targetId: toCteId(cte.getSourceAliasName()),
      targetLabel: cte.getSourceAliasName(),
      recursiveRootId: toCteId(cte.getSourceAliasName()),
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
  nodes.get('main_output')!.querySql = formatNodeQuerySql(query);

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
  recursiveRootId?: string;
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
  recursive?: boolean;
}

function collectQueryEdges(options: CollectQueryEdgesOptions): void {
  const { query, targetId, targetLabel, cteNames, nodes, edges, warnings, derivedCounter, recursiveRootId } = options;

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
      resolveSourceExpression(fromClause.source, cteNames, nodes, edges, warnings, derivedCounter, recursiveRootId),
    ];
    const joins = fromClause.joins ?? [];

    for (const source of sources) {
      addLineageEdge(edges, {
        source: source.node.id,
        target: targetId,
        type: 'dataFlow',
        sourceAlias: source.sourceAlias,
        recursive: source.recursive ? { reason: 'cteSelfReference' } : undefined,
        confidence: 'high',
      });
    }

    for (const join of joins) {
      const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, warnings, derivedCounter, recursiveRootId);
      const joinType = normalizeJoinType(join);
      sources.push(joinedSource);

      addLineageEdge(edges, {
        source: joinedSource.node.id,
        target: targetId,
        type: 'dataFlow',
        label: normalizeJoinLabel(join),
        sourceAlias: joinedSource.sourceAlias,
        joinNullability: toJoinNullability(joinType),
        recursive: joinedSource.recursive ? { reason: 'cteSelfReference' } : undefined,
        confidence: 'high',
      });
    }

    const outputColumns = collectOutputColumns(query, sources, options);
    setNodeColumns(nodes, targetId, outputColumns);
    setValueSourceColumns(outputColumns, nodes);
    setReferencedSourceColumns(query, sources, nodes);
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
    querySql: formatNodeQuerySql(query),
  });
  collectQueryEdges({ ...options, query, targetId: id, targetLabel: `${operator} ${side}` });
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
      sqlByName.set(cteName, formatCteExecutableSql(cteName, result.executableSql, result.dependencies, cteByName));
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
): string {
  const targetCte = cteByName.get(cteName);
  if (targetCte) {
    const formattedTargetSql = formatNodeQuerySql(targetCte.query);
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
          return `  ${dependency.name} as (\n${indentSql(dependency.sql)}\n  )${suffix}`;
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
  warnings: AnalysisWarning[],
  derivedCounter: { value: number },
  recursiveRootId?: string,
): ResolvedSource {
  const datasource = source.datasource;

  if (datasource instanceof TableSource) {
    const sourceName = datasource.getSourceName();
    const alias = source.aliasExpression ? source.getAliasName() : null;
    const aliases = alias ? [alias, sourceName] : [sourceName];
    if (cteNames.has(sourceName)) {
      const cteId = toCteId(sourceName);
      const node = nodes.get(cteId) ?? createCteNode(sourceName, nodes);
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
      querySql: formatNodeQuerySql(datasource.query),
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
      recursiveRootId,
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
      recursiveRootId,
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
  const selectedColumns: LineageColumn[] = query.selectClause.items.flatMap((item, index): LineageColumn | LineageColumn[] => {
    const wildcardColumns = expandWildcardSelectItem(item, sources);
    if (wildcardColumns) {
      return wildcardColumns;
    }

    const upstream = mergeColumnRefs(resolveColumnReferences(item.value, sources), collectNestedExpressionLineage(item.value, options));
    const comments = extractSelectItemComments(query.selectClause.items, index);
    const caseRules = collectExpressionBreakdownRules(item.value, sources);
    const expressionTree = collectExpressionTree(item.value, sources);
    const name = getSelectItemOutputName(item, index);
    return {
      id: '',
      name,
      comments,
      caseRules,
      expressionTree,
      expressionSql: formatExpressionSql(item.value),
      upstream,
      usage: isGroupedSelectItem(item.value, query) ? { role: 'condition', reasons: ['groupBy'] } : undefined,
    };
  });
  return [...selectedColumns, ...collectFilterColumns(query, sources, options)];
}

function collectFilterColumns(query: SimpleSelectQuery, sources: ResolvedSource[], options: CollectQueryEdgesOptions): LineageColumn[] {
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

function collectExpressionBreakdownRules(value: unknown, sources: ResolvedSource[]): LineageCaseRule[] | undefined {
  return collectCaseRules(value, sources);
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

function collectExpressionTree(value: unknown, sources: ResolvedSource[]): LineageExpressionTree | undefined {
  const upstream = resolveColumnReferences(value, sources);
  if (upstream.length < 2) {
    return undefined;
  }

  const expressionSql = formatExpressionSql(value);
  if (!expressionSql || isSimpleColumnReference(expressionSql)) {
    return undefined;
  }

  return collectExpressionTreeNode(value, sources) ?? {
    kind: 'expression',
    sql: expressionSql,
    upstream,
  };
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

  const sources = [resolveSourceExpression(fromClause.source, cteNames, nodes, edges, warnings, derivedCounter, recursiveRootId)];
  addLineageEdge(edges, {
    source: sources[0].node.id,
    target: targetId,
    type: 'dataFlow',
    sourceAlias: sources[0].sourceAlias,
    recursive: sources[0].recursive ? { reason: 'cteSelfReference' } : undefined,
    confidence: 'medium',
  });

  for (const join of fromClause.joins ?? []) {
    const joinedSource = resolveSourceExpression(join.source, cteNames, nodes, edges, warnings, derivedCounter, recursiveRootId);
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
    const expressionTree = typeof column === 'string' ? undefined : column.expressionTree;
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
        expressionTree,
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
      if (existing && expressionTree) {
        existing.expressionTree = expressionTree;
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
