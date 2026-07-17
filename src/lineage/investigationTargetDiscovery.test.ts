import { describe, expect, it } from 'vitest';
import {
  createInvestigationPlanForTarget,
  discoverInvestigationTargets,
  InvestigationTargetSelectionError,
  resolveInvestigationTarget,
} from './investigationTargetDiscovery';

describe('InvestigationTargetDiscoveryV1', () => {
  it('discovers stable output identities and round-trips a selectable target into planning', () => {
    const input = {
      sql: `
        WITH paid AS (
          SELECT customer_id, SUM(amount) AS paid_amount
          FROM payments
          GROUP BY customer_id
        )
        SELECT customer_id, paid_amount FROM paid
      `,
      ddl: [{ filePath: 'schema.sql', sql: 'CREATE TABLE payments (customer_id integer, amount numeric);' }],
    };
    const first = discoverInvestigationTargets(input);
    const second = discoverInvestigationTargets(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      analysis: { analysisMode: 'original', kind: 'investigation-analysis-summary', version: 1 },
      kind: 'investigation-target-discovery',
      version: 1,
    });
    expect(first.targets.map((target) => target.id)).toEqual(first.targets.map((_target, index) => `target:${String(index + 1).padStart(3, '0')}`));
    expect(first.targets.map((target) => target.order)).toEqual(first.targets.map((_target, index) => index));
    expect(first.targets.every((target) => target.identity.column.outputIndex !== undefined)).toBe(true);
    expect(first.targets.every((target) => target.identity.column.selectItemId)).toBe(true);

    const paidAmount = first.targets.find((target) => target.identity.node.id === 'main_output' && target.identity.column.name === 'paid_amount');
    expect(paidAmount).toMatchObject({
      reasons: ['final_output_column', 'syntax_derived_output_identity'],
      selection: { planTarget: { columnName: 'paid_amount', nodeId: 'main_output' }, status: 'selectable' },
    });
    expect(resolveInvestigationTarget(first, paidAmount!.id)).toEqual({ columnName: 'paid_amount', nodeId: 'main_output' });
    expect(createInvestigationPlanForTarget({ ...input, symptom: 'value_too_low' }, paidAmount!.id).target).toEqual({
      columnName: 'paid_amount',
      nodeId: 'main_output',
      symptom: 'value_too_low',
    });
  });

  it('keeps duplicate output names explicit and refuses ambiguous round-trip selection', () => {
    const discovery = discoverInvestigationTargets({ sql: 'SELECT 1 AS repeated, 2 AS repeated' });
    const ambiguous = discovery.targets.filter((target) => target.selection.status === 'ambiguous');

    expect(ambiguous).toHaveLength(2);
    expect(discovery.ambiguities).toEqual([expect.objectContaining({
      code: 'duplicate_output_name',
      columnName: 'repeated',
      nodeId: 'main_output',
      targetIds: ambiguous.map((target) => target.id),
    })]);
    expect(() => resolveInvestigationTarget(discovery, ambiguous[0].id)).toThrow(expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }));
  });

  it('reports schema-free wildcard limits and rejects unknown target ids without guessing', () => {
    const discovery = discoverInvestigationTargets({ sql: 'SELECT source.* FROM source' });

    expect(discovery.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'wildcard_unresolved_without_schema', targetIds: [] }),
    ]));
    expect(() => resolveInvestigationTarget(discovery, 'target:999')).toThrow(InvestigationTargetSelectionError);
    const serialized = JSON.stringify(discovery);
    for (const forbidden of ['bindingValues', 'actualRows', 'rootCause', 'correctedSql', 'corrected_query']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
