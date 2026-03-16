import { test, expect, navigateTo } from './helpers';

test.describe('Outbox', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/outbox');
  });

  test('page heading is visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Publishing Outbox', level: 1 })).toBeVisible();
  });

  test('subtitle describes the page', async ({ page }) => {
    await expect(page.getByText('Queue content for autonomous publishing across platforms')).toBeVisible();
  });

  test('stats cards display status counts', async ({ page }) => {
    await expect(page.getByText('Pending')).toBeVisible();
    await expect(page.getByText('Processing')).toBeVisible();
    await expect(page.getByText('Published')).toBeVisible();
    await expect(page.getByText('Failed')).toBeVisible();
    await expect(page.getByText('Canceled')).toBeVisible();
    await expect(page.getByText('Total')).toBeVisible();
  });

  test('platform filter dropdown is present', async ({ page }) => {
    const select = page.locator('select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('all');
  });

  test('queue section exists', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
  });

  test('empty state message when no items', async ({ page }) => {
    await expect(page.getByText('No items in the outbox')).toBeVisible();
    await expect(page.getByText('Queue text, files, gallery assets, or URLs for publishing')).toBeVisible();
  });

  test('navigation link exists in navbar', async ({ page }) => {
    const navLink = page.getByRole('link', { name: 'Outbox' });
    await expect(navLink).toBeVisible();
  });

  test('New Item button is visible in header', async ({ page }) => {
    const btn = page.getByRole('button', { name: 'New Item' });
    await expect(btn).toBeVisible();
  });

  test('New Item button opens the publishing modal', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add to Publishing Queue' })).toBeVisible();
  });

  test('modal has source tabs', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await expect(page.getByRole('button', { name: 'Text' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gallery' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'URL' })).toBeVisible();
  });

  test('modal can be closed with cancel', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add to Publishing Queue' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Add to Publishing Queue' })).not.toBeVisible();
  });

  test('empty state CTA opens the modal', async ({ page }) => {
    // The empty state should also have a "New Item" CTA
    const cta = page.locator('text=No items in the outbox').locator('..').getByRole('button', { name: 'New Item' });
    await cta.click();
    await expect(page.getByRole('heading', { name: 'Add to Publishing Queue' })).toBeVisible();
  });

  test('modal defaults to Text tab with content textarea', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await expect(page.getByPlaceholder('Write or paste your post content')).toBeVisible();
  });

  test('switching to URL tab shows URL input', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await expect(page.getByPlaceholder('https://example.com/content')).toBeVisible();
  });

  // ── Multi-platform selector tests ─────────────────────────

  test('modal shows multi-platform pill selector instead of dropdown', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    // Should have platform pill buttons, not a <select>
    await expect(page.getByRole('button', { name: '𝕏 / Twitter' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'LinkedIn' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pinterest' })).toBeVisible();
  });

  test('twitter platform is selected by default', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    const twitterBtn = page.getByRole('button', { name: '𝕏 / Twitter' });
    await expect(twitterBtn).toHaveClass(/border-primary/);
  });

  test('can select multiple platforms', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'LinkedIn' }).click();
    // Both should be selected
    await expect(page.getByRole('button', { name: '𝕏 / Twitter' })).toHaveClass(/border-primary/);
    await expect(page.getByRole('button', { name: 'LinkedIn' })).toHaveClass(/bg-primary/);
    // Submit button should show count
    await expect(page.getByRole('button', { name: /Queue \(2 platforms\)/ })).toBeVisible();
  });

  // ── AI Generate (URL tab) tests ───────────────────────────

  test('URL tab shows AI Content Generation section', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await expect(page.getByText('AI Content Generation')).toBeVisible();
  });

  test('AI Generate button is visible on URL tab', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await expect(page.getByRole('button', { name: 'AI Generate' })).toBeVisible();
  });

  test('AI Generate button is disabled without URL input', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await expect(page.getByRole('button', { name: 'AI Generate' })).toBeDisabled();
  });

  test('AI Generate button enables after entering URL', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await page.getByPlaceholder('https://example.com/content').fill('https://example.com/article');
    await expect(page.getByRole('button', { name: 'AI Generate' })).toBeEnabled();
  });

  test('URL tab has image source options', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    await expect(page.getByText('Pull from site')).toBeVisible();
    await expect(page.getByText('Generate')).toBeVisible();
    await expect(page.getByText('None')).toBeVisible();
  });

  test('URL tab has model picker', async ({ page }) => {
    await page.getByRole('button', { name: 'New Item' }).click();
    await page.getByRole('button', { name: 'URL' }).click();
    // Model picker is a <select> inside the AI generation section
    const aiSection = page.locator('text=AI Content Generation').locator('..');
    await expect(aiSection.locator('select')).toBeVisible();
  });
});
