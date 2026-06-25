import { describe, expect, it } from 'vitest';
import { mergeColumnRefs } from './mergeColumnRefs';

describe('mergeColumnRefs', () => {
  it('deduplicates refs with the same source and column', () => {
    expect(mergeColumnRefs(
      [{ nodeId: 'table_orders', columnName: 'customer_id' }],
      [{ nodeId: 'table_orders', columnName: 'customer_id' }],
    )).toEqual([
      { nodeId: 'table_orders', columnName: 'customer_id' },
    ]);
  });

  it('preserves different refs', () => {
    expect(mergeColumnRefs(
      [{ nodeId: 'table_orders', columnName: 'customer_id' }],
      [{ nodeId: 'table_customers', columnName: 'id' }],
    )).toEqual([
      { nodeId: 'table_orders', columnName: 'customer_id' },
      { nodeId: 'table_customers', columnName: 'id' },
    ]);
  });

  it('keeps first-seen order stable while removing later duplicates', () => {
    expect(mergeColumnRefs(
      [
        { nodeId: 'table_orders', columnName: 'customer_id' },
        { nodeId: 'table_customers', columnName: 'id' },
      ],
      [
        { nodeId: 'table_orders', columnName: 'customer_id' },
        { nodeId: 'table_payments', columnName: 'order_id' },
      ],
    )).toEqual([
      { nodeId: 'table_orders', columnName: 'customer_id' },
      { nodeId: 'table_customers', columnName: 'id' },
      { nodeId: 'table_payments', columnName: 'order_id' },
    ]);
  });

  it('returns an empty array for empty inputs', () => {
    expect(mergeColumnRefs([], [])).toEqual([]);
  });
});
