import { SqlFormatter, SqlParser } from 'rawsql-ts';
import { describe, expect, it } from 'vitest';
import { resolveColumnReferences, resolveColumnReferencesWithIssues } from './resolveColumnReferences';
import type { SourceReferenceTarget } from './sourceReferences.types';

const formatter = new SqlFormatter({
  exportComment: 'none',
  identifierEscape: 'none',
  identifierEscapeTarget: 'minimal',
  keywordCase: 'lower',
  newline: 'lf',
} as unknown as ConstructorParameters<typeof SqlFormatter>[0]);

function parse(sql: string): unknown {
  return SqlParser.parse(sql);
}

function formatExpressionSql(value: unknown): string | undefined {
  try {
    const sql = formatter.format(value as Parameters<SqlFormatter['format']>[0]).formattedSql.trim();
    return sql.length > 0 ? sql : undefined;
  } catch {
    return undefined;
  }
}

describe('resolveColumnReferences', () => {
  it('resolves qualified columns to matching source targets', () => {
    const sources: SourceReferenceTarget[] = [
      { aliases: ['o'], columnNames: ['customer_id'], nodeId: 'table_orders', nodeType: 'table' },
    ];

    expect(resolveColumnReferences(parse('select o.customer_id from orders o'), sources)).toEqual([
      { nodeId: 'table_orders', columnName: 'customer_id' },
    ]);
  });

  it('resolves unqualified columns when exactly one source has the column', () => {
    const sources: SourceReferenceTarget[] = [
      { aliases: ['c'], columnNames: ['id', 'name'], nodeId: 'table_customers', nodeType: 'table' },
      { aliases: ['o'], columnNames: ['customer_id'], nodeId: 'table_orders', nodeType: 'table' },
    ];

    expect(resolveColumnReferences(parse('select name from customers c join orders o on o.customer_id = c.id'), sources)).toEqual([
      { nodeId: 'table_customers', columnName: 'name' },
      { nodeId: 'table_orders', columnName: 'customer_id' },
      { nodeId: 'table_customers', columnName: 'id' },
    ]);
  });

  it('reports ambiguity when unqualified columns match multiple sources', () => {
    const sources: SourceReferenceTarget[] = [
      { aliases: ['c'], columnNames: ['id'], nodeId: 'table_customers', nodeType: 'table' },
      { aliases: ['o'], columnNames: ['id'], nodeId: 'table_orders', nodeType: 'table' },
    ];

    expect(resolveColumnReferencesWithIssues(parse('select id from customers c join orders o on o.id = c.id'), sources, { formatExpressionSql }).unresolved).toEqual([
      expect.objectContaining({
        candidateNodeIds: ['table_customers', 'table_orders'],
        columnName: 'id',
        reason: 'ambiguous_unqualified_column',
      }),
    ]);
  });

  it('reports unknown qualified sources', () => {
    const sources: SourceReferenceTarget[] = [
      { aliases: ['o'], columnNames: ['id'], nodeId: 'table_orders', nodeType: 'table' },
    ];

    expect(resolveColumnReferencesWithIssues(parse('select missing.id from orders o'), sources, { formatExpressionSql }).unresolved).toEqual([
      expect.objectContaining({
        candidateNodeIds: ['table_orders'],
        columnName: 'id',
        qualifier: 'missing',
        reason: 'unknown_qualified_source',
      }),
    ]);
  });

  it('reports unknown columns with schema guidance for empty table targets', () => {
    const sources: SourceReferenceTarget[] = [
      { aliases: ['c'], columnNames: [], nodeId: 'table_customers', nodeType: 'table' },
      { aliases: ['o'], columnNames: ['id'], nodeId: 'table_orders', nodeType: 'table' },
    ];

    const unresolved = resolveColumnReferencesWithIssues(parse('select status from customers c join orders o on o.id = c.id'), sources, { formatExpressionSql }).unresolved;

    expect(unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateNodeIds: ['table_customers', 'table_orders'],
        columnName: 'status',
        reason: 'unknown_unqualified_column',
        suggestion: expect.stringContaining('Provide DDL/schema facts'),
      }),
    ]));
  });

  it('returns empty results when no column references are present', () => {
    expect(resolveColumnReferences(parse('select 1'), [])).toEqual([]);
  });
});
