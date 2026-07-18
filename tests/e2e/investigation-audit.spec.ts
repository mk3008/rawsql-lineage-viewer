import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const evidenceDir = resolve('tmp/orchestration/viewer-audit-ui');

test.beforeAll(() => {
  mkdirSync(evidenceDir, { recursive: true });
});

test('reviews a static investigation plan without implying execution', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Audit' }).click();

  await expect(page.getByRole('heading', { name: 'Investigation audit' })).toBeVisible();
  await expect(page.getByText('Not executed', { exact: true })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'Submitted SQL' })).toBeVisible();
  const primary = page.getByRole('button', { name: 'Review plan' });
  const before = await primary.boundingBox();
  await primary.focus();
  await expect(primary).toBeFocused();
  await primary.press('Enter');

  await expect(page.getByText('Static review ready')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Safety' })).toBeVisible();
  await expect(page.getByText('No database connection or SQL execution')).toBeVisible();
  await expect(page.getByText(/not executed evidence or a diagnosis/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /run|execute/i })).toHaveCount(0);
  const after = await primary.boundingBox();
  expect(after).toEqual(before);

  await page.screenshot({ path: resolve(evidenceDir, 'audit-ready-1440x900.png'), fullPage: true });
});

test('shows a recoverable static blocker for ambiguous outputs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'New' }).click();
  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT 1 AS repeated, 2 AS repeated');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await page.getByRole('tab', { name: 'Audit' }).click();

  const blocker = page.getByRole('alert');
  await expect(blocker).toContainText('No reviewable target');
  await expect(blocker).toContainText('More than one output has this name');
  await expect(blocker).toContainText('Clarify duplicate outputs');
  await expect(page.getByRole('button', { name: 'Review plan' })).toHaveCount(0);

  await page.screenshot({ path: resolve(evidenceDir, 'audit-ambiguous-1440x900.png'), fullPage: true });
});

test('shows every distinct ambiguity and unsupported blocker', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'New' }).click();
  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT missing.value AS repeated, 2 AS repeated FROM source');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();
  await page.getByRole('tab', { name: 'Audit' }).click();

  const blocker = page.getByRole('alert');
  await expect(blocker).toContainText('More than one output has this name');
  await expect(blocker).toContainText('Static lineage contains unresolved upstream references');
  await expect(blocker.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Review plan' })).toHaveCount(0);
});
