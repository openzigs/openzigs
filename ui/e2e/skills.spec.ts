import { test, expect, navigateTo } from './helpers';

test.describe('Skills Editor', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/skills');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
    await expect(page.getByText('Manage built-in and custom SKILL.md skill files')).toBeVisible();
  });

  test('new skill button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
  });

  test('built-in skill cards are rendered', async ({ page }) => {
    const expectedSkills = [
      'Content Creator',
      'Knowledge Curator',
      'Media Director',
      'Pinterest Marketer',
      'Platform Manager',
      'Remix Engineer',
      'Research Synthesizer',
      'System Operator',
    ];

    for (const skill of expectedSkills) {
      await expect(page.getByRole('heading', { name: skill, level: 3 })).toBeVisible();
    }
  });

  test('skill cards show Built-in badge', async ({ page }) => {
    const badges = page.getByText('Built-in', { exact: true });
    await expect(badges.first()).toBeVisible();
    // Should have at least one Built-in badge visible
    expect(await badges.count()).toBeGreaterThanOrEqual(1);
  });

  test('skill cards show description', async ({ page }) => {
    // Media Director card should show its description
    await expect(page.getByText(/Orchestrates image generation.*media queue/)).toBeVisible();
  });

  test('skill cards show tool tags', async ({ page }) => {
    // Check that tool tags appear on cards (use .first() in case multiple skills share a tool name)
    await expect(page.getByText('web-search').first()).toBeVisible();
    await expect(page.getByText('submit-media-job').first()).toBeVisible();
  });

  test('skill cards have View button', async ({ page }) => {
    const viewBtns = page.getByRole('button', { name: 'View' });
    await expect(viewBtns.first()).toBeVisible();
    // At least 8 built-in skills; may be more if custom skills exist during parallel test runs
    expect(await viewBtns.count()).toBeGreaterThanOrEqual(8);
  });

  test('overflow tool count indicator', async ({ page }) => {
    // Some cards show "+N more" for overflow tools
    const overflow = page.getByText(/\+\d+ more/).first();
    await expect(overflow).toBeVisible();
  });

  test('clicking View opens skill detail', async ({ page }) => {
    // Click View on the first skill card
    await page.getByRole('button', { name: 'View' }).first().click();

    // Detail view should show the SKILL.md editor section
    // beforeEach navigates fresh for each test, so no cleanup needed here
    await expect(page.getByText('SKILL.md Content')).toBeVisible({ timeout: 5_000 });
  });
});
