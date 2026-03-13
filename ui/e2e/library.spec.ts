import { test, expect, navigateTo } from './helpers';

test.describe('Library', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/library');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Prompt Library', level: 1 })).toBeVisible();
    await expect(page.getByText('Create, edit, and manage reusable prompt templates.')).toBeVisible();
  });

  test('search input is present', async ({ page }) => {
    await expect(page.getByPlaceholder('Search prompts…')).toBeVisible();
  });

  test('action buttons are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'From Template' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New Prompt' })).toBeVisible();
  });

  test('saved prompts section with items', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Saved Prompts' })).toBeVisible();

    // Should have at least one prompt card with action buttons
    const firstCard = page.locator('main').getByRole('button', { name: 'Edit' }).first();
    await expect(firstCard).toBeVisible();
  });

  test('prompt cards have expected action buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Use as System Prompt' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export' }).first()).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: 'Edit' }).first()).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: 'Delete' }).first()).toBeVisible();
  });

  test('prompt cards show tags', async ({ page }) => {
    // Check for tags on any card  
    const tags = page.locator('main').getByText(/pinterest|seo|daily|release|java|standup/).first();
    await expect(tags).toBeVisible();
  });

  test('Ask AI panel is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Ask AI' })).toBeVisible();
  });

  test('help panel shows suggested questions', async ({ page }) => {
    const helpPanel = page.getByText('Ask me anything about this page');
    await expect(helpPanel).toBeVisible();

    await expect(page.getByRole('button', { name: /best way to set up a media generation prompt/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /How do skills work with library prompts/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /multi-stage pipeline template/ })).toBeVisible();
  });

  test('search filters prompts', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search prompts…');
    await searchInput.fill('java');
    // Should see only java-related prompts
    await expect(page.getByText('java-code-review-daily')).toBeVisible();
  });

  test('saved prompts section is collapsible', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Saved Prompts' });
    await toggle.click();
    // After collapsing, prompt cards should be hidden
    const editBtn = page.locator('main').getByRole('button', { name: 'Edit' }).first();
    await expect(editBtn).toBeHidden();
    // Expand again
    await toggle.click();
    await expect(editBtn).toBeVisible();
  });
});
