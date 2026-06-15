import { expect, test } from '@playwright/test';

test('renders the sample SQL lineage graph on first load', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'SQL Lineage Viewer' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue(/WITH recent_orders AS/);
  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('lineage-graph')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_order_items')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_recent_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-main_output')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_customers-main_output-LEFT_JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_payment_summary-main_output-LEFT_JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_recent_orders-JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders-JOIN')).toBeAttached();
  await expect(page.getByTestId('graph-info')).toContainText('Edges');
});

test('updates the lineage graph after editing SQL', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT u.id, u.name FROM users u LEFT JOIN accounts a ON a.user_id = u.id');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN').first()).toBeVisible();
});
