import {
  BinarySelectQuery,
  DeleteQuery,
  FunctionCall,
  FunctionSource,
  InlineQuery,
  InsertQuery,
  MergeQuery,
  ParenSource,
  SimpleSelectQuery,
  SqlParser,
  SubQuerySource,
  UpdateQuery,
} from 'rawsql-ts';
import type { FixtureExtractionBlockedCodeV0 } from './fixtureExtractionPlanV0';
import { compareCodeUnits } from './fixtureExtractionPlanV0';

export interface StaticSelectSafetyBlockerV0 {
  readonly code: FixtureExtractionBlockedCodeV0;
  readonly sourcePath: string;
  readonly sourceId: string;
}

export type StaticSelectSafetyResultV0 =
  | { readonly ok: true; readonly statement: SimpleSelectQuery | BinarySelectQuery }
  | { readonly ok: false; readonly blockers: readonly StaticSelectSafetyBlockerV0[] };

const BLOCKED_CODE_RANK: Partial<Record<FixtureExtractionBlockedCodeV0, number>> = {
  SQL_PARSE_UNSUPPORTED: 1,
  DML_STATEMENT_UNSUPPORTED: 2,
  RETURNING_UNSUPPORTED: 3,
  DML_CTE_UNSUPPORTED: 4,
  RECURSIVE_CTE_UNSUPPORTED: 5,
  VOLATILE_SOURCE_UNSUPPORTED: 7,
};

/** Parser-backed recursive preflight. Syntax acceptance is not execution authorization. */
export function inspectStaticSelectSafetyV0(sql: string): StaticSelectSafetyResultV0 {
  let statement: unknown;
  try {
    statement = SqlParser.parse(sql);
  } catch {
    return { ok: false, blockers: [blocker('SQL_PARSE_UNSUPPORTED', 'statement', 'statement:parse')] };
  }

  if (isDml(statement)) {
    const blockers = [blocker('DML_STATEMENT_UNSUPPORTED', 'statement', `statement:${statement.constructor.name}`)];
    if (hasReturning(statement)) blockers.push(blocker('RETURNING_UNSUPPORTED', 'statement.returning', 'statement:returning'));
    return { ok: false, blockers: sortAndDedupe(blockers) };
  }
  if (!(statement instanceof SimpleSelectQuery) && !(statement instanceof BinarySelectQuery)) {
    return { ok: false, blockers: [blocker('SQL_PARSE_UNSUPPORTED', 'statement', 'statement:unsupported')] };
  }

  const blockers: StaticSelectSafetyBlockerV0[] = [];
  visitSelect(statement, 'statement', blockers);
  return blockers.length > 0
    ? { ok: false, blockers: sortAndDedupe(blockers) }
    : { ok: true, statement };
}

function visitSelect(query: SimpleSelectQuery | BinarySelectQuery, path: string, blockers: StaticSelectSafetyBlockerV0[]): void {
  if (query instanceof BinarySelectQuery) {
    visitSelectQueryLike(query.left, `${path}.left`, blockers, false);
    visitSelectQueryLike(query.right, `${path}.right`, blockers, false);
    return;
  }

  if (query.withClause?.recursive) {
    blockers.push(blocker('RECURSIVE_CTE_UNSUPPORTED', `${path}.with`, 'with:recursive'));
  }
  for (const [index, table] of (query.withClause?.tables ?? []).entries()) {
    visitSelectQueryLike(table.query, `${path}.with[${index}]`, blockers, true);
  }
  for (const [index, source] of (query.fromClause?.getSources() ?? []).entries()) {
    const datasource = source.datasource;
    if (datasource instanceof FunctionSource) {
      blockers.push(blocker('VOLATILE_SOURCE_UNSUPPORTED', `${path}.from[${index}]`, 'source:function'));
    } else if (datasource instanceof SubQuerySource) {
      visitSelectQueryLike(datasource.query, `${path}.from[${index}].subquery`, blockers, false);
    } else if (datasource instanceof ParenSource) {
      visitParenSource(datasource, `${path}.from[${index}].paren`, blockers);
    }
  }

  const values = [
    query.selectClause,
    query.whereClause?.condition,
    query.havingClause?.condition,
    ...(query.groupByClause?.grouping ?? []),
    ...(query.orderByClause?.order ?? []),
    ...(query.fromClause?.joins ?? []).map((join) => join.condition),
    query.windowClause,
    query.limitClause?.value,
    query.offsetClause?.value,
    query.fetchClause,
  ];
  values.forEach((value, index) => visitValue(value, `${path}.value[${index}]`, blockers, new Set<object>()));
}

function visitSelectQueryLike(query: unknown, path: string, blockers: StaticSelectSafetyBlockerV0[], cteBody: boolean): void {
  if (isDml(query)) {
    if (hasReturning(query)) blockers.push(blocker('RETURNING_UNSUPPORTED', `${path}.returning`, 'cte:returning'));
    blockers.push(blocker('DML_CTE_UNSUPPORTED', path, `cte:${query.constructor.name}`));
    return;
  }
  if (query instanceof SimpleSelectQuery || query instanceof BinarySelectQuery) {
    visitSelect(query, path, blockers);
    return;
  }
  blockers.push(blocker(cteBody ? 'DML_CTE_UNSUPPORTED' : 'SQL_PARSE_UNSUPPORTED', path, 'query:unsupported'));
}

function visitParenSource(source: ParenSource, path: string, blockers: StaticSelectSafetyBlockerV0[]): void {
  if (source.source instanceof FunctionSource) {
    blockers.push(blocker('VOLATILE_SOURCE_UNSUPPORTED', path, 'source:function'));
  } else if (source.source instanceof SubQuerySource) {
    visitSelectQueryLike(source.source.query, `${path}.subquery`, blockers, false);
  } else if (source.source instanceof ParenSource) {
    visitParenSource(source.source, `${path}.paren`, blockers);
  }
}

function visitValue(value: unknown, path: string, blockers: StaticSelectSafetyBlockerV0[], seen: Set<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof InlineQuery) {
    visitSelectQueryLike(value.selectQuery, `${path}.inline`, blockers, false);
    return;
  }
  if (value instanceof FunctionCall) {
    const functionName = identifierValue(value.name);
    if (!isV0ProvenDeterministicFunction(value, functionName)) {
      blockers.push(blocker(
        'VOLATILE_SOURCE_UNSUPPORTED',
        path,
        isKnownVolatileFunction(functionName) ? 'function:volatile' : 'function:unclassified',
      ));
    }
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) nested.forEach((item, index) => visitValue(item, `${path}[${index}]`, blockers, seen));
    else visitValue(nested, path, blockers, seen);
  }
}

function isV0ProvenDeterministicFunction(call: FunctionCall, name: string): boolean {
  // This is intentionally a narrow V0 capability list, not a general SQL volatility registry.
  return !call.qualifiedName.namespaces?.length
    && ['coalesce', 'count', 'max', 'sum'].includes(name.toLowerCase());
}

function isKnownVolatileFunction(name: string): boolean {
  return ['clock_timestamp', 'gen_random_uuid', 'nextval', 'random', 'set_config', 'timeofday', 'uuid_generate_v4']
    .includes(name.toLowerCase());
}

function identifierValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('name' in value && typeof value.name === 'string') return value.name;
    if ('value' in value && typeof value.value === 'string') return value.value;
  }
  return '';
}

function isDml(value: unknown): value is InsertQuery | UpdateQuery | DeleteQuery | MergeQuery {
  return value instanceof InsertQuery || value instanceof UpdateQuery || value instanceof DeleteQuery || value instanceof MergeQuery;
}

function hasReturning(value: InsertQuery | UpdateQuery | DeleteQuery | MergeQuery): boolean {
  return Boolean(value.returningClause);
}

function blocker(code: FixtureExtractionBlockedCodeV0, sourcePath: string, sourceId: string): StaticSelectSafetyBlockerV0 {
  return { code, sourcePath, sourceId };
}

function sortAndDedupe(blockers: StaticSelectSafetyBlockerV0[]): StaticSelectSafetyBlockerV0[] {
  const unique = new Map(blockers.map((item) => [`${item.code}\u0000${item.sourcePath}\u0000${item.sourceId}`, item]));
  return [...unique.values()].sort((left, right) =>
    (BLOCKED_CODE_RANK[left.code] ?? Number.MAX_SAFE_INTEGER) - (BLOCKED_CODE_RANK[right.code] ?? Number.MAX_SAFE_INTEGER)
      || compareCodeUnits(left.sourcePath, right.sourcePath)
      || compareCodeUnits(left.sourceId, right.sourceId));
}
