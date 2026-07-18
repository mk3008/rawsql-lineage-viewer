import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import type { LineageModel } from '../domain/lineage';
import { analyzeSql } from './rawsqlAdapter';
import { buildColumnDiagnosticPacket } from './diagnostics';
import { renderDiagnosticPacketText } from './diagnosticText';
import { buildDiagnosticGraphViewModel, buildDiagnosticTreeViewModel } from './diagnosticViewModel';

const representativeDemoColumns = [
  'customer_id',
  'order_count',
  'total_amount',
  'paid_amount',
  'payment_status',
] as const;

describe('column diagnostics', () => {
  it('collects scope facts with top-level WHERE predicates split by AND', () => {
    const { lineage } = analyzeSql(`
      SELECT o.customer_id, o.amount
      FROM orders o
      WHERE o.status = :status
        AND o.created_at >= :from_date
        AND (o.amount > :minimum_amount OR o.priority = true)
    `);
    const scope = lineage.scopes.find((item) => item.id === 'scope_main_output');

    expect(scope).toMatchObject({
      id: 'scope_main_output',
      kind: 'select',
      nodeId: 'main_output',
    });
    expect(scope?.where).toHaveLength(3);
    expect(scope?.where?.map((condition) => condition.splitStrategy)).toEqual([
      'top_level_and',
      'top_level_and',
      'top_level_and',
    ]);
    expect(scope?.where?.map((condition) => condition.expressionSql)).toEqual([
      'o.status = :status',
      'o.created_at >= :from_date',
      '(\n  o.amount > :minimum_amount\n  or o.priority = true\n)',
    ]);
    expect(scope?.where?.[0].references).toEqual([
      {
        columnName: 'status',
        nodeId: 'table_orders',
        provenance: 'anchor',
        role: 'row_lineage',
        scopeId: 'scope_main_output',
      },
    ]);
  });

  it('builds a packet with column lineage, row lineage, candidate concerns, and combined roles', () => {
    const { lineage } = analyzeSql(`
      SELECT o.status
      FROM orders o
      WHERE o.status = :status
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'status',
      nodeId: 'main_output',
    });

    expect(packet.kind).toBe('column-diagnostic-packet');
    expect(packet.version).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(packet.columnLineage, 'sourceColumns')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(packet.columnLineage, 'tree')).toBe(false);
    expect(JSON.stringify(packet)).not.toContain('"comments":[]');
    expect(packet.views.columnLineageTree.derivedFrom).toBe('columnLineage');
    expect(packet.target).toMatchObject({
      columnName: 'status',
      nodeId: 'main_output',
      nodeType: 'output',
      scopeId: 'scope_main_output',
    });
    expect(packet.columnLineage.references).toEqual([
      expect.objectContaining({
        columnName: 'status',
        nodeId: 'table_orders',
        roles: ['column_lineage', 'row_lineage'],
        usages: expect.arrayContaining([
          { role: 'column_lineage', scopeId: 'scope_main_output', usageKind: 'column_value' },
          { role: 'row_lineage', scopeId: 'scope_main_output', usageKind: 'where' },
        ]),
      }),
    ]);
    expect(packet.rowLineage.influences).toEqual([
      expect.objectContaining({
        effects: ['row_filter'],
        expressionSql: 'o.status = :status',
        kind: 'where',
        mechanism: 'where',
        scopeId: 'scope_main_output',
      }),
    ]);
    expect(packet.candidateConcerns).toEqual([
      expect.objectContaining({
        confidence: 'possible',
        impact: ['may_filter_rows'],
        kind: 'where',
        scopeId: 'scope_main_output',
      }),
    ]);
  });

  it('exposes population mechanisms and effects without legacy influence impact fields', () => {
    const { lineage } = analyzeSql(`
      SELECT o.customer_id
      FROM orders o
      WHERE EXISTS (
        SELECT 1
        FROM order_items oi
        WHERE oi.order_id = o.id
      )
      ORDER BY o.customer_id
      LIMIT 10
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'customer_id',
      nodeId: 'main_output',
    });
    const compactInfluences = packet.rowLineage.influences.map((influence) => ({
      effects: influence.effects,
      hasImpact: Object.prototype.hasOwnProperty.call(influence, 'impact'),
      kind: influence.kind,
      mechanism: influence.mechanism,
    }));

    expect(compactInfluences).toEqual([
      expect.objectContaining({
        effects: ['row_filter'],
        hasImpact: false,
        kind: 'where',
        mechanism: 'exists',
      }),
      expect.objectContaining({
        effects: ['output_selection'],
        hasImpact: false,
        kind: 'order_by',
        mechanism: 'order_by',
      }),
      expect.objectContaining({
        effects: ['output_cap'],
        hasImpact: false,
        kind: 'limit',
        mechanism: 'limit',
      }),
    ]);
  });

  it('explains DISTINCT ON keys and representative-row ORDER BY in diagnostics metadata', () => {
    const { lineage } = analyzeSql(`
      SELECT DISTINCT ON (a) a, b, updated_at
      FROM t
      ORDER BY a, updated_at DESC
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'updated_at',
      nodeId: 'main_output',
    });

    expect(packet.rowLineage.influences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effects: ['row_deduplication', 'output_selection'],
        kind: 'distinct_on',
        mechanism: 'distinct_on',
        signals: ['distinct_on', 'order_by'],
      }),
      expect.objectContaining({
        expressionSql: 'updated_at desc',
        effects: ['output_selection'],
        kind: 'order_by',
        mechanism: 'order_by',
      }),
    ]));
    expect(packet.rowLineage.nodeImpacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'main_output',
        signals: expect.arrayContaining(['distinct_on', 'order_by']),
      }),
    ]));
    expect(packet.rowLineage.nodeImpacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'table_t',
        signals: expect.arrayContaining(['distinct_on']),
      }),
    ]));
    expect(packet.candidateConcerns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        impact: ['may_deduplicate_rows', 'may_change_order'],
        kind: 'distinct_on',
        reason: 'This expression is a DISTINCT ON key; for each key, the first row by ORDER BY is selected.',
      }),
    ]));
  });

  it('keeps SELECT DISTINCT as a row-lineage node impact instead of a column badge', () => {
    const { lineage } = analyzeSql(`
      SELECT DISTINCT a, b
      FROM t
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'a',
      nodeId: 'main_output',
    });

    expect(packet.rowLineage.influences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effects: ['row_deduplication'],
        kind: 'distinct',
        mechanism: 'distinct',
        signals: ['distinct'],
      }),
    ]));
    expect(packet.rowLineage.nodeImpacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'main_output',
        signals: ['distinct'],
      }),
    ]));
  });

  it('includes WHERE scopes on the column-lineage route through CTEs', () => {
    const { lineage } = analyzeSql(`
      WITH recent_orders AS (
        SELECT o.customer_id, o.amount
        FROM orders o
        WHERE o.status = :status
      )
      SELECT ro.amount
      FROM recent_orders ro
      WHERE ro.customer_id = :customer_id
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'amount',
      nodeId: 'main_output',
    });

    expect(packet.columnLineage.scopeChain.map((scope) => scope.scopeId)).toEqual(
      expect.arrayContaining(['scope_main_output', 'scope_cte_recent_orders']),
    );
    expect(packet.rowLineage.influences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionSql: 'o.customer_id = :customer_id',
          kind: 'where',
          scopeId: 'scope_cte_recent_orders',
        }),
        expect.objectContaining({
          expressionSql: 'o.status = :status',
          kind: 'where',
          scopeId: 'scope_cte_recent_orders',
        }),
      ]),
    );
  });

  it('allows table column packets as source leaf targets', () => {
    const { lineage } = analyzeSql(`
      SELECT o.amount
      FROM orders o
    `);

    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'amount',
      nodeId: 'table_orders',
    });

    expect(packet.target).toMatchObject({
      columnName: 'amount',
      nodeId: 'table_orders',
      nodeType: 'table',
      scopeId: 'scope_table_orders_source_leaf',
    });
    expect(packet.diagnostics).toEqual(expect.arrayContaining([
      {
        code: 'source_leaf_target',
        message: 'The target is a table column, so it is treated as a source leaf rather than a derived investigation target.',
        scopeId: 'scope_table_orders_source_leaf',
        severity: 'info',
      },
      expect.objectContaining({
        code: 'lineage_metadata_added',
        severity: 'info',
      }),
    ]));
  });

  it('keeps duplicate output column targets distinct in the column-lineage tree', () => {
    const lineage: LineageModel = {
      analysisWarnings: [],
      edges: [],
      kind: 'sql-lineage-model',
      modelVersion: 1,
      nodes: [
        {
          columns: [{ id: 'table_customers.id', name: 'id' }],
          id: 'table_customers',
          label: 'customers',
          type: 'table',
        },
        {
          columns: [{ id: 'table_orders.id', name: 'id' }],
          id: 'table_orders',
          label: 'orders',
          type: 'table',
        },
        {
          columns: [
            {
              id: 'main_output.id.1',
              name: 'id',
              outputIndex: 0,
              scopeId: 'scope_main_output',
              selectItemId: 'scope_main_output_output_1',
              upstream: [{ columnName: 'id', nodeId: 'table_customers' }],
            },
            {
              id: 'main_output.id.2',
              name: 'id',
              outputIndex: 1,
              scopeId: 'scope_main_output',
              selectItemId: 'scope_main_output_output_2',
              upstream: [{ columnName: 'id', nodeId: 'table_orders' }],
            },
          ],
          id: 'main_output',
          label: 'Final Result',
          type: 'output',
        },
      ],
      raw: { adapter: 'rawsql-ts-ast' },
      scopes: [
        {
          id: 'scope_main_output',
          kind: 'select',
          nodeId: 'main_output',
        },
      ],
    };

    const secondId = buildColumnDiagnosticPacket(lineage, {
      columnName: 'id',
      nodeId: 'main_output',
      outputIndex: 1,
      selectItemId: 'scope_main_output_output_2',
    });

    expect(secondId.target).toMatchObject({
      columnName: 'id',
      nodeId: 'main_output',
      outputIndex: 1,
      selectItemId: 'scope_main_output_output_2',
    });
    expect(secondId.views.columnLineageTree.tree[0]).toMatchObject({
      column: expect.objectContaining({
        columnName: 'id',
        nodeId: 'main_output',
        outputIndex: 1,
        selectItemId: 'scope_main_output_output_2',
      }),
      kind: 'column',
    });
    expect(secondId.columnLineage.sourceLeaves).toEqual([
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'table_orders',
      }),
    ]);
  });

  it('builds diagnostic packets for every demo output column', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const outputColumns = output?.columns.filter((column) => column.usage?.role !== 'filter') ?? [];

    expect(outputColumns.map((column) => column.name)).toEqual([
      'customer_id',
      'customer_name',
      'email',
      'order_count',
      'total_amount',
      'paid_amount',
      'payment_status',
    ]);

    for (const column of outputColumns) {
      const packet = buildColumnDiagnosticPacket(lineage, {
        columnName: column.name,
        nodeId: 'main_output',
      });
      expect(packet.target.columnName).toBe(column.name);
      expect(packet.kind).toBe('column-diagnostic-packet');
      expect(packet.rowLineage.influences.map((influence) => influence.kind)).toEqual(expect.arrayContaining(['order_by', 'limit']));
    }
  });

  it('includes demo ORDER BY, LIMIT, EXISTS inner refs, and outer join impacts for customer_id', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'customer_id',
      nodeId: 'main_output',
    });
    const whereExists = packet.rowLineage.influences.find((influence) => influence.kind === 'where' && influence.expressionSql?.toLowerCase().startsWith('exists'));
    const orderBy = packet.rowLineage.influences.find((influence) => influence.kind === 'order_by');
    const limit = packet.rowLineage.influences.find((influence) => influence.kind === 'limit');
    const leftJoins = packet.rowLineage.influences.filter((influence) => influence.kind === 'join_on' && influence.effects.includes('null_extension'));

    expect(whereExists?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ columnName: 'id', nodeId: 'table_customers', provenance: 'anchor', roles: ['row_lineage'] }),
        expect.objectContaining({ columnName: 'customer_id', nodeId: 'table_customer_favorites', provenance: 'related', roles: ['row_lineage'] }),
        expect.objectContaining({ columnName: 'is_active', nodeId: 'table_customer_favorites', provenance: 'related', roles: ['row_lineage'] }),
      ]),
    );
    expect(whereExists?.references.flatMap((reference) => reference.usages.map((usage) => usage.usageKind))).not.toContain('join_on');
    expect(JSON.parse(JSON.stringify(whereExists)).references).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'table_customers', provenance: 'anchor' }),
      expect.objectContaining({ nodeId: 'table_customer_favorites', provenance: 'related' }),
    ]));
    expect(orderBy).toMatchObject({
      effects: ['output_selection'],
      kind: 'order_by',
      mechanism: 'order_by',
      references: [expect.objectContaining({ columnName: 'total_amount', nodeId: 'main_output' })],
      scopeId: 'scope_main_output',
    });
    expect(limit).toMatchObject({
      effects: ['output_cap'],
      kind: 'limit',
      mechanism: 'limit',
      scopeId: 'scope_main_output',
    });
    expect(leftJoins).toHaveLength(0);
    expect(packet.views.columnLineageTree.tree[0]).toMatchObject({
      column: expect.objectContaining({
        columnName: 'customer_id',
        nodeId: 'main_output',
        nodeType: 'output',
      }),
      kind: 'column',
    });
    expect(packet.columnLineage.sourceLeaves).toEqual([
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'table_customers',
        nodeType: 'table',
      }),
    ]);
    expect(packet.rowLineage.nodeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effects: expect.arrayContaining(['row_filter']),
          influenceIds: expect.arrayContaining([whereExists?.id]),
          nodeId: 'cte_customer_scope',
          role: 'population_and_value',
          signals: expect.arrayContaining(['where']),
        }),
        expect.objectContaining({
          effects: expect.arrayContaining(['output_selection', 'output_cap']),
          influenceIds: expect.arrayContaining([limit?.id]),
          nodeId: 'main_output',
          role: 'population_and_value',
          signals: expect.arrayContaining(['limit', 'order_by']),
        }),
      ]),
    );
    expect(packet.rowLineage.nodeImpacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          influenceIds: expect.arrayContaining([whereExists?.id]),
          nodeId: 'table_customer_favorites',
        }),
      ]),
    );
    expect(packet.columnLineage.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'cte_customer_scope',
        roles: ['column_lineage'],
      }),
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'table_customers',
        roles: ['column_lineage', 'row_lineage'],
      }),
    ]));
  });

  it('drops multiply-row impact when a joined CTE is unique by its GROUP BY output key', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'total_amount',
      nodeId: 'main_output',
    });
    const orderTotalsJoin = packet.rowLineage.influences.find((influence) => influence.expressionSql === 'on ot.customer_id = cs.id');
    const paymentSummaryJoin = packet.rowLineage.influences.find((influence) => influence.expressionSql === 'on ps.customer_id = cs.id');

    expect(orderTotalsJoin).toMatchObject({
      effects: ['null_extension'],
      kind: 'join_on',
      mechanism: 'join',
      sourceNodeId: 'cte_order_totals',
    });
    expect(paymentSummaryJoin).toBeUndefined();
    expect(packet.rowLineage.nodeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effects: expect.arrayContaining(['null_extension']),
          influenceIds: expect.arrayContaining([orderTotalsJoin?.id]),
          nodeId: 'main_output',
          role: 'population_and_value',
          signals: expect.arrayContaining(['outer_join']),
        }),
      ]),
    );
    expect(packet.rowLineage.nodeImpacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          influenceIds: expect.arrayContaining([orderTotalsJoin?.id]),
          nodeId: 'cte_order_totals',
        }),
      ]),
    );
  });

  it('keeps local population references separate from aggregated multi-role references', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'customer_name',
      nodeId: 'main_output',
    });

    const whereExists = packet.rowLineage.influences.find((influence) => influence.kind === 'where' && influence.expressionSql?.toLowerCase().startsWith('exists'));
    const customerIdReference = whereExists?.references.find((reference) => reference.nodeId === 'table_customers' && reference.columnName === 'id');

    expect(customerIdReference?.roles).toEqual(['row_lineage']);
    expect(customerIdReference?.usages).toEqual([
      { role: 'row_lineage', scopeId: 'scope_cte_customer_scope', usageKind: 'where' },
    ]);
  });

  it('exposes CASE branch details and aggregate concerns for demo debugging targets', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const paymentStatus = buildColumnDiagnosticPacket(lineage, {
      columnName: 'payment_status',
      nodeId: 'main_output',
    });
    const orderCount = buildColumnDiagnosticPacket(lineage, {
      columnName: 'order_count',
      nodeId: 'main_output',
    });
    const totalAmount = buildColumnDiagnosticPacket(lineage, {
      columnName: 'total_amount',
      nodeId: 'main_output',
    });

    expect(paymentStatus.columnLineage.caseRules).toHaveLength(3);
    expect(paymentStatus.views.columnLineageTree.tree[0]).toMatchObject({
      column: expect.objectContaining({
        columnName: 'payment_status',
        nodeId: 'main_output',
      }),
      children: expect.arrayContaining([
        expect.objectContaining({
          conditionSql: 'ps.last_paid_at is null',
          kind: 'case_rule',
          resultSql: "'unknown'",
        }),
      ]),
      kind: 'column',
    });
    expect(paymentStatus.columnLineage.caseRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conditionRefIds: ['ref:cte_payment_summary:last_paid_at'],
          conditionSql: 'ps.last_paid_at is null',
          resultSql: "'unknown'",
        }),
        expect.objectContaining({
          conditionSql: "ps.last_paid_at < current_date - INTERVAL '30 days'",
          resultSql: "'needs_followup'",
        }),
        expect.objectContaining({
          resultSql: "'active'",
        }),
      ]),
    );
    expect(paymentStatus.columnLineage.expressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'case',
          semanticKind: 'conditional_value',
        }),
        expect.objectContaining({
          kind: 'aggregate',
          semanticKind: 'aggregation',
          sql: 'max(p.paid_at)',
        }),
      ]),
    );
    expect(paymentStatus.candidateConcerns.map((concern) => concern.kind)).toEqual(expect.arrayContaining(['case_when']));
    expect(paymentStatus.candidateConcerns.filter((concern) => concern.kind === 'case_when')).toHaveLength(1);
    expect(orderCount.columnLineage.expressionChain.map((expression) => expression.expressionSql)).toEqual(expect.arrayContaining(['count(*)']));
    expect(orderCount.views.columnLineageTree.tree[0]).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({
          column: expect.objectContaining({
            columnName: 'order_count',
            expressionSql: 'count(*)',
            nodeId: 'cte_order_totals',
          }),
          kind: 'column',
        }),
      ]),
      kind: 'column',
    });
    expect(orderCount.candidateConcerns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          impact: ['may_change_value', 'may_change_grain'],
          kind: 'aggregate_expression',
        }),
      ]),
    );
    expect(totalAmount.candidateConcerns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkDomains: ['data_condition'],
          confidence: 'possible',
          effects: ['source_data_value'],
          evidence: expect.arrayContaining(['order_items.quantity', 'order_items.unit_price']),
          impact: ['may_change_value'],
          kind: 'source_data_value',
        }),
      ]),
    );
    expect(totalAmount.candidateConcerns.find((concern) => concern.kind === 'source_data_value')?.evidence).not.toEqual(
      expect.arrayContaining(['customers.id', 'customer_favorites.customer_id']),
    );
  });

  it('keeps low-priority unrelated LEFT JOINs out of candidate concerns and population influences', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const paymentStatus = buildColumnDiagnosticPacket(lineage, {
      columnName: 'payment_status',
      nodeId: 'main_output',
    });

    expect(paymentStatus.rowLineage.influences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionSql: 'on ps.customer_id = cs.id',
          kind: 'join_on',
        }),
      ]),
    );
    expect(paymentStatus.rowLineage.influences).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionSql: 'on ot.customer_id = cs.id',
          kind: 'join_on',
        }),
      ]),
    );
    expect(paymentStatus.candidateConcerns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: ['on ps.customer_id = cs.id'],
          kind: 'join_on',
        }),
      ]),
    );
    expect(paymentStatus.candidateConcerns).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: ['on ot.customer_id = cs.id'],
          kind: 'join_on',
        }),
      ]),
    );
  });

  it('snapshots representative demo diagnostic packets used for SQL debugging', () => {
    const { lineage } = analyzeSql(salesSummarySql);

    const packets = Object.fromEntries(
      representativeDemoColumns.map((columnName) => [
        columnName,
        buildColumnDiagnosticPacket(lineage, {
          columnName,
          nodeId: 'main_output',
        }),
      ]),
    );

    expect(packets).toMatchSnapshot();
  });

  it('renders representative diagnostic text and view models from packets', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'payment_status',
      nodeId: 'main_output',
    });
    const text = renderDiagnosticPacketText(packet);
    const treeViewModel = buildDiagnosticTreeViewModel(packet);
    const graphViewModel = buildDiagnosticGraphViewModel(packet);

    expect(text).toContain('Target: payment_status (output: Final Result)');
    expect(text).not.toContain('Target: Final Result.payment_status');
    expect(text).toContain('Column Lineage:');
    expect(text).toContain('CASE rules:');
    expect(text).toContain("ps.last_paid_at < current_date - INTERVAL '30 days'");
    expect(treeViewModel.columnLineage.caseRules).toHaveLength(3);
    expect(treeViewModel.json).toContain('"kind": "column-diagnostic-packet"');
    expect(graphViewModel.nodes.some((node) => node.role === 'target')).toBe(true);
    expect(graphViewModel.edges.some((edge) => edge.kind === 'row_lineage')).toBe(true);
    expect(text).toMatchSnapshot();
    expect(treeViewModel).toMatchSnapshot();
    expect(graphViewModel).toMatchSnapshot();
  });
});
