import { describe, expect, it } from 'vitest';
import type { LineageColumn } from '../domain/lineage';
import { hasColumnCalloutContent, isPassthroughColumn, isSimpleColumnReference, isVisibleGraphColumn } from './columnDisplay';

describe('column display helpers', () => {
  it('detects simple passthrough column references', () => {
    expect(isSimpleColumnReference('customer_id')).toBe(true);
    expect(isSimpleColumnReference('c.customer_id')).toBe(true);
    expect(isSimpleColumnReference('"c"."customer_id"')).toBe(true);
    expect(isSimpleColumnReference('`c`.`customer_id`')).toBe(true);
    expect(isSimpleColumnReference('[c].[customer_id]')).toBe(true);
  });

  it('keeps literals and expressions visible as callout content', () => {
    expect(isSimpleColumnReference('false')).toBe(false);
    expect(isSimpleColumnReference('null')).toBe(false);
    expect(isSimpleColumnReference('c.quantity * c.unit_price')).toBe(false);
    expect(hasColumnCalloutContent(column({ expressionSql: 'false' }))).toBe(true);
    expect(hasColumnCalloutContent(column({ expressionSql: 'c.quantity * c.unit_price' }))).toBe(true);
  });

  it('compresses only uncommented simple derived columns', () => {
    expect(isPassthroughColumn(column({ expressionSql: 'c.customer_id' }))).toBe(true);
    expect(isPassthroughColumn(column({ expressionSql: 'c.customer_id', comments: ['Customer id.'] }))).toBe(false);
    expect(isPassthroughColumn(column({ expressionSql: 'false' }))).toBe(false);
    expect(isPassthroughColumn(column())).toBe(false);
  });

  it('shows only selected output columns in graph node cards', () => {
    expect(isVisibleGraphColumn(column())).toBe(true);
    expect(isVisibleGraphColumn(column({ usage: { role: 'condition', reasons: ['subquery'] } }))).toBe(false);
    expect(isVisibleGraphColumn(column({ outputIndex: 0, selectItemId: 'select-1', usage: { role: 'condition', reasons: ['groupBy'] } }))).toBe(true);
    expect(isVisibleGraphColumn(column({ usage: { role: 'filter', reasons: ['where'] } }))).toBe(false);
    expect(isVisibleGraphColumn(column({ usage: { role: 'unused' } }))).toBe(false);
  });
});

function column(partial: Partial<LineageColumn> = {}): LineageColumn {
  return {
    id: 'column-1',
    name: 'column_1',
    ...partial,
  };
}
