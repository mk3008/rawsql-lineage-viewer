import { BinarySelectQuery, DeleteQuery, InsertQuery, MergeQuery, SimpleSelectQuery, SqlParser, UpdateQuery } from 'rawsql-ts';
import { describe, expect, it } from 'vitest';
import type { InvestigationNodeQueryContextV1, InvestigationParameterDefinitionInputV1, InvestigationPlannerParametersV1, InvestigationPlanV1 } from './investigationPlan';
import type { ColumnDiagnosticPacket } from './diagnostics';
import { createInvestigationPlan, createInvestigationPlanFromDiagnosticPacket } from './investigationPlan';
import { analyzeSql } from './rawsqlAdapter';

const opaqueBinding = 'opaque-binding-sentinel';

function parameterInput(
  definitions: InvestigationParameterDefinitionInputV1[],
  providedNames: string[] = [],
): InvestigationPlannerParametersV1 {
  return { definitions, ...(providedNames.length > 0 ? { bindingPresence: { providedNames } } : {}) };
}

function expectCompleteInterpretation(plan: Pick<InvestigationPlanV1, 'blockedProbes' | 'candidateConcerns' | 'deferredProbes' | 'recommendedProbes'>): void {
  const concernIds = new Set(plan.candidateConcerns.map((concern) => concern.id));
  for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
    expect(probe.interpretation.version).toBe(1);
    expect(probe.interpretation.expectedColumns.length).toBeGreaterThan(0);
    expect(probe.interpretation.assumptions.length).toBeGreaterThan(0);
    expect(probe.interpretation.doesNotProve.length).toBeGreaterThan(0);
    expect(probe.interpretation.nextEvidence.length).toBeGreaterThan(0);
    expect(probe.interpretation.supportsCandidateConcernIds.length).toBeGreaterThan(0);
    expect(probe.interpretation.weakensCandidateConcernIds.length).toBeGreaterThan(0);
    expect(probe.interpretation.inconclusiveHandling.conditions.length).toBeGreaterThan(0);
    expect(probe.interpretation.inconclusiveHandling.nextEvidence.length).toBeGreaterThan(0);
    expect(new Set(probe.interpretation.observationRules.map((rule) => rule.outcome))).toEqual(new Set(['supports', 'weakens', 'inconclusive']));
    expect(probe.interpretation.observationRules.every((rule) => rule.candidateConcernIds.length > 0)).toBe(true);
    expect(probe.interpretation.observationRules.filter((rule) => rule.outcome === 'inconclusive').every((rule) => probe.interpretation.inconclusiveHandling.conditions.includes(rule.condition))).toBe(true);
    for (const referencedId of [
      ...probe.interpretation.supportsCandidateConcernIds,
      ...probe.interpretation.weakensCandidateConcernIds,
      ...probe.interpretation.observationRules.flatMap((rule) => rule.candidateConcernIds),
    ]) {
      expect(concernIds.has(referencedId)).toBe(true);
    }
  }
  expect(plan.blockedProbes.every((probe) => !Object.prototype.hasOwnProperty.call(probe, 'interpretation'))).toBe(true);
}

function packet(overrides: Partial<ColumnDiagnosticPacket> = {}): ColumnDiagnosticPacket {
  return {
    candidateConcerns: [{ checkDomains: ['data_condition'], confidence: 'possible', effects: ['row_filter'], evidence: ['status = :status'], impact: ['may_filter_rows'], influenceIds: ['influence:where'], kind: 'where', mechanisms: ['where'], reason: 'The WHERE predicate may exclude rows.', scopeId: 'scope:orders', signals: ['where'] }],
    columnLineage: { caseRules: [], expressionChain: [], expressions: [], references: [], root: 'orders.status', scopeChain: [], sourceLeaves: [{ columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', nodeType: 'table', scopeId: 'scope:orders' }], summary: { caseRuleCount: 0, expressionStepCount: 0, intermediateReferenceCount: 0, sourceLeafCount: 1 } },
    diagnostics: [], kind: 'column-diagnostic-packet', omittedContext: { message: '', omittedColumnCount: 0, omittedInfluenceCount: 0, omittedNodeCount: 0 },
    rowLineage: { influences: [{ effects: ['row_filter'], expressionSql: 'status = :status', id: 'influence:where', kind: 'where', mechanism: 'where', references: [{ columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', roles: ['row_lineage'], scopeId: 'scope:orders', usages: [{ role: 'row_lineage', scopeId: 'scope:orders', usageKind: 'where' }] }], signals: ['where'], scopeId: 'scope:orders' }], nodeImpacts: [], summary: '' },
    target: { columnName: 'status', nodeId: 'table:orders', nodeLabel: 'orders', nodeType: 'table', scopeId: 'scope:orders' }, version: 1, views: { columnLineageTree: { derivedFrom: 'columnLineage', tree: [] } },
    ...overrides,
  };
}

describe('createInvestigationPlan', () => {
  it('is deterministic and analyzes only the original diagnostic packet', () => {
    const input = { sql: 'SELECT o.status FROM orders o WHERE o.status = :status', target: { columnName: 'status', nodeId: 'main_output' }, symptom: 'missing_rows' as const, parameters: parameterInput([{ name: 'status', origin: 'original_query_parameter', required: true }], ['status']) };
    const plan = createInvestigationPlan(input);
    expect(plan).toEqual(createInvestigationPlan(input));
    expect(JSON.stringify(plan)).toBe(JSON.stringify(createInvestigationPlan(input)));
    expect(plan.analysisMode).toBe('original');
    expect(plan.originalQuery).toEqual({ artifactKind: 'original_query', sql: input.sql });
    expect([...plan.recommendedProbes, ...plan.deferredProbes].every((probe) => probe.artifactKind === 'investigation_probe')).toBe(true);
    for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
      expect(probe.staticSafetyEvidence).toMatchObject({ basis: 'parser_ast', confidence: 'syntax_only', statementClassification: 'select_statement', version: 1 });
      expect(probe.staticSafetyEvidence.assumptions.length).toBeGreaterThan(0);
      expect(probe.staticSafetyEvidence.executionCaveats.length).toBeGreaterThan(0);
    }
    expectCompleteInterpretation(plan);
    expect(plan.diagnostics[0].code).toBe('original_sql_only');
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('equivalent_rewrite');
    expect(serialized).not.toContain('corrected_query');
    expect(serialized).not.toContain('readOnly');
    expect(serialized).not.toContain(opaqueBinding);
    expect(serialized).not.toContain('rootCause');
    for (const forbiddenRuntimeField of ['actualRows', 'observedRows', 'bindingValues', 'causalVerdict', 'correctedSql']) {
      expect(serialized).not.toContain(forbiddenRuntimeField);
    }
  });

  it('preserves the supplied symptom on the investigation target and defaults deterministically', () => {
    const base = { sql: 'SELECT status FROM orders WHERE status IS NOT NULL', target: { columnName: 'status', nodeId: 'main_output' } };
    expect(createInvestigationPlan({ ...base, symptom: 'missing_rows' }).target.symptom).toBe('missing_rows');
    expect(createInvestigationPlan(base).target.symptom).toBe('logic_review');
  });

  it('lists static relation, condition, and matching-record facts for a blocked correlated EXISTS without exposing values or SQL', () => {
    const plan = createInvestigationPlan({
      sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id AND f.is_active = :is_active)',
      target: { columnName: 'id', nodeId: 'main_output' },
      symptom: 'missing_rows',
      parameters: parameterInput([{ name: 'is_active', origin: 'original_query_parameter' }], ['is_active']),
    });
    const checklist = plan.nextEvidenceChecklist;
    const property = checklist.find((item) => item.kind === 'property');

    expect(plan.blockedProbes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_CONCERN_KIND', status: 'blocked' }),
    ]));
    expect(checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({
        condition: expect.objectContaining({ kind: 'where', mechanism: 'exists' }),
        kind: 'condition',
        status: 'to_verify',
      }),
      expect.objectContaining({
        kind: 'relation',
        relation: expect.objectContaining({ nodeId: 'table_customers', relationName: 'customers', columnNames: expect.arrayContaining(['id']) }),
      }),
      expect.objectContaining({
        kind: 'relation',
        relation: expect.objectContaining({ nodeId: 'table_customer_favorites', relationName: 'customer_favorites', columnNames: expect.arrayContaining(['customer_id', 'is_active']) }),
      }),
    ]));
    expect(checklist.find((item) => item.kind === 'condition')?.condition).toMatchObject({
      candidateConcernIds: ['concern:where-exists:01'],
      influenceId: expect.any(String),
    });
    expect(checklist.filter((item) => item.kind === 'relation').map((item) => item.relation.conditionIds)).toEqual([
      ['next-evidence:condition:01'],
      ['next-evidence:condition:01'],
    ]);
    expect(property).toMatchObject({
      kind: 'property',
      property: {
        anchorRelationNodeIds: ['table_customers'],
        kind: 'matching_related_record',
        relatedRelationNodeIds: ['table_customer_favorites'],
      },
      status: 'to_verify',
    });
    expect(JSON.stringify(checklist)).not.toContain('SELECT');
    expect(createInvestigationPlan({
      sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id AND f.is_active = :is_active)',
      target: { columnName: 'id', nodeId: 'main_output' },
      symptom: 'missing_rows',
      parameters: parameterInput([{ name: 'is_active', origin: 'original_query_parameter' }], ['is_active']),
    }).nextEvidenceChecklist).toEqual(checklist);
  });

  it('classifies positive and negative existence with correlated and uncorrelated relation roles', () => {
    const cases = [
      {
        sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: ['table_customers'],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id)',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
        anchor: ['table_customers'],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE customer_id > 0)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_favorites f WHERE customer_id > 0)',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
        anchor: [],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE f.is_active = :active)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites c WHERE c.customer_id > 0)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_favorites c WHERE c.customer_id > 0)',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
        anchor: [],
        related: ['table_customer_favorites'],
      },
      {
        sql: 'SELECT customers.id FROM customers WHERE EXISTS (SELECT 1 FROM customers WHERE customers.id > 0)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_customers'],
      },
      {
        sql: 'SELECT customers.id FROM customers WHERE NOT EXISTS (SELECT 1 FROM customers WHERE customers.id > 0)',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
        anchor: [],
        related: ['table_customers'],
      },
      {
        sql: 'SELECT customers.id FROM orders customers WHERE EXISTS (SELECT 1 FROM public.customers f WHERE customers.id = f.id)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: ['table_orders'],
        related: ['table_public_customers'],
      },
      {
        sql: 'SELECT customers.id FROM orders customers WHERE EXISTS (SELECT 1 FROM public.customers WHERE customers.id > 0)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_public_customers'],
      },
      {
        sql: 'SELECT customers.id FROM orders customers WHERE NOT EXISTS (SELECT 1 FROM public.customers WHERE customers.id > 0)',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
        anchor: [],
        related: ['table_public_customers'],
      },
      {
        sql: 'SELECT orders.id FROM orders WHERE EXISTS (SELECT 1 FROM public.customers WHERE public.customers.id > 0)',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
        anchor: [],
        related: ['table_public_customers'],
      },
    ] as const;

    for (const testCase of cases) {
      const plan = createInvestigationPlan({
        sql: testCase.sql,
        target: { columnName: 'id', nodeId: 'main_output' },
        parameters: parameterInput([{ name: 'active', origin: 'original_query_parameter' }], ['active']),
      });
      const condition = plan.nextEvidenceChecklist.find((item) => item.kind === 'condition');
      const property = plan.nextEvidenceChecklist.find((item) => item.kind === 'property');
      expect(condition).toMatchObject({ condition: { mechanism: testCase.mechanism } });
      expect(property).toMatchObject({
        property: {
          anchorRelationNodeIds: testCase.anchor,
          kind: testCase.propertyKind,
          relatedRelationNodeIds: testCase.related,
        },
      });
      expect(JSON.stringify(plan.nextEvidenceChecklist)).not.toContain('SELECT');
      expect(plan).toEqual(createInvestigationPlan({
        sql: testCase.sql,
        target: { columnName: 'id', nodeId: 'main_output' },
        parameters: parameterInput([{ name: 'active', origin: 'original_query_parameter' }], ['active']),
      }));
    }
  });

  it('preserves proven polarity through neutral parentheses and split predicates, but rejects comparison wrappers safely', () => {
    const classified = [
      {
        sql: 'SELECT c.id FROM customers c WHERE (EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id))',
        mechanism: 'exists',
        propertyKind: 'matching_related_record',
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE true AND (NOT EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id))',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
      },
      {
        sql: 'SELECT c.id FROM customers c WHERE NOT (EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id))',
        mechanism: 'not_exists',
        propertyKind: 'no_matching_related_record',
      },
    ] as const;
    for (const testCase of classified) {
      const plan = createInvestigationPlan({ sql: testCase.sql, target: { columnName: 'id', nodeId: 'main_output' } });
      expect(plan.nextEvidenceChecklist.find((item) => item.kind === 'condition')).toMatchObject({ condition: { mechanism: testCase.mechanism } });
      expect(plan.nextEvidenceChecklist.find((item) => item.kind === 'property')).toMatchObject({ property: { kind: testCase.propertyKind } });
    }

    for (const sql of [
      'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id) = false',
      'SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_favorites f WHERE f.customer_id = c.id) = false',
    ]) {
      const plan = createInvestigationPlan({ sql, target: { columnName: 'id', nodeId: 'main_output' } });
      expect(plan.nextEvidenceChecklist.some((item) => item.kind === 'property')).toBe(false);
      expect(plan.nextEvidenceChecklist.filter((item) => item.kind === 'condition').every((item) => item.condition.mechanism === 'where')).toBe(true);
    }
  });

  it('links shared conditions to every source concern and relation to its condition items deterministically', () => {
    const first = packet();
    const secondInfluence: typeof first.rowLineage.influences[number] = {
      ...first.rowLineage.influences[0],
      id: 'influence:join',
      kind: 'join' as const,
      mechanism: 'join' as const,
      references: [{ ...first.rowLineage.influences[0].references[0], nodeId: 'table:customers', nodeLabel: 'customers', columnName: 'id', scopeId: 'scope:customers-subquery' }],
    };
    const concerns = [
      { ...first.candidateConcerns[0], evidence: ['status = :status'], influenceIds: ['influence:where', 'influence:join'] },
      { ...first.candidateConcerns[0], evidence: ['status = :other_status'], influenceIds: ['influence:where'] },
    ];
    const plan = createInvestigationPlanFromDiagnosticPacket({
      ...first,
      candidateConcerns: concerns,
      rowLineage: { ...first.rowLineage, influences: [...first.rowLineage.influences, secondInfluence] },
    });
    expect(plan.candidateConcerns.map((concern) => concern.id)).toEqual(['concern:where:01', 'concern:where:02']);
    expect(plan.nextEvidenceChecklist.filter((item) => item.kind === 'condition').map((item) => ({ id: item.id, concernIds: item.condition.candidateConcernIds }))).toEqual([
      { id: 'next-evidence:condition:01', concernIds: ['concern:where:02'] },
      { id: 'next-evidence:condition:02', concernIds: ['concern:where:01', 'concern:where:02'] },
    ]);
    expect(plan.nextEvidenceChecklist.filter((item) => item.kind === 'relation').map((item) => ({ nodeId: item.relation.nodeId, conditionIds: item.relation.conditionIds }))).toEqual([
      { nodeId: 'table:customers', conditionIds: ['next-evidence:condition:01'] },
      { nodeId: 'table:orders', conditionIds: ['next-evidence:condition:02'] },
    ]);
    expect(createInvestigationPlanFromDiagnosticPacket({
      ...first,
      candidateConcerns: [...concerns].reverse(),
      rowLineage: { ...first.rowLineage, influences: [...first.rowLineage.influences, secondInfluence] },
    })).toMatchObject({ candidateConcerns: plan.candidateConcerns, nextEvidenceChecklist: plan.nextEvidenceChecklist });
    expect(JSON.stringify(plan.nextEvidenceChecklist)).not.toContain('status =');
  });

  it('uses submitted SQL and parser-backed fragments for syntax-classified SELECT probes without inlining values', () => {
    const plan = createInvestigationPlan({ sql: 'SELECT status FROM orders WHERE status IS NOT NULL', target: { columnName: 'status', nodeId: 'main_output' }, parameters: parameterInput([{ name: 'status', origin: 'original_query_parameter' }], ['status']) });
    expect(plan.originalQuery).toEqual({ artifactKind: 'original_query', sql: 'SELECT status FROM orders WHERE status IS NOT NULL' });
    expect(plan.recommendedProbes).toHaveLength(1);
    expect(plan.recommendedProbes[0]).toMatchObject({
      artifactKind: 'investigation_probe',
      interpretation: {
        expectedCardinality: 'exactly_one_row',
        expectedColumns: [{ name: 'candidate_rows', role: 'aggregate_count', type: 'integer' }],
        observationRules: expect.arrayContaining([
          expect.objectContaining({ condition: 'candidate_rows_below_accepted_baseline', outcome: 'supports' }),
          expect.objectContaining({ condition: 'candidate_rows_at_or_above_accepted_baseline', outcome: 'weakens' }),
          expect.objectContaining({ condition: 'comparable_baseline_unavailable_or_shape_invalid', outcome: 'inconclusive' }),
        ]),
        supportsCandidateConcernIds: ['concern:where:01'],
        version: 1,
        weakensCandidateConcernIds: ['concern:where:01'],
      },
      sql: 'SELECT COUNT(*) AS candidate_rows FROM orders WHERE (status is not null)',
      staticSafetyEvidence: {
        assumptions: expect.arrayContaining([expect.any(String)]),
        basis: 'parser_ast',
        confidence: 'syntax_only',
        executionCaveats: expect.arrayContaining(['This static classification does not authorize execution.']),
        statementClassification: 'select_statement',
        version: 1,
      },
    });
    for (const probe of plan.recommendedProbes) {
      expect(() => analyzeSql(probe.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
    }
  });

  it('derives candidate probe definitions from completed SQL while preserving binding status and unresolved placeholders', () => {
    const candidate = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: 'status = :status AND tenant_id = :tenant_id AND status = :status' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(candidate, parameterInput([{ name: 'status', origin: 'original_query_parameter' }], ['status']));
    const probe = plan.recommendedProbes.find((item) => item.kind === 'candidate_row_count');

    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['status', 'tenant_id']);
    expect(probe?.parameters.find((parameter) => parameter.name === 'status')).toMatchObject({ origin: 'original_query_parameter', status: 'provided' });
    expect(probe?.parameters.find((parameter) => parameter.name === 'status')).not.toHaveProperty('value');
    expect(probe?.parameters.find((parameter) => parameter.name === 'tenant_id')).toMatchObject({ origin: 'unresolved_parameter', status: 'unresolved' });
    expect(plan.parameters.find((parameter) => parameter.name === 'tenant_id')?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
  });

  it('keeps parameter origins separate and marks absent required bindings unresolved', () => {
    const plan = createInvestigationPlan({ sql: 'SELECT o.status FROM orders o WHERE o.status = :status', target: { columnName: 'status', nodeId: 'main_output' }, parameters: parameterInput([
      { name: 'status', origin: 'original_query_parameter' },
      { name: 'customer_id', origin: 'investigation_key', required: true },
      { name: 'start_date', origin: 'derived_parameter' },
      { name: 'database_timezone', origin: 'environment_parameter' },
    ], ['status', 'start_date']) });
    expect(plan.parameters.map((item) => item.origin)).toEqual(['derived_parameter', 'environment_parameter', 'original_query_parameter', 'unresolved_parameter']);
    expect(plan.unresolvedParameters).toMatchObject([{ name: 'customer_id', status: 'unresolved' }]);
  });

  it('blocks a probe when a usable source relation is unavailable', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(packet({ columnLineage: { ...packet().columnLineage, sourceLeaves: [] } }));
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'UNSUITABLE_PROBE_SOURCE', status: 'blocked' }]);
    expect(plan.limitations).toEqual(expect.arrayContaining([{ code: 'unsuitable_probe_source', message: expect.any(String) }]));
    expectCompleteInterpretation(plan);
  });

  it('limits recommendations to three deterministic probes', () => {
    const concerns = ['where', 'where', 'where', 'where'].map((kind, index) => ({
      ...packet().candidateConcerns[0], evidence: [`status = :status_${index}`], kind, scopeId: `scope:${kind}`,
    }));
    const plan = createInvestigationPlanFromDiagnosticPacket(packet({ candidateConcerns: concerns }));
    expect(plan.recommendedProbes).toHaveLength(3);
    expect(plan.deferredProbes).toHaveLength(1);
    expect(plan.recommendedProbes.every((probe) => probe.sql.startsWith('SELECT '))).toBe(true);
    for (const probe of [...plan.recommendedProbes, ...plan.deferredProbes]) {
      expect(probe.artifactKind).toBe('investigation_probe');
      expect(() => analyzeSql(probe.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
    }
    expectCompleteInterpretation(plan);
  });

  it('sorts all successful probes before splitting recommendations, including the node-query probe', () => {
    const base = nodeQueryPacket();
    const concerns = ['zeta', 'beta', 'alpha'].map((scopeId, index) => ({
      ...base.candidateConcerns[0],
      evidence: [`status = :status_${index}`],
      scopeId: `scope:${scopeId}`,
    }));
    const context = contextFor('SELECT customer_id, status FROM orders WHERE status = :status', [
      { name: 'customer_id', outputIndex: 0 }, { name: 'status', outputIndex: 1 },
    ]);
    const plan = createInvestigationPlanFromDiagnosticPacket(
      { ...base, candidateConcerns: concerns },
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']),
      'value_too_low',
      context,
    );

    expect(plan.recommendedProbes.map((probe) => probe.kind)).toEqual(['node_query_outer_filter', 'candidate_row_count', 'candidate_row_count']);
    expect(plan.deferredProbes.map((probe) => probe.kind)).toEqual(['candidate_row_count']);
    expect([...plan.recommendedProbes, ...plan.deferredProbes].map((probe) => [probe.priority, probe.kind, probe.nodeId, probe.id])).toEqual([
      [1, 'node_query_outer_filter', 'main_output', 'probe:node-query-outer-filter:01'],
      [1, 'candidate_row_count', 'table:orders', 'probe:where:01'],
      [2, 'candidate_row_count', 'table:orders', 'probe:where:02'],
      [3, 'candidate_row_count', 'table:orders', 'probe:where:03'],
    ]);
  });

  it('keeps the sorted recommendation result independent of candidate input order and excludes blocked probes', () => {
    const base = packet();
    const whereConcerns = ['c', 'a', 'b', 'd'].map((scopeId, index) => ({
      ...base.candidateConcerns[0], evidence: [`status = :status_${index}`], scopeId: `scope:${scopeId}`,
    }));
    const blockedConcern = { ...base.candidateConcerns[0], kind: 'join_on' as const, influenceIds: ['influence:join'], scopeId: 'scope:blocked' };
    const makePlan = (candidateConcerns: typeof whereConcerns) => createInvestigationPlanFromDiagnosticPacket(packet({ candidateConcerns: [...candidateConcerns, blockedConcern] }));
    const forward = makePlan(whereConcerns);
    const reverse = makePlan([...whereConcerns].reverse());

    expect(forward.recommendedProbes).toHaveLength(3);
    expect(forward.blockedProbes).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_CONCERN_KIND' }));
    expect(forward.recommendedProbes.map((probe) => probe.id)).toEqual(reverse.recommendedProbes.map((probe) => probe.id));
    expect(forward.deferredProbes.map((probe) => probe.id)).toEqual(reverse.deferredProbes.map((probe) => probe.id));
    expect([...forward.recommendedProbes, ...forward.deferredProbes].map((probe) => probe.priority)).toEqual([2, 3, 4, 5]);
  });

  it('never interpolates prose or unsafe candidate evidence into probe SQL', () => {
    const unsafePacket = packet({
      candidateConcerns: [{ ...packet().candidateConcerns[0], evidence: ['This is prose; DROP TABLE orders;'] }],
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(unsafePacket);
    expect(plan.recommendedProbes[0].sql).toBe('SELECT COUNT(*) AS candidate_rows FROM orders WHERE (status = :status)');
    expect(plan.recommendedProbes[0].sql).not.toContain('DROP TABLE');
    expect(plan.recommendedProbes[0].sql).not.toContain('This is prose');
  });

  it('blocks when only diagnostic evidence exists without a parser-backed predicate', () => {
    const missingFragmentPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: undefined }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(missingFragmentPacket);
    expect(plan.blockedProbes).toMatchObject([{ code: 'SAFE_PROBE_FRAGMENT_UNAVAILABLE', status: 'blocked' }]);
  });

  it('blocks an ON/join concern instead of embedding it in a WHERE probe', () => {
    const joinPacket = packet({
      candidateConcerns: [{ ...packet().candidateConcerns[0], kind: 'join_on', influenceIds: ['influence:join'] }],
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], id: 'influence:join', kind: 'join_on', mechanism: 'join', expressionSql: 'orders.customer_id = customers.id' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(joinPacket);
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'UNSUPPORTED_CONCERN_KIND', status: 'blocked' }]);
  });

  it('blocks an alias-qualified WHERE predicate when the alias cannot be reconstructed', () => {
    const aliasPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: 'o.status IS NOT NULL' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(aliasPacket);
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toMatchObject([{ code: 'ALIAS_MAPPING_UNAVAILABLE', status: 'blocked' }]);
  });

  it('wraps a proven selected node query with an explicitly supplied investigation key without changing its SQL', () => {
    const query = 'SELECT p.customer_id, sum(p.amount) AS paid_amount FROM payments p WHERE p.status = :status GROUP BY p.customer_id';
    const nodeQuery = analyzeSql(query, { analysisMode: 'original', optimizeConditions: false }).lineage.nodes.find((node) => node.id === 'main_output')?.querySql;
    const plan = createInvestigationPlan({
      sql: query,
      target: { columnName: 'paid_amount', nodeId: 'main_output' },
      symptom: 'value_too_low',
      parameters: parameterInput([
        { name: 'customer_id', origin: 'investigation_key' },
        { name: 'status', origin: 'original_query_parameter' },
      ], ['customer_id', 'status']),
    });
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');

    expect(probe).toMatchObject({
      artifactKind: 'investigation_probe',
      id: 'probe:node-query-outer-filter:01',
      interpretation: {
        expectedCardinality: 'zero_or_more_rows',
        expectedColumns: [
          { name: 'customer_id', role: 'selected_node_output', type: 'source_defined' },
          { name: 'paid_amount', role: 'selected_node_output', type: 'source_defined' },
        ],
        observationRules: expect.arrayContaining([
          expect.objectContaining({ condition: 'matching_rows_absent', outcome: 'supports' }),
          expect.objectContaining({ condition: 'matching_rows_present', outcome: 'weakens' }),
          expect.objectContaining({ condition: 'required_parameter_unavailable_or_output_shape_invalid', outcome: 'inconclusive' }),
        ]),
        supportsCandidateConcernIds: ['concern:where:01'],
        version: 1,
        weakensCandidateConcernIds: ['concern:where:01'],
      },
      kind: 'node_query_outer_filter',
      nodeId: 'main_output',
      priority: 1,
      staticSafetyEvidence: {
        basis: 'parser_ast',
        confidence: 'syntax_only',
        statementClassification: 'select_statement',
        version: 1,
      },
    });
    expect(probe?.sql).toContain(`FROM (\n${nodeQuery}\n) AS investigation_node`);
    expect(probe?.sql).toContain('investigation_node."customer_id" = :customer_id');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'status']);
    expect(plan.parameters.find((parameter) => parameter.name === 'customer_id')?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    expect(plan.parameters.find((parameter) => parameter.name === 'status')?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    expect(() => analyzeSql(probe!.sql, { analysisMode: 'original', optimizeConditions: false })).not.toThrow();
  });

  it('does not mark unused known parameters as required by the node-query probe', () => {
    const context = contextFor('SELECT customer_id, amount FROM payments WHERE status = :status', [
      { name: 'customer_id', outputIndex: 0 }, { name: 'amount', outputIndex: 1 },
    ]);
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([
      { name: 'customer_id', origin: 'investigation_key' },
      { name: 'status', origin: 'original_query_parameter' },
      { name: 'scenario_marker', origin: 'original_query_parameter' },
    ], ['customer_id', 'status', 'scenario_marker']), 'value_too_low', context);
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');

    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'status']);
    expect(plan.parameters.find((parameter) => parameter.name === 'scenario_marker')?.usedBy).toEqual([{ analysisMode: 'original', kind: 'original_analysis' }]);
  });

  it.each([
    [[{ name: 'status', origin: 'original_query_parameter' as const }, { name: 'status', origin: 'original_query_parameter' as const }]],
    [[{ name: 'status', origin: 'original_query_parameter' as const }, { name: 'status', origin: 'investigation_key' as const }]],
    [[{ name: 'status', origin: 'investigation_key' as const }, { name: 'status', origin: 'original_query_parameter' as const }]],
  ])('rejects duplicate parameter names at both Core Planner public entry points', (inputs) => {
    expect(() => createInvestigationPlan({ sql: 'SELECT status FROM orders', target: { columnName: 'status', nodeId: 'main_output' }, parameters: parameterInput(inputs) })).toThrow(expect.objectContaining({ code: 'PARAMETER_NAME_COLLISION' }));
    expect(() => createInvestigationPlanFromDiagnosticPacket(packet(), parameterInput(inputs))).toThrow(expect.objectContaining({ code: 'PARAMETER_NAME_COLLISION' }));
  });

  it('keeps distinct parameter names at the Core boundary', () => {
    expect(() => createInvestigationPlan({ sql: 'SELECT status FROM orders', target: { columnName: 'status', nodeId: 'main_output' }, parameters: parameterInput([
      { name: 'status', origin: 'original_query_parameter' },
      { name: 'customer_id', origin: 'investigation_key' },
    ], ['status', 'customer_id']) })).not.toThrow();
  });

  it('rejects binding presence without a matching definition', () => {
    expect(() => createInvestigationPlan({
      sql: 'SELECT status FROM orders',
      target: { columnName: 'status', nodeId: 'main_output' },
      parameters: parameterInput([{ name: 'status', origin: 'original_query_parameter' }], ['missing']),
    })).toThrow(expect.objectContaining({ code: 'PARAMETER_BINDING_DEFINITION_MISMATCH' }));
  });

  it('rejects concrete bindings at the Core definition boundary without echoing them', () => {
    let thrown: unknown;
    try {
      createInvestigationPlan({
        sql: 'SELECT status FROM orders',
        target: { columnName: 'status', nodeId: 'main_output' },
        parameters: {
          definitions: [{ name: 'status', origin: 'original_query_parameter', value: opaqueBinding }],
        } as unknown as InvestigationPlannerParametersV1,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'PARAMETER_BINDING_INPUT_INVALID' });
    expect(String((thrown as Error).message)).not.toContain(opaqueBinding);
  });

  it('requires every investigation key, sorts them, and applies each as an outer AND condition', () => {
    const context = contextFor('SELECT customer_id, region_id, amount FROM payments WHERE status = :status', [
      { name: 'customer_id', outputIndex: 0 }, { name: 'region_id', outputIndex: 1 }, { name: 'amount', outputIndex: 2 },
    ]);
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([
      { name: 'region_id', origin: 'investigation_key' },
      { name: 'customer_id', origin: 'investigation_key' },
      { name: 'status', origin: 'original_query_parameter' },
    ], ['region_id', 'customer_id', 'status']), 'value_too_low', context);
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');

    expect(probe?.sql).toContain('investigation_node."customer_id" = :customer_id AND investigation_node."region_id" = :region_id');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'region_id', 'status']);
    for (const name of ['customer_id', 'region_id']) {
      expect(plan.parameters.find((parameter) => parameter.name === name)?.usedBy).toContainEqual({ kind: 'probe', probeId: probe?.id });
    }
  });

  it('blocks the whole node query probe when any investigation key is not exactly exposed', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([
      { name: 'customer_id', origin: 'investigation_key' },
      { name: 'missing_key', origin: 'investigation_key' },
    ], ['customer_id', 'missing_key']), 'value_too_low', contextFor('SELECT customer_id FROM payments WHERE status = :status', [{ name: 'customer_id', outputIndex: 0 }]));

    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'INVESTIGATION_KEY_NOT_EXPOSED' }));
  });

  it('rejects duplicate investigation key names at the Core boundary', () => {
    expect(() => createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([
      { name: 'customer_id', origin: 'investigation_key' },
      { name: 'customer_id', origin: 'investigation_key' },
    ], ['customer_id']), 'value_too_low', contextFor('SELECT customer_id FROM payments WHERE status = :status', [{ name: 'customer_id', outputIndex: 0 }]))).toThrow(expect.objectContaining({ code: 'PARAMETER_NAME_COLLISION' }));
  });

  it('collects only parser-recognized parameters, not cast names, strings, comments, or quoted identifiers', () => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']), 'value_too_low', contextFor(
      "SELECT customer_id FROM payments WHERE status = :status::text AND note <> ':fake' /* :comment */",
      [{ name: 'customer_id', outputIndex: 0 }],
    ));
    const probe = plan.recommendedProbes.find((item) => item.kind === 'node_query_outer_filter');
    expect(probe?.parameters.map((parameter) => parameter.name)).toEqual(['customer_id', 'status']);
  });

  it('returns a structured block when generated candidate SQL cannot reparse', () => {
    const invalidPacket = packet({
      rowLineage: { ...packet().rowLineage, influences: [{ ...packet().rowLineage.influences[0], expressionSql: 'status = (1' }] },
    });
    const plan = createInvestigationPlanFromDiagnosticPacket(invalidPacket, parameterInput([{ name: 'status', origin: 'original_query_parameter' }], ['status']));
    expect(plan.recommendedProbes).toEqual([]);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'PROBE_REPARSE_FAILED', status: 'blocked' }));
    expect(plan.parameters).toEqual([expect.objectContaining({ name: 'status', usedBy: [{ analysisMode: 'original', kind: 'original_analysis' }] })]);
  });

  it.each([
    ['INSERT', "WITH changed AS (INSERT INTO audit_log(message) VALUES ('x') RETURNING id) SELECT id FROM changed", InsertQuery],
    ['UPDATE', "WITH changed AS (UPDATE orders SET status = 'x' WHERE id = 1 RETURNING id) SELECT id FROM changed", UpdateQuery],
    ['DELETE', 'WITH changed AS (DELETE FROM orders WHERE id = 1 RETURNING id) SELECT id FROM changed', DeleteQuery],
    ['MERGE', 'WITH changed AS (MERGE INTO orders target USING staged source ON target.id = source.id WHEN MATCHED THEN UPDATE SET status = source.status RETURNING target.id) SELECT id FROM changed', MergeQuery],
  ])('blocks a parsed %s CTE even though its top-level AST is SELECT', (_name, querySql, dmlConstructor) => {
    const parsed = SqlParser.parse(querySql);
    expect(parsed).toBeInstanceOf(SimpleSelectQuery);
    expect(parsed).not.toBeInstanceOf(BinarySelectQuery);
    if (!(parsed instanceof SimpleSelectQuery)) throw new Error('Expected the DML CTE reproduction to parse as a SimpleSelectQuery.');
    expect(parsed.withClause?.tables).toHaveLength(1);
    expect(parsed.withClause?.tables[0].query).toBeInstanceOf(dmlConstructor);

    const plan = createInvestigationPlanFromDiagnosticPacket(
      nodeQueryPacket(),
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']),
      'value_too_low',
      contextFor(querySql, [{ name: 'customer_id', outputIndex: 0 }]),
    );

    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.deferredProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'PROBE_STATEMENT_CLASS_UNSUPPORTED', id: 'probe:node-query-outer-filter:01', status: 'blocked' }));
  });

  it('allows nested SELECT-only CTEs before creating an outer-filter probe', () => {
    const querySql = 'WITH first_rows AS (SELECT customer_id, status FROM payments), selected_rows AS (SELECT customer_id FROM first_rows WHERE status = :status) SELECT customer_id FROM selected_rows';
    const plan = createInvestigationPlanFromDiagnosticPacket(
      nodeQueryPacket(),
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }, { name: 'status', origin: 'original_query_parameter' }], ['customer_id', 'status']),
      'value_too_low',
      contextFor(querySql, [{ name: 'customer_id', outputIndex: 0 }]),
    );

    expect(plan.recommendedProbes).toContainEqual(expect.objectContaining({ kind: 'node_query_outer_filter', staticSafetyEvidence: expect.objectContaining({ statementClassification: 'select_statement' }) }));
  });

  it('blocks a data-modifying CTE nested beneath a SELECT CTE', () => {
    const querySql = 'WITH selected_rows AS (WITH changed AS (DELETE FROM payments WHERE status = \'cancelled\' RETURNING customer_id) SELECT customer_id FROM changed) SELECT customer_id FROM selected_rows';
    const plan = createInvestigationPlanFromDiagnosticPacket(
      nodeQueryPacket(),
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']),
      'value_too_low',
      contextFor(querySql, [{ name: 'customer_id', outputIndex: 0 }]),
    );

    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.deferredProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'PROBE_STATEMENT_CLASS_UNSUPPORTED', id: 'probe:node-query-outer-filter:01', status: 'blocked' }));
  });

  it('blocks a data-modifying CTE nested inside a derived-table source', () => {
    const querySql = "SELECT customer_id FROM (WITH changed AS (DELETE FROM payments WHERE status = 'cancelled' RETURNING customer_id) SELECT customer_id FROM changed) nested_rows";
    const plan = createInvestigationPlanFromDiagnosticPacket(
      nodeQueryPacket(),
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']),
      'value_too_low',
      contextFor(querySql, [{ name: 'customer_id', outputIndex: 0 }]),
    );

    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.deferredProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code: 'PROBE_STATEMENT_CLASS_UNSUPPORTED', id: 'probe:node-query-outer-filter:01', status: 'blocked' }));
  });

  it('allows a SELECT-only derived-table source', () => {
    const querySql = 'SELECT customer_id FROM (WITH selected_rows AS (SELECT customer_id FROM payments WHERE status = :status) SELECT customer_id FROM selected_rows) nested_rows';
    const plan = createInvestigationPlanFromDiagnosticPacket(
      nodeQueryPacket(),
      parameterInput([{ name: 'customer_id', origin: 'investigation_key' }, { name: 'status', origin: 'original_query_parameter' }], ['customer_id', 'status']),
      'value_too_low',
      contextFor(querySql, [{ name: 'customer_id', outputIndex: 0 }]),
    );

    expect(plan.recommendedProbes).toContainEqual(expect.objectContaining({ kind: 'node_query_outer_filter', staticSafetyEvidence: expect.objectContaining({ statementClassification: 'select_statement' }) }));
  });

  it.each([
    ['missing key output', contextFor('SELECT total FROM payments', [{ name: 'total', outputIndex: 0 }]), 'INVESTIGATION_KEY_NOT_EXPOSED'],
    ['duplicate key output', contextFor('SELECT customer_id, customer_id FROM payments', [{ name: 'customer_id', outputIndex: 0 }, { name: 'customer_id', outputIndex: 1 }]), 'AMBIGUOUS_OUTPUT_COLUMN'],
    ['unresolved wildcard', { ...contextFor('SELECT customer_id FROM payments', [{ name: 'customer_id', outputIndex: 0 }]), analysisWarnings: [{ code: 'wildcard_unresolved_without_schema', message: 'Wildcard expansion is unresolved.' }] }, 'UNRESOLVED_WILDCARD'],
    ['absent node query', contextFor(undefined, [{ name: 'customer_id', outputIndex: 0 }]), 'NODE_QUERY_UNAVAILABLE'],
    ['non-SELECT node query', contextFor('DELETE FROM payments', [{ name: 'customer_id', outputIndex: 0 }]), 'PROBE_STATEMENT_CLASS_UNSUPPORTED'],
    ['unparseable node query', contextFor('SELECT FROM', [{ name: 'customer_id', outputIndex: 0 }]), 'PROBE_REPARSE_FAILED'],
    ['source alias only', contextFor('SELECT p.amount FROM payments p', [{ name: 'amount', outputIndex: 0 }]), 'INVESTIGATION_KEY_NOT_EXPOSED'],
  ])('blocks the outer-filter probe for %s', (_label, context, code) => {
    const plan = createInvestigationPlanFromDiagnosticPacket(nodeQueryPacket(), parameterInput([{ name: 'customer_id', origin: 'investigation_key' }], ['customer_id']), 'value_too_low', context);
    expect(plan.recommendedProbes.some((probe) => probe.kind === 'node_query_outer_filter')).toBe(false);
    expect(plan.blockedProbes).toContainEqual(expect.objectContaining({ code, status: 'blocked' }));
  });
});

function nodeQueryPacket(): ColumnDiagnosticPacket {
  const base = packet();
  return {
    ...base,
    target: { ...base.target, nodeId: 'main_output' },
  };
}

function contextFor(querySql: string | undefined, columns: Array<{ name: string; outputIndex: number }>): InvestigationNodeQueryContextV1 {
  return {
    analysisWarnings: [],
    nodes: [{ columns: columns.map((column) => ({ id: `main_output.${column.name}.${column.outputIndex}`, ...column })), id: 'main_output', label: 'Final Result', querySql, type: 'output' }],
    scopes: [{ id: 'scope:orders', kind: 'select', nodeId: 'main_output' }],
  };
}
