import { describe, expect, it } from 'vitest';
import { isUnionNode } from './nodeKind';

describe('node kind helpers', () => {
  it('detects union derived nodes by label', () => {
    expect(isUnionNode({ label: 'UNION ALL part_1', type: 'derived' })).toBe(true);
    expect(isUnionNode({ label: 'union part_2', type: 'derived' })).toBe(true);
    expect(isUnionNode({ label: 'UNION ALL part_1', type: 'cte' })).toBe(false);
    expect(isUnionNode({ label: 'orders_subquery', type: 'derived' })).toBe(false);
  });
});
