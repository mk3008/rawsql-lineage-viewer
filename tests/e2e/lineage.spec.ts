import { expect, test } from '@playwright/test';

test('renders the sample SQL lineage graph on first load', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'SQL Lineage Viewer' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue(/recent_orders AS/);
  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('lineage-graph')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_order_items')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_recent_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-main_output')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_customers-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_payment_summary-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_recent_orders')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders')).toBeAttached();

  const outerDataFlowStyle = await page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first().getAttribute('style');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'c' })).toBeVisible();
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'oi' })).toBeVisible();
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'ot' })).toBeVisible();
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'ps' })).toBeVisible();
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN')).not.toBeVisible();
  await expect(page.getByText('Flow direction')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Downstream' })).not.toBeVisible();
  await expect(page.locator('.legend').getByText('Derived', { exact: true })).toBeVisible();
  await expect(page.locator('.legend').getByText('Nullable flow', { exact: true })).toBeVisible();
  await expect(page.locator('.legend').getByText('Outer join', { exact: true })).not.toBeVisible();
  await expect(page.getByTestId('graph-info')).toContainText('DataFlow');
  await expect(page.getByTestId('graph-info')).toContainText('Derived');
  await expect(page.getByTestId('graph-info')).not.toContainText('JOIN');
  await expect(page.getByTestId('graph-info')).not.toContainText('Warnings');
});

test('renders outer join nullability context on data flows without separate join edges', async ({ page }) => {
  await page.goto('/');

  const dataFlowEdge = page.getByTestId('rf__edge-table_customers-main_output');
  const outerDataFlowEdge = page.getByTestId('rf__edge-cte_order_totals-main_output');

  await expect(dataFlowEdge).toBeAttached();
  await expect(outerDataFlowEdge).toBeAttached();
  const outerDataFlowStyle = await outerDataFlowEdge.locator('.react-flow__edge-path').first().getAttribute('style');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');
});

test('shows referenced columns and can hide columns per node', async ({ page }) => {
  await page.goto('/');

  const ordersNode = page.getByTestId('rf__node-table_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');
  const outputNode = page.getByTestId('rf__node-main_output');

  await expect(ordersNode.getByText('order_date')).toBeVisible();
  await expect(orderItemsNode.getByText('unit_price')).toBeVisible();
  await expect(outputNode.getByText('customer_name')).toBeVisible();

  const expandedBox = await ordersNode.boundingBox();
  await page.locator('button[aria-label="Hide columns for orders"]').click();
  const collapsedBox = await ordersNode.boundingBox();

  await expect(ordersNode.getByText('order_date')).not.toBeVisible();
  await expect(orderItemsNode.getByText('unit_price')).toBeVisible();
  expect(collapsedBox?.height).toBeLessThan((expandedBox?.height ?? 0) - 20);

  await page.locator('button[aria-label="Show columns for orders"]').click();
  await expect(ordersNode.getByText('order_date')).toBeVisible();
});

test('shows SQL comments when selecting CTEs and columns', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = text;
        },
      },
    });
  });
  await page.goto('/');

  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  await recentOrdersNode.getByRole('button', { name: 'recent_orders', exact: true }).click();
  const cteComment = page.getByTestId('lineage-comment').filter({ hasText: 'Recent order line items used as the base sales fact.' });
  await expect(cteComment).toContainText('Recent order line items used as the base sales fact.');
  await expect(cteComment).toContainText('CTE SQL');
  await expect(cteComment.locator('.lineage-sql-preview')).toHaveCount(0);
  await expect(cteComment).toHaveCSS('position', 'fixed');
  await expect(cteComment).toHaveCSS('z-index', '100001');
  const recentOrdersBox = await recentOrdersNode.boundingBox();
  const cteCommentBox = await cteComment.boundingBox();
  expect(cteCommentBox?.x ?? 0).toBeGreaterThanOrEqual((recentOrdersBox?.x ?? 0) + (recentOrdersBox?.width ?? 0) + 6);
  const openInViewerLink = cteComment.getByRole('link', { name: 'Open in viewer' });
  await expect(openInViewerLink).toBeVisible();
  const openInViewerHref = await openInViewerLink.getAttribute('href');
  expect(openInViewerHref).toContain('#sql=');
  expect(new URLSearchParams(new URL(openInViewerHref ?? '').hash.replace(/^#/, '')).get('sql')).toMatch(/from\s+orders as o/);
  await cteComment.getByRole('button', { name: 'Copy SQL' }).click();
  await expect(cteComment.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText ?? ''))
    .toMatch(/from\s+orders as o/);
  await cteComment.getByRole('button', { name: 'Close comment' }).click();
  await expect(cteComment).toHaveCount(0);

  await recentOrdersNode.getByRole('button', { name: 'amount', exact: true }).click();
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'Extended line amount.' })).toContainText('Extended line amount.');
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'oi.quantity * oi.unit_price' })).toBeVisible();
});

test('shows title comments for output and derived nodes', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    -- Final output comment.
    SELECT src.id AS user_id -- Output id comment.
    FROM (
      -- Derived source comment.
      SELECT id -- Derived id comment.
      FROM users
    ) src
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const outputNode = page.getByTestId('rf__node-main_output');
  await outputNode.getByRole('button', { name: 'Final Result', exact: true }).click();
  const outputComment = page.getByTestId('lineage-comment').filter({ hasText: 'Final output comment.' });
  await expect(outputComment).toContainText('Final output comment.');
  await expect(outputComment).toContainText('Output id comment.');
  await outputComment.getByRole('button', { name: 'Close comment' }).click();

  const derivedNode = page.getByTestId('lineage-node-derived');
  await derivedNode.getByRole('button', { name: 'src', exact: true }).click();
  const derivedComment = page.getByTestId('lineage-comment').filter({ hasText: 'Derived source comment.' });
  await expect(derivedComment).toContainText('Derived source comment.');
  await expect(derivedComment).toContainText('Derived id comment.');
});

test('preserves formatted expression line breaks', async ({ page }) => {
  await page.goto('/');

  const outputNode = page.getByTestId('rf__node-main_output');
  await outputNode.getByRole('button', { name: 'payment_status', exact: true }).click();

  const expression = page.locator('.lineage-expression').filter({ hasText: 'case' });
  const referenceColumn = outputNode.getByRole('button', { name: 'customer_id', exact: true });
  await expect(expression).toHaveCSS('white-space', 'pre');
  await expect(expression).toHaveCSS('font-size', await referenceColumn.evaluate((element) => window.getComputedStyle(element).fontSize));
  await expect(expression).toHaveCSS('font-weight', await referenceColumn.evaluate((element) => window.getComputedStyle(element).fontWeight));
  await expect(expression).toContainText("case\n    when ps.last_paid_at is null then\n        'unknown'");

  const bubble = page.getByTestId('lineage-comment').filter({ hasText: 'case' });
  const initialTransform = await bubble.evaluate((element) => window.getComputedStyle(element).transform);
  await page.locator('.react-flow__controls-zoomin').click();
  await expect.poll(() => bubble.evaluate((element) => window.getComputedStyle(element).transform)).not.toBe(initialTransform);
});

test('hides column callouts when any part of the anchor column is clipped outside the graph viewport', async ({ page }) => {
  await page.goto('/');

  const paymentSummaryNode = page.getByTestId('rf__node-cte_payment_summary');
  await expect(paymentSummaryNode).toBeVisible();
  await paymentSummaryNode.getByRole('button', { name: 'paid_amount', exact: true }).click();

  const bubble = page.getByTestId('lineage-comment').filter({ hasText: 'sum(p.amount)' });
  await expect(bubble).toBeVisible();

  const nodeBox = await paymentSummaryNode.boundingBox();
  expect(nodeBox).not.toBeNull();
  const graphBox = await page.getByTestId('lineage-graph').boundingBox();
  expect(graphBox).not.toBeNull();
  const dragEndX = graphBox!.x - nodeBox!.width + 55;
  await page.mouse.move(nodeBox!.x + 28, nodeBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(dragEndX, nodeBox!.y + 20, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const graph = document.querySelector('[data-testid="lineage-graph"]')?.getBoundingClientRect();
        const node = document.querySelector('[data-testid="rf__node-cte_payment_summary"]');
        const column = Array.from(node?.querySelectorAll('.lineage-column') ?? []).find(
          (element) => element.textContent?.trim() === 'paid_amount',
        );
        if (!graph || !column) {
          return false;
        }

        const rect = column.getBoundingClientRect();
        const isPartiallyClipped = rect.left < graph.left || rect.right > graph.right || rect.top < graph.top || rect.bottom > graph.bottom;
        const stillPartlyVisible = rect.right > graph.left && rect.left < graph.right && rect.bottom > graph.top && rect.top < graph.bottom;
        return isPartiallyClipped && stillPartlyVisible;
      }),
    )
    .toBe(true);
  await expect(bubble).toBeHidden();
});

test('can toggle column and header callouts independently', async ({ page }) => {
  await page.goto('/');

  const columnCallouts = page.getByRole('checkbox', { name: 'Column callouts' });
  const headerCallouts = page.getByRole('checkbox', { name: 'Header callouts' });
  await expect(columnCallouts).toBeChecked();
  await expect(headerCallouts).toBeChecked();

  const outputNode = page.getByTestId('rf__node-main_output');
  await columnCallouts.uncheck();
  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'coalesce(ot.total_amount, 0)' })).toHaveCount(0);

  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  await headerCallouts.uncheck();
  await recentOrdersNode.getByRole('button', { name: 'recent_orders', exact: true }).click();
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'Recent order line items used as the base sales fact.' })).toHaveCount(0);

  await headerCallouts.check();
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'Recent order line items used as the base sales fact.' })).toBeVisible();
});

test('opens SQL from the sql hash parameter on first load', async ({ page }) => {
  const sql = 'select c.customer_id from customers c';
  await page.goto(`/#sql=${encodeURIComponent(sql)}`);

  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue(sql);
  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_customers')).toBeVisible();
});

test('keeps legacy sql query parameter links working', async ({ page }) => {
  const sql = 'select a.id from accounts a';
  await page.goto(`/?sql=${encodeURIComponent(sql)}`);

  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue(sql);
  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();
});

test('copies a share URL for the current SQL', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = text;
        },
      },
    });
  });
  await page.goto('/');

  const sql = 'select u.id from users u';
  await page.getByRole('textbox', { name: 'SQL editor' }).fill(sql);
  await page.getByRole('button', { name: 'Share' }).click();

  await expect(page.getByRole('status')).toContainText('Share URL copied');
  const copiedUrl = await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText ?? '');
  const parsedUrl = new URL(copiedUrl);
  expect(parsedUrl.pathname).toBe('/');
  expect(parsedUrl.search).toBe('');
  expect(new URLSearchParams(parsedUrl.hash.replace(/^#/, '')).get('sql')).toBe(sql);
});

test('does not copy a share URL when the SQL is too long', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = text;
        },
      },
    });
  });
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`select '${'x'.repeat(9000)}' as very_long_sql`);
  await page.getByRole('button', { name: 'Share' }).click();

  await expect(page.getByRole('status')).toContainText('SQL is too long for a share URL');
  await expect.poll(() => page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText ?? '')).toBe('');
});

test('can hide and show columns for all nodes', async ({ page }) => {
  await page.goto('/');

  const ordersNode = page.getByTestId('rf__node-table_orders');
  const outputNode = page.getByTestId('rf__node-main_output');

  await page.getByRole('button', { name: 'Hide all columns' }).click();

  await expect(page.getByRole('button', { name: 'Show all columns' })).toBeVisible();
  await expect(ordersNode.getByText('order_date')).not.toBeVisible();
  await expect(outputNode.getByText('customer_name')).not.toBeVisible();

  await page.getByRole('button', { name: 'Show all columns' }).click();

  await expect(page.getByRole('button', { name: 'Hide all columns' })).toBeVisible();
  await expect(ordersNode.getByText('order_date')).toBeVisible();
  await expect(outputNode.getByText('customer_name')).toBeVisible();
});

test('can collapse upstream helper CTEs into a CTE group and expand them again', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    WITH order_base AS (
      SELECT o.id, o.customer_id, o.total_amount
      FROM orders o
    ),
    customer_order_summary AS (
      SELECT c.id AS customer_id, COUNT(ob.id) AS order_count
      FROM customers c
      LEFT JOIN order_base ob ON ob.customer_id = c.id
      GROUP BY c.id
    ),
    support_pressure AS (
      SELECT st.customer_id, COUNT(st.id) AS open_ticket_count
      FROM support_tickets st
      GROUP BY st.customer_id
    ),
    ranked_customers AS (
      SELECT cos.customer_id, cos.order_count, COALESCE(sp.open_ticket_count, 0) AS open_ticket_count
      FROM customer_order_summary cos
      LEFT JOIN support_pressure sp ON sp.customer_id = cos.customer_id
    )
    SELECT rc.customer_id, rc.order_count, rc.open_ticket_count
    FROM ranked_customers rc
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const rankedCustomersNode = page.getByTestId('rf__node-cte_ranked_customers');
  await expect(rankedCustomersNode).toBeVisible();
  await rankedCustomersNode.getByRole('button', { name: 'Collapse upstream helpers for ranked_customers' }).click();

  await expect(rankedCustomersNode).toContainText('Build ranked_customers');
  await expect(rankedCustomersNode).toContainText('3 helper CTEs');
  await expect(rankedCustomersNode).toContainText('3 source nodes');
  await expect(page.getByTestId('rf__node-cte_order_base')).not.toBeAttached();
  await expect(page.getByTestId('rf__node-cte_customer_order_summary')).not.toBeAttached();
  await expect(page.getByTestId('rf__node-cte_support_pressure')).not.toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_ranked_customers')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_customers-cte_ranked_customers')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_support_tickets-cte_ranked_customers')).toBeAttached();

  await rankedCustomersNode.getByRole('button', { name: 'Expand Build ranked_customers' }).click();
  await expect(page.getByTestId('rf__node-cte_order_base')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_customer_order_summary')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_support_pressure')).toBeVisible();
});

test('shows all expanded columns without node resizing or vertical scrolling', async ({ page }) => {
  await page.goto('/');

  const node = page.getByTestId('rf__node-cte_recent_orders');
  await expect(node).toBeVisible();
  await expect(node.getByText('amount')).toBeVisible();
  await expect(page.locator('[aria-label="Resize recent_orders height"]')).toHaveCount(0);

  const overflowY = await node.locator('.lineage-node-body').evaluate((element) => window.getComputedStyle(element).overflowY);
  expect(overflowY).toBe('visible');
});

test('highlights upstream lineage when an output column is selected', async ({ page }) => {
  await page.goto('/');

  const outputNode = page.getByTestId('rf__node-main_output');
  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');

  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();

  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(orderTotalsNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(recentOrdersNode.getByRole('button', { name: 'amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(orderItemsNode.getByRole('button', { name: 'quantity', exact: true })).toHaveClass(/lineage-column-source/);
  await expect(orderItemsNode.getByRole('button', { name: 'unit_price', exact: true })).toHaveClass(/lineage-column-source/);
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 5/);
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 5/);
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output')).not.toHaveClass(/animated/);
  const outputComment = page.getByTestId('lineage-comment').filter({ hasText: 'coalesce(ot.total_amount, 0)' });
  const orderTotalsComment = page.getByTestId('lineage-comment').filter({ hasText: 'Total ordered amount per customer.' });
  const recentOrdersComment = page.getByTestId('lineage-comment').filter({ hasText: 'Extended line amount.' });
  await expect(outputComment).toContainText('coalesce(ot.total_amount, 0)');
  await expect(orderTotalsComment).toContainText('Total ordered amount per customer.');
  await expect(recentOrdersComment).toContainText('Extended line amount.');
  await expect(outputComment).toHaveCSS('z-index', '100001');
  await recentOrdersComment.click();
  await expect(recentOrdersComment).toHaveCSS('z-index', '100001');
  await expect(outputComment).toHaveCSS('z-index', '100000');
  await outputComment.getByRole('button', { name: 'Close comment' }).click();
  await expect(outputComment).toHaveCount(0);
  await expect(orderTotalsComment).toContainText('Total ordered amount per customer.');
  await orderTotalsComment.getByRole('button', { name: 'Close comment' }).click();
  await recentOrdersComment.getByRole('button', { name: 'Close comment' }).click();

  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).not.toHaveClass(/lineage-column-selected/);
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 2/);
  await expect(outputComment).toHaveCount(0);
});

test('highlights downstream output lineage when a source column is selected', async ({ page }) => {
  await page.goto('/');

  const outputNode = page.getByTestId('rf__node-main_output');
  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');

  await orderItemsNode.getByRole('button', { name: 'quantity', exact: true }).click();

  await expect(orderItemsNode.getByRole('button', { name: 'quantity', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(recentOrdersNode.getByRole('button', { name: 'amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(orderTotalsNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 5/);
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 5/);
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'coalesce(ot.total_amount, 0)' })).toContainText(
    'coalesce(ot.total_amount, 0)',
  );
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'oi.quantity * oi.unit_price' })).toBeVisible();
});

test('can drag lineage nodes to separate overlapping lines', async ({ page }) => {
  await page.goto('/');

  const node = page.getByTestId('rf__node-table_orders');
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  const beforeTransform = await node.getAttribute('style');
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + 28, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 118, before!.y + 90, { steps: 8 });
  await page.mouse.up();

  await expect(node).not.toHaveAttribute('style', beforeTransform ?? '');
});

test('keeps dragged node positions when selecting a column', async ({ page }) => {
  await page.goto('/');

  const node = page.getByTestId('rf__node-table_orders');
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + 28, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 118, before!.y + 90, { steps: 8 });
  await page.mouse.up();

  const draggedTransform = await node.evaluate((element) => window.getComputedStyle(element).transform);
  await node.getByRole('button', { name: 'order_date', exact: true }).click();

  await expect(node).toHaveCSS('transform', draggedTransform);
});

test('updates the lineage graph after editing SQL', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT u.id, u.name FROM users u LEFT JOIN accounts a ON a.user_id = u.id');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_accounts-main_output')).toBeAttached();
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN')).not.toBeVisible();
});
