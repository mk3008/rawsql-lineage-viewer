import { describe, expect, it } from 'vitest';
import type { ColumnDiagnosticPacket } from './diagnostics';
import { diagnosticProblemIntents, problemIntentOptions, symptomEffectMap, symptomMechanismMap } from './problemIntent';
import {
  filterPopulationInfluencesForIntent,
  populationImpactLabelsByNodeIdForIntent,
  rankCandidateConcernsForIntent,
  sourceDataValueLabelsByNodeIdForIntent,
} from './problemIntentViewModel';

describe('problem intent view model', () => {
  it('exposes logic review for GUI while keeping CLI symptoms separate', () => {
    expect(problemIntentOptions).toContain('all_signals');
    expect(problemIntentOptions).toContain('logic_review');
    expect(diagnosticProblemIntents).not.toContain('all_signals');
    expect(diagnosticProblemIntents).not.toContain('logic_review');
    expect(symptomEffectMap.logic_review).toEqual(expect.arrayContaining(['aggregate_expression', 'case_when']));
    expect(symptomMechanismMap.value_too_high).toEqual(expect.arrayContaining(['join', 'group_by', 'aggregate']));
  });

  it('hides population badges in logic review', () => {
    const packet = createPacket();

    expect(populationImpactLabelsByNodeIdForIntent(packet, 'logic_review')).toEqual({});
  });

  it('maps symptom effects to visible population badges', () => {
    const packet = createPacket();

    expect(populationImpactLabelsByNodeIdForIntent(packet, 'all_signals')).toEqual({
      cte_payment_summary: ['Outer Join'],
      table_customers: ['Where'],
      table_orders: ['Join xN'],
      table_payments: ['Limit'],
    });
    expect(populationImpactLabelsByNodeIdForIntent(packet, 'duplicate_rows')).toEqual({
      table_orders: ['Join xN'],
    });
    expect(populationImpactLabelsByNodeIdForIntent(packet, 'missing_rows')).toEqual({
      table_customers: ['Where'],
      table_payments: ['Limit'],
    });
    expect(populationImpactLabelsByNodeIdForIntent(packet, 'value_missing')).toEqual({
      cte_payment_summary: ['Outer Join'],
      table_customers: ['Where'],
      table_payments: ['Limit'],
    });
  });

  it('maps source data concerns to separate source leaf badges', () => {
    const packet = createPacket();
    packet.candidateConcerns.push({
      checkDomains: ['data_condition'],
      confidence: 'possible',
      effects: ['source_data_value'],
      evidence: ['order_items.quantity', 'order_items.unit_price'],
      impact: ['may_change_value'],
      influenceIds: [],
      kind: 'source_data_value',
      mechanisms: [],
      reason: 'Source leaf values may be incorrect.',
      scopeId: 'scope_recent_orders',
      signals: [],
    });
    packet.valueOrigin.sourceLeaves = [
      {
        columnName: 'quantity',
        nodeId: 'table_order_items',
        nodeLabel: 'order_items',
        nodeType: 'table',
        scopeId: 'scope_recent_orders',
      },
      {
        columnName: 'unit_price',
        nodeId: 'table_order_items',
        nodeLabel: 'order_items',
        nodeType: 'table',
        scopeId: 'scope_recent_orders',
      },
    ];

    expect(sourceDataValueLabelsByNodeIdForIntent(packet, 'value_too_high')).toEqual({
      table_order_items: ['Data?'],
    });
    expect(sourceDataValueLabelsByNodeIdForIntent(packet, 'value_too_low')).toEqual({
      table_order_items: ['Data?'],
    });
    expect(sourceDataValueLabelsByNodeIdForIntent(packet, 'all_signals')).toEqual({
      table_order_items: ['Data?'],
    });
    expect(sourceDataValueLabelsByNodeIdForIntent(packet, 'logic_review')).toEqual({});
  });

  it('filters influences and ranks concerns by selected intent without mutating the packet', () => {
    const packet = createPacket();
    const before = JSON.stringify(packet);

    expect(filterPopulationInfluencesForIntent(packet.populationOrigin.influences, 'all_signals').map((item) => item.id)).toEqual(['join-nx', 'where-filter']);
    expect(filterPopulationInfluencesForIntent(packet.populationOrigin.influences, 'logic_review')).toEqual([]);
    expect(filterPopulationInfluencesForIntent(packet.populationOrigin.influences, 'duplicate_rows').map((item) => item.id)).toEqual(['join-nx']);
    expect(rankCandidateConcernsForIntent(packet.candidateConcerns, 'value_missing').map((item) => item.kind)).toEqual(['coalesce']);
    expect(JSON.stringify(packet)).toBe(before);
  });
});

function createPacket(): ColumnDiagnosticPacket {
  return {
    candidateConcerns: [
      {
        checkDomains: ['program_logic'],
        confidence: 'medium',
        effects: ['row_multiplication'],
        evidence: ['orders join'],
        impact: ['may_multiply_rows'],
        influenceIds: ['join-nx'],
        kind: 'join',
        mechanisms: ['join'],
        reason: 'Join can multiply rows.',
        scopeId: 'scope_main',
        signals: ['join_xn'],
      },
      {
        checkDomains: ['program_logic', 'data_condition'],
        confidence: 'medium',
        effects: ['null_replacement'],
        evidence: ['coalesce'],
        impact: ['may_change_value'],
        influenceIds: ['left-null'],
        kind: 'coalesce',
        mechanisms: ['coalesce'],
        reason: 'COALESCE can replace NULL values.',
        scopeId: 'scope_main',
        signals: [],
      },
    ],
    diagnostics: [],
    kind: 'column-diagnostic-packet',
    omittedContext: {
      message: '',
      omittedColumnCount: 0,
      omittedInfluenceCount: 0,
      omittedNodeCount: 0,
    },
    populationOrigin: {
      influences: [
        {
          effects: ['row_multiplication'],
          id: 'join-nx',
          kind: 'join_on',
          mechanism: 'join',
          references: [],
          scopeId: 'scope_main',
          signals: ['join_xn'],
          sourceNodeId: 'table_orders',
        },
        {
          effects: ['row_filter'],
          id: 'where-filter',
          kind: 'where',
          mechanism: 'where',
          references: [],
          scopeId: 'scope_main',
          signals: ['where'],
          sourceNodeId: 'table_customers',
        },
      ],
      nodeImpacts: [
        {
          effects: ['row_multiplication'],
          influenceIds: ['join-nx'],
          nodeId: 'table_orders',
          nodeLabel: 'orders',
          nodeType: 'table',
          role: 'population_only',
          signals: ['join_xn'],
        },
        {
          effects: ['row_filter'],
          influenceIds: ['where-filter'],
          nodeId: 'table_customers',
          nodeLabel: 'customers',
          nodeType: 'table',
          role: 'population_only',
          signals: ['where'],
        },
        {
          effects: ['null_extension'],
          influenceIds: ['left-null'],
          nodeId: 'cte_payment_summary',
          nodeLabel: 'payment_summary',
          nodeType: 'cte',
          role: 'population_and_value',
          signals: ['outer_join'],
        },
        {
          effects: ['output_cap'],
          influenceIds: ['limit'],
          nodeId: 'table_payments',
          nodeLabel: 'payments',
          nodeType: 'table',
          role: 'population_only',
          signals: ['limit'],
        },
      ],
      summary: 'test',
    },
    target: {
      columnName: 'amount',
      nodeId: 'main_output',
      nodeLabel: 'demo',
      nodeType: 'output',
      scopeId: 'scope_main',
    },
    valueOrigin: {
      caseRules: [],
      expressionChain: [],
      expressions: [],
      references: [],
      root: 'main_output.amount',
      scopeChain: [],
      sourceLeaves: [],
      summary: {
        caseRuleCount: 0,
        expressionStepCount: 0,
        intermediateReferenceCount: 0,
        sourceLeafCount: 0,
      },
    },
    version: 1,
    views: {
      valueOriginTree: {
        derivedFrom: 'valueOrigin',
        tree: [],
      },
    },
  };
}
