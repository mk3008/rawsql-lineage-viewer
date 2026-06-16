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
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'c' }).first()).toHaveCSS('font-size', '15px');
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN')).not.toBeVisible();
  await expect(page.getByRole('group', { name: 'Flow direction' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Downstream' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Upstream' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-zoom')).toHaveText('100%');
  await page.locator('.react-flow__controls-zoomin').click();
  await expect(page.getByTestId('graph-zoom')).not.toHaveText('100%');
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  await expect(page.getByTestId('graph-zoom')).toHaveText('100%');
  await expect(page.locator('.legend').getByText('Derived', { exact: true })).toBeVisible();
  await expect(page.locator('.legend').getByText('Nullable flow', { exact: true })).toBeVisible();
  await expect(page.locator('.legend').getByText('Outer join', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Compress passthrough' })).toHaveCount(0);
  await expect(page.getByTestId('rf__node-main_output').getByText('Passthrough')).toHaveCount(0);
  await expect(page.getByTestId('rf__node-main_output').getByRole('button', { name: 'customer_name', exact: true })).toBeVisible();
  await expect(page.getByTestId('rf__node-main_output').getByRole('button', { name: /passthrough columns/ })).toHaveCount(0);
  await expect(page.getByTestId('rf__node-cte_recent_orders').getByText('Passthrough')).toBeVisible();
  const passthroughToggle = page.getByTestId('rf__node-cte_recent_orders').getByRole('button', { name: 'Show passthrough columns for recent_orders' });
  await expect(passthroughToggle).toBeVisible();
  await expect(passthroughToggle).toHaveCSS('opacity', '0.48');
  const recentOrdersBox = await page.getByTestId('rf__node-cte_recent_orders').boundingBox();
  const passthroughToggleBox = await passthroughToggle.boundingBox();
  expect(recentOrdersBox).not.toBeNull();
  expect(passthroughToggleBox).not.toBeNull();
  expect(passthroughToggleBox!.y).toBeLessThan(recentOrdersBox!.y);
  await expect(page.getByTestId('graph-info')).toContainText('DataFlow');
  await expect(page.getByTestId('graph-info')).toContainText('Derived');
  await expect(page.getByTestId('graph-info')).not.toContainText('JOIN');
  await expect(page.getByTestId('graph-info')).not.toContainText('Warnings');
});

test('can switch the graph flow direction downstream', async ({ page }) => {
  await page.goto('/');

  const customersNode = page.getByTestId('rf__node-table_customers');
  const outputNode = page.getByTestId('rf__node-main_output');
  await expect(page.getByRole('button', { name: 'Upstream' })).toHaveAttribute('aria-pressed', 'true');
  const upstreamCustomersBox = await customersNode.boundingBox();
  const upstreamOutputBox = await outputNode.boundingBox();
  expect(upstreamCustomersBox).not.toBeNull();
  expect(upstreamOutputBox).not.toBeNull();
  expect(upstreamOutputBox!.x).toBeLessThan(upstreamCustomersBox!.x);

  await page.getByRole('button', { name: 'Downstream' }).click();

  await expect(page.getByRole('button', { name: 'Downstream' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-zoom')).toHaveText('100%');
  const downstreamCustomersBox = await customersNode.boundingBox();
  const downstreamOutputBox = await outputNode.boundingBox();
  expect(downstreamCustomersBox).not.toBeNull();
  expect(downstreamOutputBox).not.toBeNull();
  expect(downstreamCustomersBox!.x).toBeLessThan(downstreamOutputBox!.x);
  await expect(page.getByTestId('rf__edge-table_customers-main_output')).toBeAttached();
});

test('can clear the SQL editor on mobile before entering another query', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Hide SQL panel' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Show SQL panel' }).click();

  const editor = page.getByRole('textbox', { name: 'SQL editor' });
  await expect(editor).toHaveValue(/recent_orders AS/);

  await page.getByRole('button', { name: 'Clear SQL editor' }).click();

  await expect(editor).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear SQL editor' })).toBeDisabled();

  await editor.fill('select id from users');
  await expect(page.getByRole('button', { name: 'Clear SQL editor' })).toBeEnabled();
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
  await ordersNode.locator('.lineage-node-header').hover();
  await ordersNode.getByRole('button', { name: 'Hide columns for orders' }).click({ force: true });
  const collapsedBox = await ordersNode.boundingBox();

  await expect(ordersNode.getByText('order_date')).not.toBeVisible();
  await expect(orderItemsNode.getByText('unit_price')).toBeVisible();
  expect(collapsedBox?.height).toBeLessThan((expandedBox?.height ?? 0) - 20);

  await ordersNode.locator('.lineage-node-header').hover();
  await ordersNode.getByRole('button', { name: 'Show columns for orders' }).click({ force: true });
  await expect(ordersNode.getByText('order_date')).toBeVisible();
});

test('groups condition-only and unused CTE columns into sections', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    WITH recent_orders AS (
      SELECT id, customer_id, status, created_at
      FROM orders
    )
    SELECT ro.customer_id
    FROM recent_orders ro
    WHERE ro.status = 'open'
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  await expect(recentOrdersNode.getByText('Passthrough')).toBeVisible();
  await expect(recentOrdersNode.getByText('Condition')).toBeVisible();
  await expect(recentOrdersNode.getByRole('button', { name: 'status', exact: true })).toBeVisible();
  await expect(recentOrdersNode.getByText('Unused')).toBeVisible();
  await expect(recentOrdersNode.getByRole('button', { name: 'id', exact: true })).toHaveCSS('color', 'rgb(185, 28, 28)');
  await expect(recentOrdersNode.getByRole('button', { name: 'created_at', exact: true })).toHaveCSS('color', 'rgb(185, 28, 28)');

  const unusedColumnsToggle = page.getByRole('checkbox', { name: 'Unused columns' });
  await expect(unusedColumnsToggle).toBeChecked();
  await unusedColumnsToggle.uncheck();
  await expect(recentOrdersNode.getByText('Unused')).toHaveCount(0);
  await expect(recentOrdersNode.getByRole('button', { name: 'id', exact: true })).toHaveCount(0);
  await unusedColumnsToggle.check();
  await expect(recentOrdersNode.getByText('Unused')).toBeVisible();

  await recentOrdersNode.getByRole('button', { name: 'status', exact: true }).click();
  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'Used by: WHERE' })).toBeVisible();
});

test('shows GROUP BY usage without simple reference expression callouts', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.goto('/');

  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  await expect(orderTotalsNode.getByText('Condition')).toBeVisible();
  await orderTotalsNode.getByRole('button', { name: 'customer_id', exact: true }).click();

  const callout = page.getByTestId('lineage-comment').filter({ hasText: 'Used by: GROUP BY' });
  await expect(callout).toBeVisible();
  await expect(callout.locator('.lineage-expression')).toHaveCount(0);
  await expect(callout).not.toContainText('Used by: JOIN');
});

test('renders scalar subquery table sources and condition columns', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    WITH ranked_customers AS (
      SELECT c.id AS customer_id
      FROM customers c
    )
    SELECT
      rc.customer_id,
      (
        SELECT count(*)
        FROM orders AS o2
        WHERE o2.customer_id = rc.customer_id
          AND o2.created_at >= :recent_order_from
          AND o2.status <> :refunded_status
      ) AS recent_order_count
    FROM ranked_customers rc
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const ordersNode = page.getByTestId('rf__node-table_orders');
  const outputNode = page.getByTestId('rf__node-main_output');
  await expect(ordersNode).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_orders-main_output')).toBeAttached();
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'o2' })).toBeVisible();
  await expect(ordersNode.getByText('Condition')).toBeVisible();
  await expect(ordersNode.getByRole('button', { name: 'customer_id', exact: true })).toBeVisible();
  await expect(ordersNode.getByRole('button', { name: 'created_at', exact: true })).toBeVisible();
  await expect(ordersNode.getByRole('button', { name: 'status', exact: true })).toBeVisible();

  await outputNode.getByRole('button', { name: 'recent_order_count', exact: true }).click();
  await expect(ordersNode.getByRole('button', { name: 'customer_id', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(ordersNode.getByRole('button', { name: 'created_at', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(ordersNode.getByRole('button', { name: 'status', exact: true })).toHaveClass(/lineage-column-highlighted/);
});

test('shows SQL comments when selecting CTEs and columns', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
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
  await expect(cteComment).not.toContainText('CTE SQL');
  await expect(cteComment).not.toContainText('Comment');
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
  await page.setViewportSize({ width: 1800, height: 1200 });
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
  const referenceColumn = outputNode.getByRole('button', { name: 'paid_amount', exact: true });
  await expect(expression).toHaveCSS('white-space', 'pre');
  await expect(expression).toHaveCSS('font-size', await referenceColumn.evaluate((element) => window.getComputedStyle(element).fontSize));
  await expect(expression).toHaveCSS('font-weight', await referenceColumn.evaluate((element) => window.getComputedStyle(element).fontWeight));
  await expect(expression).toContainText("case\n    when ps.last_paid_at is null then\n        'unknown'");

  const bubble = page.getByTestId('lineage-comment').filter({ hasText: 'case' });
  const initialTransform = await bubble.evaluate((element) => window.getComputedStyle(element).transform);
  await page.locator('.react-flow__controls-zoomin').click();
  await expect.poll(() => bubble.evaluate((element) => window.getComputedStyle(element).transform)).not.toBe(initialTransform);
});

test('formats long expressions without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    SELECT
      CASE
        WHEN q.total_tax - q.cumulative_adjustment_amount > 0 THEN q.total_tax - q.cumulative_adjustment_amount
        ELSE 0
      END AS adjusted_tax
    FROM (
      SELECT 100 AS total_tax, 20 AS cumulative_adjustment_amount
    ) q
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await page.getByTestId('rf__node-main_output').getByRole('button', { name: 'adjusted_tax', exact: true }).click();

  const expression = page.locator('.lineage-expression').filter({ hasText: 'cumulative_adjustment_amount' });
  await expect(expression).toBeVisible();
  await expect(expression).toContainText('case\n');
  const overflow = await expression.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('does not show column callouts for simple column references', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('rf__node-main_output').getByRole('button', { name: 'customer_id', exact: true }).click();

  await expect(page.getByTestId('rf__node-main_output').getByRole('button', { name: 'customer_id', exact: true })).toHaveClass(
    /lineage-column-selected/,
  );
  await expect(page.getByTestId('lineage-comment')).toHaveCount(0);
});

test('compresses passthrough columns by default and can show them per node', async ({ page }) => {
  await page.goto('/');

  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  const outputNode = page.getByTestId('rf__node-main_output');
  await expect(outputNode.getByText('Passthrough')).toHaveCount(0);
  await expect(outputNode.getByRole('button', { name: 'customer_name', exact: true })).toBeVisible();
  await expect(outputNode.getByRole('button', { name: /passthrough columns/ })).toHaveCount(0);
  await expect(recentOrdersNode.getByText('Passthrough')).toBeVisible();
  await expect(recentOrdersNode.getByRole('button', { name: 'customer_id', exact: true })).toHaveCount(0);

  await recentOrdersNode.locator('.lineage-node-header').hover();
  await recentOrdersNode.getByRole('button', { name: 'Show passthrough columns for recent_orders' }).click({ force: true });

  await expect(recentOrdersNode.getByRole('button', { name: 'customer_id', exact: true })).toBeVisible();
  await expect(recentOrdersNode.getByText('Passthrough')).toHaveCount(0);
  await expect(recentOrdersNode.getByRole('button', { name: 'Compress passthrough columns for recent_orders' })).toBeVisible();

  await recentOrdersNode.locator('.lineage-node-header').hover();
  await recentOrdersNode.getByRole('button', { name: 'Compress passthrough columns for recent_orders' }).click({ force: true });

  await expect(recentOrdersNode.getByText('Passthrough')).toBeVisible();
  await expect(recentOrdersNode.getByRole('button', { name: 'customer_id', exact: true })).toHaveCount(0);
});

test('keeps an all-passthrough summary to a single column row height', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    WITH pass AS (
      SELECT c.id, c.name, c.email
      FROM customers c
    )
    SELECT p.id, p.name, p.email
    FROM pass p
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const passNode = page.getByTestId('rf__node-cte_pass');
  const summary = passNode.locator('.lineage-passthrough-summary');
  const body = passNode.locator('.lineage-node-body');
  const header = passNode.locator('.lineage-node-header');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveCSS('white-space', 'nowrap');
  const summaryBox = await summary.boundingBox();
  const bodyBox = await body.boundingBox();
  const headerBox = await header.boundingBox();
  const collapsedNodeBox = await passNode.boundingBox();
  expect(summaryBox?.height).toBeLessThanOrEqual(24);
  expect((bodyBox?.height ?? 0) - (summaryBox?.height ?? 0)).toBeLessThanOrEqual(18);
  expect((collapsedNodeBox?.height ?? 0) - (headerBox?.height ?? 0) - (bodyBox?.height ?? 0)).toBeLessThanOrEqual(2);
  expect(collapsedNodeBox?.height).toBeLessThanOrEqual(88);

  await passNode.locator('.lineage-node-header').hover();
  await passNode.getByRole('button', { name: 'Show passthrough columns for pass' }).click();
  const firstColumn = passNode.getByRole('button', { name: 'id', exact: true });
  await expect(firstColumn).toBeVisible();
  const firstColumnBox = await firstColumn.boundingBox();
  expect(Math.abs((summaryBox?.height ?? 0) - (firstColumnBox?.height ?? 0))).toBeLessThanOrEqual(2);
});

test('shows column callouts for literal expressions', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('select false as a');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await page.getByTestId('rf__node-main_output').getByRole('button', { name: 'a', exact: true }).click();

  await expect(page.getByTestId('lineage-comment').filter({ hasText: 'false' })).toBeVisible();
});

test('hides column callouts when any part of the anchor column is clipped outside the graph viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Downstream' }).click();

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

test('hides column callouts when the bubble would be clipped outside the graph viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Downstream' }).click();

  const paymentSummaryNode = page.getByTestId('rf__node-cte_payment_summary');
  await expect(paymentSummaryNode).toBeVisible();
  await paymentSummaryNode.getByRole('button', { name: 'paid_amount', exact: true }).click();

  const bubble = page.getByTestId('lineage-comment').filter({ hasText: 'sum(p.amount)' });
  await expect(bubble).toBeVisible();

  const nodeBox = await paymentSummaryNode.boundingBox();
  expect(nodeBox).not.toBeNull();
  const graphBox = await page.getByTestId('lineage-graph').boundingBox();
  expect(graphBox).not.toBeNull();
  const dragEndX = graphBox!.x + graphBox!.width - nodeBox!.width - 8;
  await page.mouse.move(nodeBox!.x + 28, nodeBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(dragEndX + 28, nodeBox!.y + 20, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const graph = document.querySelector('[data-testid="lineage-graph"]')?.getBoundingClientRect();
        const node = document.querySelector('[data-testid="rf__node-cte_payment_summary"]');
        const column = Array.from(node?.querySelectorAll('.lineage-column') ?? []).find(
          (element) => element.textContent?.trim() === 'paid_amount',
        );
        const bubbleElement = Array.from(document.querySelectorAll('[data-testid="lineage-comment"]')).find((element) =>
          element.textContent?.includes('sum(p.amount)'),
        );
        if (!graph || !column || !bubbleElement) {
          return false;
        }

        const columnRect = column.getBoundingClientRect();
        const bubbleRect = bubbleElement.getBoundingClientRect();
        const columnFullyVisible =
          columnRect.left >= graph.left && columnRect.right <= graph.right && columnRect.top >= graph.top && columnRect.bottom <= graph.bottom;
        const bubbleClipped =
          bubbleRect.left < graph.left || bubbleRect.right > graph.right || bubbleRect.top < graph.top || bubbleRect.bottom > graph.bottom;
        return columnFullyVisible && bubbleClipped;
      }),
    )
    .toBe(true);
  await expect(bubble).toBeHidden();
});

test('can toggle column and header callouts independently', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
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

test('shows selected lineage details in the inspector panel', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.goto('/');

  await expect(page.getByRole('tab', { name: 'SQL' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'false');
  const outputNode = page.getByTestId('rf__node-main_output');
  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
  const inspector = page.getByTestId('lineage-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('total_amount');
  await expect(inspector).toContainText('Selected');
  await expect(inspector).toContainText('Sources');
  await expect(inspector).toContainText('Upstream');
  await expect(inspector).toContainText('Downstream');
  await expect(inspector).toContainText('coalesce(ot.total_amount, 0)');

  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible();
  await page.getByRole('tab', { name: 'Inspector' }).click();
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('total_amount');

  await page.getByTestId('rf__node-cte_recent_orders').getByRole('button', { name: 'recent_orders', exact: true }).click();
  await expect(inspector).toContainText('recent_orders');
  await expect(inspector).toContainText('Recent order line items used as the base sales fact.');
  await expect(inspector).toContainText('Open in viewer');
  await expect(inspector).toContainText('Copy SQL');
});

test('records analyzed SQL in the history tab and can reopen it', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT u.id, u.name FROM users u');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.getByTestId('sql-history');
  await expect(history).toBeVisible();
  await expect(history).toContainText('SELECT u.id, u.name FROM users u');

  await page.getByRole('tab', { name: 'SQL' }).click();
  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT a.id FROM accounts a');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  await history.locator('.sql-history-main').filter({ hasText: 'SELECT u.id, u.name FROM users u' }).click();
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();
  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue('SELECT u.id, u.name FROM users u');
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
  await rankedCustomersNode.locator('.lineage-node-header').hover();
  await rankedCustomersNode.getByRole('button', { name: 'Collapse inner query for ranked_customers' }).click();

  await expect(rankedCustomersNode).toContainText('Build ranked_customers');
  await expect(rankedCustomersNode).toContainText('Group');
  const collapsedCard = rankedCustomersNode.locator('.lineage-node').first();
  await expect(collapsedCard).toHaveClass(/lineage-node-collapsed-group/);
  await expect(collapsedCard).toHaveCSS('border-top-width', '2px');
  await expect(rankedCustomersNode).toContainText('Output');
  await expect(rankedCustomersNode).toContainText('Input');
  await expect(rankedCustomersNode.getByText('Passthrough')).toBeVisible();
  await expect(rankedCustomersNode.getByTitle('2 passthrough columns hidden')).toBeVisible();
  await expect(rankedCustomersNode.getByRole('button', { name: 'customer_id', exact: true })).toHaveCount(0);
  await expect(rankedCustomersNode.getByRole('button', { name: 'order_count', exact: true })).toHaveCount(0);
  await expect(rankedCustomersNode.getByRole('button', { name: 'open_ticket_count', exact: true })).toBeVisible();
  await expect(rankedCustomersNode).toContainText('order_base');
  await expect(rankedCustomersNode).toContainText('customer_order_summary');
  await expect(rankedCustomersNode).toContainText('support_pressure');
  await expect(page.getByTestId('rf__node-cte_order_base')).not.toBeAttached();
  await expect(page.getByTestId('rf__node-cte_customer_order_summary')).not.toBeAttached();
  await expect(page.getByTestId('rf__node-cte_support_pressure')).not.toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_ranked_customers')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_customers-cte_ranked_customers')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_support_tickets-cte_ranked_customers')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_ranked_customers').locator('.react-flow__edge-path').first()).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_customers-cte_ranked_customers').locator('.react-flow__edge-path').first()).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_support_tickets-cte_ranked_customers').locator('.react-flow__edge-path').first()).toBeVisible();

  await rankedCustomersNode.locator('.lineage-node-header').hover();
  await rankedCustomersNode.getByRole('button', { name: 'Expand Build ranked_customers' }).click();
  await expect(page.getByTestId('rf__node-cte_order_base')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_customer_order_summary')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_support_pressure')).toBeVisible();
});

test('keeps dragged helper node positions and selected columns across group toggles', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Downstream' }).click();

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

  const helperNode = page.getByTestId('rf__node-cte_support_pressure');
  await expect(helperNode).toBeVisible();
  const helperBox = await helperNode.boundingBox();
  expect(helperBox).not.toBeNull();

  await page.mouse.move(helperBox!.x + 28, helperBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(helperBox!.x + 118, helperBox!.y + 80, { steps: 8 });
  await page.mouse.up();
  const draggedTransform = await helperNode.evaluate((element) => window.getComputedStyle(element).transform);

  const rankedCustomersNode = page.getByTestId('rf__node-cte_ranked_customers');
  await rankedCustomersNode.getByRole('button', { name: 'open_ticket_count', exact: true }).click();
  await expect(rankedCustomersNode.getByRole('button', { name: 'open_ticket_count', exact: true })).toHaveClass(/lineage-column-selected/);

  await rankedCustomersNode.locator('.lineage-node-header').hover();
  await rankedCustomersNode.getByRole('button', { name: 'Collapse inner query for ranked_customers' }).click();
  await expect(rankedCustomersNode.getByRole('button', { name: 'open_ticket_count', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(helperNode).not.toBeAttached();

  await rankedCustomersNode.locator('.lineage-node-header').hover();
  await rankedCustomersNode.getByRole('button', { name: 'Expand Build ranked_customers' }).click();

  await expect(helperNode).toBeVisible();
  await expect(helperNode).toHaveCSS('transform', draggedTransform);
  await expect(rankedCustomersNode.getByRole('button', { name: 'open_ticket_count', exact: true })).toHaveClass(/lineage-column-selected/);
});

test('keeps table data flow lines visible when collapsing a sample CTE', async ({ page }) => {
  await page.goto('/');

  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  await expect(orderTotalsNode).toBeVisible();
  await orderTotalsNode.locator('.lineage-node-header').hover();
  await orderTotalsNode.getByRole('button', { name: 'Collapse inner query for order_totals' }).click();

  await expect(orderTotalsNode).toContainText('Build order_totals');
  await expect(orderTotalsNode).toContainText('Output');
  await expect(orderTotalsNode).toContainText('Input');
  await expect(orderTotalsNode.getByRole('button', { name: 'total_amount', exact: true })).toBeVisible();
  await expect(orderTotalsNode).toContainText('recent_orders');
  await expect(page.getByTestId('rf__node-cte_recent_orders')).not.toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_order_totals')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_order_totals')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_order_totals').locator('.react-flow__edge-path').first()).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_order_totals').locator('.react-flow__edge-path').first()).toBeVisible();

  await page.getByTestId('rf__node-main_output').getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first()).toHaveAttribute(
    'style',
    /stroke-width: 5/,
  );
  await expect(page.getByTestId('rf__edge-table_order_items-cte_order_totals').locator('.react-flow__edge-path').first()).toHaveAttribute(
    'style',
    /stroke-width: 5/,
  );
});

test('can collapse nested derived subquery internals and expand them again', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill(`
    SELECT q.customer_id, q.total_amount
    FROM (
      SELECT q.customer_id, q.total_amount
      FROM (
        SELECT o.customer_id, SUM(o.amount) AS total_amount
        FROM orders o
        GROUP BY o.customer_id
      ) q
    ) q
  `);
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  const derivedNodes = page.getByTestId('lineage-node-derived');
  await expect(derivedNodes).toHaveCount(2);
  const outerDerivedNode = page.getByTestId('rf__node-derived_q_1');
  await outerDerivedNode.locator('.lineage-node-header').hover();
  await expect(outerDerivedNode.getByRole('button', { name: 'Collapse inner query for q' })).toBeVisible();

  await outerDerivedNode.getByRole('button', { name: 'Collapse inner query for q' }).click();

  await expect(outerDerivedNode).toContainText('Build q');
  await expect(outerDerivedNode).toContainText('Group');
  await expect(outerDerivedNode).toContainText('Output');
  await expect(outerDerivedNode).toContainText('Input');
  await expect(outerDerivedNode.getByText('Passthrough')).toBeVisible();
  await expect(outerDerivedNode.getByTitle('2 passthrough columns hidden')).toBeVisible();
  await expect(outerDerivedNode.getByRole('button', { name: 'customer_id', exact: true })).toHaveCount(0);
  await expect(outerDerivedNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveCount(0);
  await expect(outerDerivedNode).toContainText('Subquery');
  await expect(outerDerivedNode).toContainText('q');
  await expect(derivedNodes).toHaveCount(1);
  await expect(page.getByTestId('rf__edge-table_orders-derived_q_1')).toBeAttached();
  await expect(page.getByTestId('rf__edge-derived_q_1-main_output')).toBeAttached();

  await outerDerivedNode.locator('.lineage-node-header').hover();
  await outerDerivedNode.getByRole('button', { name: 'Expand Build q' }).click();
  await expect(derivedNodes).toHaveCount(2);
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
  await page.setViewportSize({ width: 1800, height: 1000 });
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
  await expect(orderTotalsComment).toContainText('Total ordered amount per customer.');
  await orderTotalsComment.getByRole('button', { name: 'Close comment' }).click();
  await recentOrdersComment.getByRole('button', { name: 'Close comment' }).click();

  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).not.toHaveClass(/lineage-column-selected/);
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first()).toHaveAttribute('style', /stroke-width: 2/);
  await expect(outputComment).toHaveCount(0);
});

test('highlights downstream output lineage when a source column is selected', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
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
  await page.getByRole('button', { name: 'Downstream' }).click();

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
