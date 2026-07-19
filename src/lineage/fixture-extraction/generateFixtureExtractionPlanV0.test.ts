import { SqlParser, SimpleSelectQuery } from 'rawsql-ts';
import { describe, expect, it } from 'vitest';
import {
  canonicalFixtureExtractionPlanJsonV0,
  FixtureExtractionInputErrorV0,
  type FixtureExtractionInputV0,
} from './fixtureExtractionPlanV0';
import { generateFixtureExtractionPlanV0 } from './generateFixtureExtractionPlanV0';

function input(sql: string, ddl: string | undefined, rootRelation: string, rootColumn: string, parameterName = rootColumn): FixtureExtractionInputV0 {
  return {
    sql,
    ...(ddl ? { ddl: [{ sql: ddl }] } : {}),
    reproductionKey: { parameterNames: [parameterName], rootRelation, rootColumns: [rootColumn] },
  };
}

function expectReadySql(plan: ReturnType<typeof generateFixtureExtractionPlanV0>): void {
  expect(plan.status).toBe('ready');
  expect(plan.blockedReasons).toEqual([]);
  for (const step of plan.steps) {
    expect(step.sql).not.toBeNull();
    expect(step.blockedReasonCodes).toEqual([]);
    expect(SqlParser.parse(step.sql!)).toBeInstanceOf(SimpleSelectQuery);
    expect(step.sql).not.toMatch(/\blimit\b/i);
  }
}

describe('generateFixtureExtractionPlanV0', () => {
  it('generates the contract-aligned single-table root plan', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select t.ticket_id, t.subject, t.priority\nfrom support_ticket as t\nwhere t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null, priority integer not null);',
      'support_ticket',
      'ticket_id',
    ));

    expectReadySql(plan);
    expect(plan.source.sqlHash).toBe('sha256:ff6a4c5e65999765edfd34f5524930361c1bd518ac5528dbcc8d3290b70d961e');
    expect(plan.reproductionKey).toMatchObject({
      parameterNames: ['ticket_id'],
      rootRelation: 'support_ticket',
      rootRelationOccurrenceId: 'relation-occurrence:0001',
      rootColumns: ['ticket_id'],
      columnParameterMappings: [{ parameterName: 'ticket_id', rootColumn: 'ticket_id' }],
      status: 'resolved',
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      id: 'fixture-step:001',
      relationName: 'support_ticket',
      artifactKind: 'fixture_extraction_query',
      captureColumns: { mode: 'ddl_columns', columnNames: ['priority', 'subject', 'ticket_id'] },
      sql: 'select priority, subject, ticket_id from support_ticket where ticket_id = :ticket_id;',
      parameterNames: ['ticket_id'],
      boundary: { status: 'bounded', reason: 'root_key_parameter_equality', hopCount: 0 },
    });
    expect(plan.suggestedCaptureOrder).toEqual(['fixture-step:001']);
    expect(plan.suggestedLoadOrder).toEqual(['fixture-step:001']);
  });

  it('validates an explicit main-output target without falling back to another target', () => {
    const plan = generateFixtureExtractionPlanV0({
      ...input(
        'select t.ticket_id, t.subject from support_ticket as t where t.ticket_id = :ticket_id;',
        'create table support_ticket (ticket_id integer primary key, subject text not null);',
        'support_ticket',
        'ticket_id',
      ),
      targetId: 'target:001',
    });
    expectReadySql(plan);
    expect(plan.source.targetId).toBe('target:001');

    const missing = generateFixtureExtractionPlanV0({
      ...input(
        'select t.ticket_id from support_ticket as t where t.ticket_id = :ticket_id;',
        'create table support_ticket (ticket_id integer primary key);',
        'support_ticket',
        'ticket_id',
      ),
      targetId: 'target:999',
    });
    expect(missing.status).toBe('blocked');
    expect(missing.blockedReasons.map((reason) => reason.code)).toEqual(['COLUMN_REFERENCE_AMBIGUOUS']);
  });

  it('propagates a root key across a LEFT JOIN with FK proof', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select a.account_id, a.display_label, n.note_id, n.note_body from account as a left join account_note as n on n.account_id = a.account_id where a.account_id = :account_id order by n.note_id;',
      'create table account (account_id integer primary key, display_label text not null); create table account_note (note_id integer primary key, account_id integer not null references account(account_id), note_body text null);',
      'account',
      'account_id',
    ));

    expectReadySql(plan);
    expect(plan.steps.map((step) => ({ relation: step.relationName, sql: step.sql }))).toEqual([
      { relation: 'account', sql: 'select account_id, display_label from account where account_id = :account_id;' },
      { relation: 'account_note', sql: 'select account_id, note_body, note_id from account_note where account_id = :account_id;' },
    ]);
    expect(plan.steps[1]).toMatchObject({
      dependsOnStepIds: ['fixture-step:001'],
      loadAfterStepIds: ['fixture-step:001'],
      predicateDerivation: 'join_key_propagation',
      boundary: { status: 'bounded', reason: 'direct_key_equality_propagation', hopCount: 1 },
    });
  });

  it('uses a bounded nested key subquery for the second hop', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select c.customer_id, o.order_id, i.item_id, i.sku, i.quantity from customer as c join purchase_order as o on o.customer_id = c.customer_id join order_item as i on i.order_id = o.order_id where c.customer_id = :customer_id order by o.order_id, i.item_id;',
      'create table customer (customer_id integer primary key, display_label text not null); create table purchase_order (order_id integer primary key, customer_id integer not null references customer(customer_id), order_state text not null); create table order_item (item_id integer primary key, order_id integer not null references purchase_order(order_id), sku text not null, quantity integer not null);',
      'customer',
      'customer_id',
    ));

    expectReadySql(plan);
    expect(plan.steps.map((step) => step.relationName)).toEqual(['customer', 'purchase_order', 'order_item']);
    expect(plan.steps[2]).toMatchObject({
      dependsOnStepIds: ['fixture-step:002'],
      loadAfterStepIds: ['fixture-step:002'],
      predicateDerivation: 'foreign_key_dependency',
      boundary: { status: 'bounded', reason: 'nested_foreign_key_subquery', hopCount: 2, relationColumns: ['order_id'] },
    });
    expect(plan.steps[2].sql).toBe('select item_id, order_id, quantity, sku\nfrom order_item\nwhere order_id in (\n  select order_id\n  from purchase_order\n  where customer_id = :customer_id\n);');
  });

  it.each([
    ['exists', 'rows_may_be_present', false],
    ['not exists', 'empty_result_required', true],
  ] as const)('retains a bounded related step for %s', (operator, expectation, empty) => {
    const plan = generateFixtureExtractionPlanV0(input(
      `select m.member_id, m.display_label from member as m where m.member_id = :member_id and ${operator} (select 1 from subscription as s where s.member_id = m.member_id and s.subscription_state = 'active');`,
      'create table member (member_id integer primary key, display_label text not null); create table subscription (subscription_id integer primary key, member_id integer not null references member(member_id), subscription_state text not null);',
      'member',
      'member_id',
    ));

    expectReadySql(plan);
    expect(plan.steps[1]).toMatchObject({
      relationName: 'subscription',
      predicateDerivation: 'exists_dependency',
      sql: 'select member_id, subscription_id, subscription_state from subscription where member_id = :member_id;',
      resultExpectation: { kind: expectation },
      boundary: { status: 'bounded', reason: 'correlated_exists_key_equality', hopCount: 1 },
    });
    expect(plan.steps[1].resultExpectation.note).toBe(empty ? 'The required reproduction state may be an empty result for this relation.' : null);
  });

  it('preserves a related local parameter predicate for the aggregate stretch scenario', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select a.account_id, a.display_label, coalesce(sum(p.amount), 0)::integer as paid_amount, count(p.payment_id)::integer as payment_count from billing_account as a left join synthetic_payment as p on p.account_id = a.account_id and p.payment_state = :payment_state where a.account_id = :account_id group by a.account_id, a.display_label;',
      'create table billing_account (account_id integer primary key, display_label text not null); create table synthetic_payment (payment_id integer primary key, account_id integer not null references billing_account(account_id), payment_state text not null, amount integer not null);',
      'billing_account',
      'account_id',
    ));

    expectReadySql(plan);
    expect(plan.steps[1]).toMatchObject({
      relationName: 'synthetic_payment',
      sql: 'select account_id, amount, payment_id, payment_state from synthetic_payment where account_id = :account_id and payment_state = :payment_state;',
      parameterNames: ['account_id', 'payment_state'],
      boundary: { relationColumns: ['account_id', 'payment_state'], parameterNames: ['account_id', 'payment_state'] },
    });
  });

  it('flattens a referenced SELECT-only CTE and excludes an unused sibling CTE', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'with chosen as (select t.ticket_id, t.subject from support_ticket t where t.ticket_id = :ticket_id), unused as (select a.audit_id from audit_log a) select ticket_id, subject from chosen;',
      'create table support_ticket (ticket_id integer primary key, subject text not null); create table audit_log (audit_id integer primary key);',
      'support_ticket',
      'ticket_id',
    ));

    expectReadySql(plan);
    expect(plan.steps.map((step) => step.relationName)).toEqual(['support_ticket']);
    expect(plan.steps[0].sql).toBe('select subject, ticket_id from support_ticket where ticket_id = :ticket_id;');
  });

  it('blocks a DML CTE with RETURNING in catalog order and emits no SQL', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      "with changed as (update synthetic_document set document_state = 'archived' where document_id = :document_id returning document_id, document_state) select document_id, document_state from changed;",
      'create table synthetic_document (document_id integer primary key, document_state text not null);',
      'synthetic_document',
      'document_id',
    ));

    expect(plan.status).toBe('blocked');
    expect(plan.steps).toEqual([]);
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['RETURNING_UNSUPPORTED', 'DML_CTE_UNSUPPORTED']);
  });

  it('returns the aligned fail-closed outcomes for required negative variants', () => {
    const missingKey = generateFixtureExtractionPlanV0({
      ...input('select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id;', 'create table support_ticket (ticket_id integer primary key);', 'support_ticket', 'ticket_id'),
      reproductionKey: { parameterNames: [], rootRelation: 'support_ticket', rootColumns: ['ticket_id'] },
    });
    expect([missingKey.status, missingKey.reproductionKey.status, missingKey.blockedReasons.map((item) => item.code)]).toEqual(['blocked', 'blocked', ['REPRODUCTION_KEY_REQUIRED']]);

    const nonEquality = generateFixtureExtractionPlanV0(input(
      'select p.parent_id, c.child_id from range_parent as p join range_child as c on c.parent_score > p.minimum_score where p.parent_id = :parent_id;',
      'create table range_parent (parent_id integer primary key, minimum_score integer not null); create table range_child (child_id integer primary key, parent_score integer not null);',
      'range_parent',
      'parent_id',
    ));
    expect(nonEquality.status).toBe('partial');
    expect(nonEquality.steps.map((step) => step.sql)).toEqual(['select minimum_score, parent_id from range_parent where parent_id = :parent_id;', null]);
    expect(nonEquality.blockedReasons.map((item) => item.code)).toEqual(['NON_EQUALITY_JOIN_UNSUPPORTED']);

    const ambiguousSchema = generateFixtureExtractionPlanV0(input(
      'select p.parent_id from parent as p where p.parent_id = :parent_id;',
      'create table public.parent (parent_id integer primary key); create table audit.parent (parent_id integer primary key);',
      'parent',
      'parent_id',
    ));
    expect([ambiguousSchema.status, ambiguousSchema.reproductionKey.status, ambiguousSchema.blockedReasons.map((item) => item.code)])
      .toEqual(['blocked', 'ambiguous', ['ROOT_RELATION_UNRESOLVED']]);

    const missingFk = generateFixtureExtractionPlanV0(input(
      'select p.parent_id, c.child_id from fk_parent as p join fk_child as c on c.parent_id = p.parent_id where p.parent_id = :parent_id;',
      'create table fk_parent (parent_id integer primary key); create table fk_child (child_id integer primary key, parent_id integer not null);',
      'fk_parent',
      'parent_id',
    ));
    expect(missingFk.status).toBe('partial');
    expect(missingFk.blockedReasons.map((item) => item.code)).toEqual(['SCHEMA_FACTS_REQUIRED']);

    const wildcard = generateFixtureExtractionPlanV0(input(
      'select u.* from unknown_projection as u where u.id = :id;',
      undefined,
      'unknown_projection',
      'id',
    ));
    expect([wildcard.status, wildcard.reproductionKey.status, wildcard.blockedReasons.map((item) => item.code)])
      .toEqual(['blocked', 'blocked', ['UNRESOLVED_WILDCARD']]);

    const recursive = generateFixtureExtractionPlanV0(input(
      'with recursive chain(node_id, parent_id) as (select n.node_id, n.parent_id from hierarchy_node as n where n.node_id = :node_id union all select n.node_id, n.parent_id from hierarchy_node as n join chain as c on n.parent_id = c.node_id) select node_id, parent_id from chain;',
      'create table hierarchy_node (node_id integer primary key, parent_id integer null references hierarchy_node(node_id));',
      'hierarchy_node',
      'node_id',
    ));
    expect([recursive.status, recursive.reproductionKey.status, recursive.blockedReasons.map((item) => item.code)])
      .toEqual(['blocked', 'blocked', ['RECURSIVE_CTE_UNSUPPORTED']]);

    const unbounded = generateFixtureExtractionPlanV0(input(
      'select e.event_id, e.event_kind from synthetic_event as e where e.event_kind = :event_kind;',
      'create table synthetic_event (event_id integer primary key, event_kind text not null);',
      'synthetic_event',
      'event_kind',
    ));
    expect([unbounded.status, unbounded.reproductionKey.status, unbounded.blockedReasons.map((item) => item.code)])
      .toEqual(['blocked', 'ambiguous', ['REPRODUCTION_KEY_AMBIGUOUS', 'CAPTURE_BOUNDARY_UNBOUNDED']]);
  });

  it('does not first-match an ambiguous related relation across schemas', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select p.parent_id, c.child_id from public.parent p join child c on c.parent_id = p.parent_id where p.parent_id = :parent_id;',
      'create table public.parent (parent_id integer primary key); create table public.child (child_id integer primary key, parent_id integer not null references public.parent(parent_id)); create table audit.child (child_id integer primary key, parent_id integer not null references audit.parent(parent_id)); create table audit.parent (parent_id integer primary key);',
      'public.parent',
      'parent_id',
    ));
    expect(plan.status).toBe('partial');
    expect(plan.steps[1].sql).toBeNull();
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['RELATION_UNRESOLVED']);
  });

  it('fails closed when parser facts cannot distinguish quoted from case-variant identifiers', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select p."ID" from "Parent" p where p."ID" = :id;',
      'create table "Parent" ("ID" integer primary key);',
      'Parent',
      'ID',
      'id',
    ));
    expect(plan.status).toBe('blocked');
    expect(plan.steps).toEqual([]);
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['ROOT_RELATION_UNRESOLVED']);
  });

  it('rejects value-bearing input without echoing, hashing, or serializing the sentinel', () => {
    const sentinel = 'fixture-secret-sentinel';
    let error: unknown;
    try {
      generateFixtureExtractionPlanV0({
        ...input('select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id;', 'create table support_ticket (ticket_id integer primary key);', 'support_ticket', 'ticket_id'),
        bindings: { ticket_id: sentinel },
      } as unknown as FixtureExtractionInputV0);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FixtureExtractionInputErrorV0);
    expect(error).toMatchObject({ code: 'VALUE_BEARING_INPUT_FORBIDDEN' });
    expect(String(error)).not.toContain(sentinel);
  });

  it.each(['binding', 'bindings', 'bindingValue', 'bindingValues', 'value', 'values', 'providedValues'])
  ('rejects forbidden input field %s at the top-level boundary', (field) => {
    const sentinel = `sentinel-${field}`;
    expect(() => generateFixtureExtractionPlanV0({
      ...input('select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id;', 'create table support_ticket (ticket_id integer primary key);', 'support_ticket', 'ticket_id'),
      [field]: sentinel,
    } as unknown as FixtureExtractionInputV0)).toThrow(expect.objectContaining({
      code: 'VALUE_BEARING_INPUT_FORBIDDEN',
      message: 'Value-bearing input is forbidden for fixture extraction.',
    }));
  });

  it('blocks a composite root in minimum V0 without emitting capture SQL', () => {
    const plan = generateFixtureExtractionPlanV0({
      sql: 'select t.tenant_id, t.ticket_id from tenant_ticket t where t.tenant_id = :tenant_id and t.ticket_id = :ticket_id;',
      ddl: [{ sql: 'create table tenant_ticket (tenant_id integer not null, ticket_id integer not null, primary key (tenant_id, ticket_id));' }],
      reproductionKey: {
        parameterNames: ['tenant_id', 'ticket_id'],
        rootRelation: 'tenant_ticket',
        rootColumns: ['tenant_id', 'ticket_id'],
      },
    });
    expect(plan.status).toBe('blocked');
    expect(plan.steps).toEqual([]);
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['REPRODUCTION_KEY_AMBIGUOUS']);
  });

  it('rejects malformed SchemaFacts with the fixed input-shape error', () => {
    expect(() => generateFixtureExtractionPlanV0({
      sql: 'select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id;',
      schemaFacts: {
        kind: 'schema-facts',
        version: 1,
        tables: { support_ticket: null },
      } as unknown as FixtureExtractionInputV0['schemaFacts'],
      reproductionKey: { parameterNames: ['ticket_id'], rootRelation: 'support_ticket', rootColumns: ['ticket_id'] },
    })).toThrow(expect.objectContaining({
      code: 'INPUT_SHAPE_INVALID',
      message: 'Fixture extraction input has an invalid shape.',
    }));
  });

  it('fails closed for an unsupported scalar subquery instead of claiming ready closure', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select t.ticket_id, (select max(a.audit_id) from audit_log a) as last_audit from support_ticket t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key); create table audit_log (audit_id integer primary key);',
      'support_ticket',
      'ticket_id',
    ));
    expect(plan.status).toBe('blocked');
    expect(plan.steps).toEqual([]);
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['PARAMETER_PROPAGATION_UNPROVEN']);
  });

  it('fails closed for set operations until complete branch proof exists', () => {
    const plan = generateFixtureExtractionPlanV0(input(
      'select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id union all select t.ticket_id from support_ticket t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key);',
      'support_ticket',
      'ticket_id',
    ));
    expect(plan.status).toBe('blocked');
    expect(plan.steps).toEqual([]);
    expect(plan.blockedReasons.map((reason) => reason.code)).toEqual(['PARAMETER_PROPAGATION_UNPROVEN']);
  });

  it('is deterministic under reversed DDL table order and closes all references', () => {
    const sql = 'select a.account_id, n.note_id from account a left join account_note n on n.account_id = a.account_id where a.account_id = :account_id;';
    const ddlA = { sql: 'create table account (account_id integer primary key, display_label text not null);' };
    const ddlB = { sql: 'create table account_note (note_id integer primary key, account_id integer not null references account(account_id));' };
    const base = { sql, reproductionKey: { parameterNames: ['account_id'], rootRelation: 'account', rootColumns: ['account_id'] } } as const;
    const left = generateFixtureExtractionPlanV0({ ...base, ddl: [ddlA, ddlB] });
    const right = generateFixtureExtractionPlanV0({ ...base, ddl: [ddlB, ddlA] });
    expect(canonicalFixtureExtractionPlanJsonV0(left)).toBe(canonicalFixtureExtractionPlanJsonV0(right));

    const evidenceIds = new Set(left.sourceEvidence.map((item) => item.id));
    const stepIds = new Set(left.steps.map((item) => item.id));
    expect(left.sourceEvidence.every((item) => /^fixture-evidence:[0-9]{4}$/.test(item.id))).toBe(true);
    expect(left.steps.every((step) => /^fixture-step:[0-9]{3}$/.test(step.id) && /^relation-occurrence:[0-9]{4}$/.test(step.relationOccurrenceId))).toBe(true);
    expect(left.steps.flatMap((step) => [...step.sourceEvidenceIds, ...step.boundary.sourceEvidenceIds]).every((id) => evidenceIds.has(id))).toBe(true);
    expect(left.steps.flatMap((step) => [...step.dependsOnStepIds, ...step.loadAfterStepIds]).every((id) => stepIds.has(id))).toBe(true);
  });

  it('blocks top-level DML and volatile function sources before lineage analysis', () => {
    const dml = generateFixtureExtractionPlanV0(input(
      "update support_ticket set subject = 'changed' where ticket_id = :ticket_id returning ticket_id;",
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expect(dml.blockedReasons.map((item) => item.code)).toEqual(['DML_STATEMENT_UNSUPPORTED', 'RETURNING_UNSUPPORTED']);

    const volatile = generateFixtureExtractionPlanV0(input(
      'select r.value from random_rows() as r where r.value = :value;',
      'create table random_rows (value integer primary key);',
      'random_rows',
      'value',
    ));
    expect(volatile.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
  });

  it('fails closed for scalar functions whose volatility is not proven', () => {
    const unclassified = generateFixtureExtractionPlanV0(input(
      'select lower(t.subject) from support_ticket as t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expect(unclassified.status).toBe('blocked');
    expect(unclassified.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
    expect(unclassified.steps).toEqual([]);

    const resultShapeAffecting = generateFixtureExtractionPlanV0(input(
      'select distinct on (lower(t.subject)) t.ticket_id from support_ticket as t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expect(resultShapeAffecting.status).toBe('blocked');
    expect(resultShapeAffecting.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
    expect(resultShapeAffecting.steps).toEqual([]);

    const populationAffecting = generateFixtureExtractionPlanV0(input(
      "select a.account_id from billing_account as a left join synthetic_payment as p on p.account_id = a.account_id and lower(p.payment_state) = 'paid' where a.account_id = :account_id;",
      'create table billing_account (account_id integer primary key); create table synthetic_payment (payment_id integer primary key, account_id integer not null references billing_account(account_id), payment_state text not null);',
      'billing_account',
      'account_id',
    ));
    expect(populationAffecting.status).toBe('blocked');
    expect(populationAffecting.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
    expect(populationAffecting.steps).toEqual([]);

    const qualifiedLookalike = generateFixtureExtractionPlanV0(input(
      'select custom.sum(t.ticket_id) from support_ticket as t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expect(qualifiedLookalike.status).toBe('blocked');
    expect(qualifiedLookalike.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
    expect(qualifiedLookalike.steps).toEqual([]);

    const knownVolatile = generateFixtureExtractionPlanV0(input(
      'select random(), t.subject from support_ticket as t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expect(knownVolatile.status).toBe('blocked');
    expect(knownVolatile.blockedReasons.map((item) => item.code)).toEqual(['VOLATILE_SOURCE_UNSUPPORTED']);
    expect(knownVolatile.steps).toEqual([]);

    const functionFree = generateFixtureExtractionPlanV0(input(
      'select t.subject from support_ticket as t where t.ticket_id = :ticket_id;',
      'create table support_ticket (ticket_id integer primary key, subject text not null);',
      'support_ticket',
      'ticket_id',
    ));
    expectReadySql(functionFree);
    expect(functionFree.steps).toHaveLength(1);
  });
});
