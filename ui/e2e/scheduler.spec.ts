import { test, expect, navigateTo } from './helpers';

test.describe('Scheduler', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/scheduler');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Scheduler', level: 1 })).toBeVisible();
    await expect(page.getByText('Schedule recurring prompts, shell commands, and custom actions.')).toBeVisible();
  });

  test('new job button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: '+ New Job' })).toBeVisible();
  });

  test('scheduled jobs section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible();
  });

  test('job cards show cron expression and timezone', async ({ page }) => {
    // Each job card should display a cron expression
    const cronBadge = page.locator('code').filter({ hasText: /\d+ \d+ \*/ }).first();
    await expect(cronBadge).toBeVisible();

    // Timezone should be visible
    const timezone = page.getByText(/America\/New_York|UTC/).first();
    await expect(timezone).toBeVisible();
  });

  test('job cards have action buttons', async ({ page }) => {
    // Each job should have Run, Dry Run, Edit, Delete buttons
    await expect(page.getByRole('button', { name: '▶ Run' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '🧪 Dry Run' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' }).first()).toBeVisible();
  });

  test('job cards have enable/disable toggle', async ({ page }) => {
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible();
  });

  test('job cards show run history info', async ({ page }) => {
    // Should show run count and last run timestamp
    const runsText = page.getByText(/Runs: \d+/).first();
    await expect(runsText).toBeVisible();

    const lastText = page.getByText(/Last:/).first();
    await expect(lastText).toBeVisible();
  });

  test('history button is present on job cards', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'History' }).first()).toBeVisible();
  });

  test('linked prompts navigate to library', async ({ page }) => {
    // Jobs linked to prompts show a link to library
    const promptLink = page.getByRole('link', { name: /java-code-review-daily|daily-standup/ }).first();
    if (await promptLink.isVisible().catch(() => false)) {
      await expect(promptLink).toHaveAttribute('href', /\/library\?search=/);
    }
  });

  test('Ask AI button and help panel', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Ask AI' })).toBeVisible();
    await expect(page.getByText('Ask me anything about this page')).toBeVisible();

    // Suggested questions
    await expect(page.getByRole('button', { name: /cron expression/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /automated job with a skill/ })).toBeVisible();
  });

  test('scheduled jobs section is collapsible', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Scheduled Jobs' });
    await toggle.click();
    // After collapsing, job cards should be hidden
    const runBtn = page.getByRole('button', { name: '▶ Run' }).first();
    await expect(runBtn).toBeHidden();
    // Expand again
    await toggle.click();
    await expect(runBtn).toBeVisible();
  });
});
