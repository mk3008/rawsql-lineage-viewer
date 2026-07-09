import { describe, expect, it } from 'vitest';
import { buildConditionOptimizationViewModel } from './conditionOptimizationViewModel';
import type { ConditionOptimizationReport } from './rawsqlAdapter';

describe('conditionOptimizationViewModel', () => {
  it('groups moved and blocked predicates for the review UI', () => {
    const viewModel = buildConditionOptimizationViewModel(report({
      applied: [
        {
          displaySql: 'cs.status = :customer_status',
          from: 'final SELECT WHERE',
          phaseKind: 'parameter_condition_placement',
          reason: 'All referenced columns resolve to a single direct upstream output.',
          status: 'moved',
          to: 'customer_scope CTE WHERE',
        },
      ],
      skipped: [
        {
          code: 'WINDOW_BOUNDARY',
          displaySql: 'rn = 1',
          reason: 'Predicate crosses WINDOW boundary; moving it may change semantics.',
          status: 'blocked',
        },
      ],
    }));

    expect(viewModel.moved).toHaveLength(1);
    expect(viewModel.blocked).toHaveLength(1);
    expect(viewModel.moved[0]).toMatchObject({
      displaySql: 'cs.status = :customer_status',
      from: 'final SELECT WHERE',
      to: 'customer_scope CTE WHERE',
    });
    expect(viewModel.blocked[0]).toMatchObject({
      code: 'WINDOW_BOUNDARY',
      reason: expect.stringContaining('WINDOW boundary'),
    });
  });

  it('groups debug probes for investigation mode', () => {
    const viewModel = buildConditionOptimizationViewModel(report({
      debugProbes: [
        {
          displaySql: 'o.customer_id = :customer_id',
          probeKind: 'join_equivalence',
          reason: 'JOIN equivalence can be used as an investigation-only source filter probe.',
          status: 'probe',
          target: 'orders',
          to: 'orders',
        },
      ],
    }));

    expect(viewModel.probes).toHaveLength(1);
    expect(viewModel.probes[0]).toMatchObject({
      displaySql: 'o.customer_id = :customer_id',
      probeKind: 'join_equivalence',
      target: 'orders',
    });
  });

  it('keeps skipped debug probes separate from optimization blocks', () => {
    const viewModel = buildConditionOptimizationViewModel(report({
      debugSkippedProbes: [
        {
          code: 'NESTED_QUERY_UNSUPPORTED',
          displaySql: 'exists (select 1 from customer_favorites)',
          reason: 'Probe metadata skips predicates containing nested queries.',
          status: 'blocked',
        },
      ],
    }));

    expect(viewModel.blocked).toHaveLength(0);
    expect(viewModel.skippedProbes).toHaveLength(1);
    expect(viewModel.skippedProbes[0]).toMatchObject({
      code: 'NESTED_QUERY_UNSUPPORTED',
      displaySql: 'exists (select 1 from customer_favorites)',
    });
  });
});

function report(overrides: Partial<ConditionOptimizationReport>): ConditionOptimizationReport {
  return {
    applied: [],
    appliedCount: overrides.applied?.length ?? 0,
    blockedCount: (overrides.skipped?.length ?? 0) + (overrides.errors?.length ?? 0),
    changed: false,
    debugProbeCount: overrides.debugProbes?.length ?? 0,
    debugProbeSkippedCount: overrides.debugSkippedProbes?.length ?? 0,
    debugProbes: [],
    debugSkippedProbes: [],
    enabled: true,
    errorCount: overrides.errors?.length ?? 0,
    errors: [],
    mode: 'optimized',
    ok: true,
    optimizedSql: 'select 1',
    originalSql: 'select 1',
    phases: [],
    skipped: [],
    skippedCount: overrides.skipped?.length ?? 0,
    unchangedAvailable: false,
    unchangedCount: 0,
    warningCount: overrides.warnings?.length ?? 0,
    warnings: [],
    ...overrides,
  };
}
