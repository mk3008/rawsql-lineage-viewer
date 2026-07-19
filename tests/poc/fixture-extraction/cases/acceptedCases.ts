export type Scalar = boolean | number | string | null;

export interface SourceRelationFixture {
  readonly columns: readonly string[];
  readonly name: string;
  readonly rows: readonly (readonly Scalar[])[];
}

export interface ExpectedCaptureResult {
  readonly columns: readonly string[];
  readonly ordered?: boolean;
  readonly rows: readonly (readonly Scalar[])[];
}

export interface AcceptedHarnessCase {
  readonly bindings: Readonly<Record<string, Scalar>>;
  readonly ddl: string;
  readonly expectedBlockedCode?: 'DML_CTE_UNSUPPORTED';
  readonly expectedPlanStatus: 'blocked' | 'ready';
  readonly expectedResultRows?: number;
  readonly expectedCaptures?: Readonly<Record<string, ExpectedCaptureResult>>;
  readonly id: string;
  readonly orderedResult: boolean;
  readonly purpose: string;
  readonly reproductionKey: {
    readonly parameterNames: readonly string[];
    readonly rootColumns: readonly string[];
    readonly rootRelation: string;
  };
  readonly sourceRelations: readonly SourceRelationFixture[];
  readonly sql: string;
}

export const acceptedHarnessCases: readonly AcceptedHarnessCase[] = [
  {
    id: 'fxsel-01-single-ticket',
    purpose: 'single-table lookup by an explicit primary key',
    sql: `select t.ticket_id, t.subject, t.priority
from support_ticket as t
where t.ticket_id = :ticket_id;`,
    ddl: `create table support_ticket (
  ticket_id integer primary key,
  subject text not null,
  priority integer not null
);`,
    bindings: { ticket_id: 101 },
    reproductionKey: {
      parameterNames: ['ticket_id'],
      rootRelation: 'support_ticket',
      rootColumns: ['ticket_id'],
    },
    sourceRelations: [{
      name: 'support_ticket',
      columns: ['ticket_id', 'subject', 'priority'],
      rows: [
        [101, 'synthetic ticket alpha', 2],
        [102, 'synthetic ticket beta', 1],
      ],
    }],
    expectedPlanStatus: 'ready',
    expectedCaptures: {
      support_ticket: {
        columns: ['priority', 'subject', 'ticket_id'],
        rows: [[2, 'synthetic ticket alpha', 101]],
      },
    },
    expectedResultRows: 1,
    orderedResult: false,
  },
  {
    id: 'fxsel-02-account-notes-left',
    purpose: 'LEFT equi-join from an account to nullable child notes',
    sql: `select a.account_id, a.display_label, n.note_id, n.note_body
from account as a
left join account_note as n on n.account_id = a.account_id
where a.account_id = :account_id
order by n.note_id;`,
    ddl: `create table account (
  account_id integer primary key,
  display_label text not null
);
create table account_note (
  note_id integer primary key,
  account_id integer not null references account(account_id),
  note_body text null
);`,
    bindings: { account_id: 200 },
    reproductionKey: {
      parameterNames: ['account_id'],
      rootRelation: 'account',
      rootColumns: ['account_id'],
    },
    sourceRelations: [
      {
        name: 'account',
        columns: ['account_id', 'display_label'],
        rows: [
          [200, 'synthetic account amber'],
          [201, 'synthetic account blue'],
        ],
      },
      {
        name: 'account_note',
        columns: ['note_id', 'account_id', 'note_body'],
        rows: [
          [3001, 200, 'synthetic first note'],
          [3002, 200, null],
          [3003, 201, 'synthetic unrelated note'],
        ],
      },
    ],
    expectedPlanStatus: 'ready',
    expectedCaptures: {
      account: {
        columns: ['account_id', 'display_label'],
        rows: [[200, 'synthetic account amber']],
      },
      account_note: {
        columns: ['account_id', 'note_body', 'note_id'],
        rows: [
          [200, 'synthetic first note', 3001],
          [200, null, 3002],
        ],
      },
    },
    expectedResultRows: 2,
    orderedResult: true,
  },
  {
    id: 'fxsel-03-customer-order-items',
    purpose: 'two-hop customer-to-order-to-item relationship',
    sql: `select c.customer_id, o.order_id, i.item_id, i.sku, i.quantity
from customer as c
join purchase_order as o on o.customer_id = c.customer_id
join order_item as i on i.order_id = o.order_id
where c.customer_id = :customer_id
order by o.order_id, i.item_id;`,
    ddl: `create table customer (
  customer_id integer primary key,
  display_label text not null
);
create table purchase_order (
  order_id integer primary key,
  customer_id integer not null references customer(customer_id),
  order_state text not null
);
create table order_item (
  item_id integer primary key,
  order_id integer not null references purchase_order(order_id),
  sku text not null,
  quantity integer not null
);`,
    bindings: { customer_id: 310 },
    reproductionKey: {
      parameterNames: ['customer_id'],
      rootRelation: 'customer',
      rootColumns: ['customer_id'],
    },
    sourceRelations: [
      {
        name: 'customer',
        columns: ['customer_id', 'display_label'],
        rows: [
          [310, 'synthetic customer green'],
          [311, 'synthetic customer gray'],
        ],
      },
      {
        name: 'purchase_order',
        columns: ['order_id', 'customer_id', 'order_state'],
        rows: [
          [4101, 310, 'open'],
          [4102, 310, 'closed'],
          [4103, 311, 'open'],
        ],
      },
      {
        name: 'order_item',
        columns: ['item_id', 'order_id', 'sku', 'quantity'],
        rows: [
          [5101, 4101, 'SYN-A', 2],
          [5102, 4101, 'SYN-B', 1],
          [5103, 4102, 'SYN-C', 4],
          [5104, 4103, 'SYN-D', 9],
        ],
      },
    ],
    expectedPlanStatus: 'ready',
    expectedCaptures: {
      customer: {
        columns: ['customer_id', 'display_label'],
        rows: [[310, 'synthetic customer green']],
      },
      purchase_order: {
        columns: ['customer_id', 'order_id', 'order_state'],
        rows: [
          [310, 4101, 'open'],
          [310, 4102, 'closed'],
        ],
      },
      order_item: {
        columns: ['item_id', 'order_id', 'quantity', 'sku'],
        rows: [
          [5101, 4101, 2, 'SYN-A'],
          [5102, 4101, 1, 'SYN-B'],
          [5103, 4102, 4, 'SYN-C'],
        ],
      },
    },
    expectedResultRows: 3,
    orderedResult: true,
  },
  {
    id: 'fxsel-04-member-exists',
    purpose: 'correlated EXISTS from a member to subscriptions',
    sql: `select m.member_id, m.display_label
from member as m
where m.member_id = :member_id
  and exists (
    select 1
    from subscription as s
    where s.member_id = m.member_id
      and s.subscription_state = 'active'
  );`,
    ddl: `create table member (
  member_id integer primary key,
  display_label text not null
);
create table subscription (
  subscription_id integer primary key,
  member_id integer not null references member(member_id),
  subscription_state text not null
);`,
    bindings: { member_id: 500 },
    reproductionKey: {
      parameterNames: ['member_id'],
      rootRelation: 'member',
      rootColumns: ['member_id'],
    },
    sourceRelations: [
      {
        name: 'member',
        columns: ['member_id', 'display_label'],
        rows: [
          [500, 'synthetic member violet'],
          [501, 'synthetic member silver'],
        ],
      },
      {
        name: 'subscription',
        columns: ['subscription_id', 'member_id', 'subscription_state'],
        rows: [
          [6001, 500, 'active'],
          [6002, 500, 'paused'],
          [6003, 501, 'active'],
        ],
      },
    ],
    expectedPlanStatus: 'ready',
    expectedCaptures: {
      member: {
        columns: ['display_label', 'member_id'],
        rows: [['synthetic member violet', 500]],
      },
      subscription: {
        columns: ['member_id', 'subscription_id', 'subscription_state'],
        rows: [[500, 6001, 'active']],
      },
    },
    expectedResultRows: 1,
    orderedResult: false,
  },
  {
    id: 'fxsel-05-workspace-not-exists',
    purpose: 'correlated NOT EXISTS with required zero-row child evidence',
    sql: `select w.workspace_id, w.display_label
from workspace as w
where w.workspace_id = :workspace_id
  and not exists (
    select 1
    from blocking_alert as a
    where a.workspace_id = w.workspace_id
  );`,
    ddl: `create table workspace (
  workspace_id integer primary key,
  display_label text not null
);
create table blocking_alert (
  alert_id integer primary key,
  workspace_id integer not null references workspace(workspace_id),
  alert_code text not null
);`,
    bindings: { workspace_id: 700 },
    reproductionKey: {
      parameterNames: ['workspace_id'],
      rootRelation: 'workspace',
      rootColumns: ['workspace_id'],
    },
    sourceRelations: [
      {
        name: 'workspace',
        columns: ['workspace_id', 'display_label'],
        rows: [
          [700, 'synthetic workspace orange'],
          [701, 'synthetic workspace teal'],
        ],
      },
      {
        name: 'blocking_alert',
        columns: ['alert_id', 'workspace_id', 'alert_code'],
        rows: [[8001, 701, 'SYN-BLOCK-01']],
      },
    ],
    expectedPlanStatus: 'ready',
    expectedCaptures: {
      workspace: {
        columns: ['display_label', 'workspace_id'],
        rows: [['synthetic workspace orange', 700]],
      },
      blocking_alert: {
        columns: ['alert_code', 'alert_id', 'workspace_id'],
        rows: [],
      },
    },
    expectedResultRows: 1,
    orderedResult: false,
  },
  {
    id: 'fxsel-06-dml-cte-blocked',
    purpose: 'data-modifying CTE remains blocked with zero capture execution',
    sql: `with changed as (
  update synthetic_document
  set document_state = 'archived'
  where document_id = :document_id
  returning document_id, document_state
)
select document_id, document_state
from changed;`,
    ddl: `create table synthetic_document (
  document_id integer primary key,
  document_state text not null
);`,
    bindings: { document_id: 1001 },
    reproductionKey: {
      parameterNames: ['document_id'],
      rootRelation: 'synthetic_document',
      rootColumns: ['document_id'],
    },
    sourceRelations: [],
    expectedPlanStatus: 'blocked',
    expectedBlockedCode: 'DML_CTE_UNSUPPORTED',
    orderedResult: false,
  },
] as const;
