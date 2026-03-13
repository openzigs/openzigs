/**
 * E2E tests for Epic #446 — Skills-First Automation Redesign
 *
 * Covers:
 *  1. Skills Admin page  (/admin/skills) — view, create, edit, delete custom skills
 *  2. Prompt Library     (/library)       — suggestedSkill dropdown, skill badge on cards
 *  3. Scheduler          (/scheduler)     — skill selector in job form, cron builder
 *  4. Integration        — prompt with skill → linked to a scheduled job
 *
 * ALL tests clean up after themselves: any prompts, skills, or jobs created
 * during a test are deleted via API calls in afterEach hooks.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { navigateTo } from './helpers.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3000';

function getToken(): string {
  try {
    const config = JSON.parse(
      readFileSync(join(homedir(), '.openzigs', 'config.json'), 'utf8')
    );
    return (config?.auth?.token as string) ?? '';
  } catch {
    return process.env.E2E_TOKEN ?? '';
  }
}

const TOKEN = getToken();

/** Build auth headers for direct API cleanup requests */
function authHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ─── API helpers (cleanup) ────────────────────────────────────────────────────

async function deletePromptByName(request: APIRequestContext, name: string) {
  const res = await request.get(`${API_BASE}/api/admin/prompts`, { headers: authHeaders() });
  if (!res.ok()) return;
  const data = await res.json() as { prompts: Array<{ id: string; name: string }> };
  const prompt = data.prompts?.find((p) => p.name === name);
  if (prompt) {
    await request.delete(`${API_BASE}/api/admin/prompts/${prompt.id}`, {
      headers: authHeaders(),
    });
  }
}

async function deleteJobByName(request: APIRequestContext, name: string) {
  const res = await request.get(`${API_BASE}/api/admin/jobs`, {
    headers: authHeaders(),
  });
  if (!res.ok()) return;
  const data = await res.json() as { jobs: Array<{ id: string; name: string }> };
  const job = data.jobs?.find((j) => j.name === name);
  if (job) {
    await request.delete(`${API_BASE}/api/admin/jobs/${job.id}`, {
      headers: authHeaders(),
    });
  }
}

async function deleteSkillByName(request: APIRequestContext, name: string) {
  await request.delete(`${API_BASE}/api/admin/skills/${name}`, { headers: authHeaders() });
}

// ─── 1. Skills Admin Page ─────────────────────────────────────────────────────

/** Wait for the skills data to load (proves React is hydrated and API call complete) */
async function waitForSkillsLoad(page: Page) {
  await page.getByRole('heading', { name: 'Content Creator' }).waitFor({ timeout: 10_000 });
}

test.describe('Skills Admin (/admin/skills) — Epic #446', () => {
  test('shows page heading and link back to admin', async ({ page }) => {
    await navigateTo(page, '/admin/skills');
    await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: '← Admin' })).toBeVisible();
  });

  test('displays all 8 built-in skills with Built-in badge', async ({ page }) => {
    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);

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
    for (const name of expectedSkills) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    // Use exact: true to avoid matching "built-in" in the page subtitle
    const builtInBadges = page.getByText('Built-in', { exact: true });
    await expect(builtInBadges).toHaveCount(8);
  });

  test('each built-in skill has a View button', async ({ page, request }) => {
    // Pre-clean any stale test skill from a previous failed run (would inflate View button count)
    await deleteSkillByName(request, 'e2e-test-skill');
    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);
    const viewButtons = page.getByRole('button', { name: 'View' });
    await expect(viewButtons).toHaveCount(8);
  });

  test('View button opens skill detail with Allowed Tools section', async ({ page }) => {
    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);
    await page.getByRole('button', { name: 'View' }).first().click();
    // Skill detail view shows a dedicated "Allowed Tools" heading
    await expect(page.getByRole('heading', { name: 'Allowed Tools' })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('New Skill button opens create form with disabled Create Skill button', async ({
    page,
  }) => {
    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);

    await page.getByRole('button', { name: 'New Skill' }).click();
    // h1 changes to "Create Skill" when in create view
    await expect(
      page.getByRole('heading', { name: 'Create Skill', level: 1 })
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Skill Name' })).toBeVisible();
    // Create Skill submit button is disabled until name is filled
    await expect(page.getByRole('button', { name: 'Create Skill' })).toBeDisabled();
  });

  test('create, verify, and delete a custom skill (full lifecycle)', async ({
    page,
    request,
  }) => {
    const skillName = 'e2e-test-skill';

    // Cleanup pre-existing leftover in case a prior test run failed
    await deleteSkillByName(request, skillName);

    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);

    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create Skill', level: 1 })
    ).toBeVisible();

    // Fill skill name — "Create Skill" button should enable
    await page.getByRole('textbox', { name: 'Skill Name' }).fill(skillName);
    await expect(page.getByRole('button', { name: 'Create Skill' })).toBeEnabled({
      timeout: 3_000,
    });

    // Update the SKILL.md content in the textarea
    await page.locator('textarea').fill(
      `---\nname: ${skillName}\ndescription: E2E test skill\nallowed-tools: web-search\n---\n# E2E Test Skill\n## Description\nCreated by Playwright E2E tests.`
    );

    await page.getByRole('button', { name: 'Create Skill' }).click();

    // The new skill card should appear — the card shows the slug name (e.g., "e2e-test-skill")
    // as a subtitle paragraph even if the displayName is capitalised differently
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 8_000 });

    // Cleanup via API
    await deleteSkillByName(request, skillName);

    // Reload and verify it is gone
    await page.reload();
    await waitForSkillsLoad(page);
    await expect(page.getByRole('heading', { name: skillName })).not.toBeVisible();
  });

  test('Cancel button on create form returns to skills list', async ({ page }) => {
    await navigateTo(page, '/admin/skills');
    await waitForSkillsLoad(page);

    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create Skill', level: 1 })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    // Should be back on the gallery list view
    await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
  });
});

// ─── 2. Prompt Library — suggestedSkill ───────────────────────────────────────

/** Wait for the prompt list to load so React has hydrated and data is available */
async function waitForPromptsLoad(page: Page) {
  await page.getByText('Daily Pinterest Trends & Metrics').first().waitFor({ timeout: 10_000 });
}

/**
 * Locates the "Suggested Skill" combobox in the New Prompt form.
 * The combobox has "content-creator" etc. as option values / text,
 * and the Brand Voice combobox never has those options.
 */
function suggestedSkillSelect(page: Page) {
  return page.locator('select').filter({
    has: page.locator('option', { hasText: 'content-creator' }),
  });
}

test.describe('Prompt Library — suggestedSkill (Epic #446)', () => {
  test('New Prompt form shows Suggested Skill dropdown with all 8 skills', async ({ page }) => {
    await navigateTo(page, '/library');
    await waitForPromptsLoad(page);
    await page.getByRole('button', { name: '+ New Prompt' }).click();

    const skillSelect = suggestedSkillSelect(page);
    await expect(skillSelect).toBeVisible({ timeout: 5_000 });

    const expectedSkillNames = [
      'content-creator',
      'knowledge-curator',
      'media-director',
      'pinterest-marketer',
      'platform-manager',
      'remix-engineer',
      'research-synthesizer',
      'system-operator',
    ];
    for (const name of expectedSkillNames) {
      await expect(skillSelect.locator(`option`, { hasText: name })).toHaveCount(1);
    }
  });

  test('create a prompt with suggestedSkill, verify badge, then delete', async ({
    page,
    request,
  }) => {
    const promptName = 'e2e-skill-prompt';
    await deletePromptByName(request, promptName);

    await navigateTo(page, '/library');
    await waitForPromptsLoad(page);
    await page.getByRole('button', { name: '+ New Prompt' }).click();

    await page.getByPlaceholder('e.g., daily-summary').fill(promptName);
    await page.getByPlaceholder('What this prompt does…').fill('E2E test prompt for Epic #446');
    await page
      .getByPlaceholder(/Write your prompt template here/)
      .fill('Research the latest news on {{topic}}');

    // Select a skill via the options-based locator
    await suggestedSkillSelect(page).selectOption('research-synthesizer');

    await page.getByRole('button', { name: 'Save Prompt' }).click();

    // After save, the form closes and the new prompt card appears
    await expect(page.getByText(promptName)).toBeVisible({ timeout: 8_000 });
    // The skill badge should be visible on the card
    await expect(page.getByText('research-synthesizer')).toBeVisible();

    // Cleanup
    await deletePromptByName(request, promptName);
  });

  test('existing Pinterest prompt shows pinterest-marketer skill badge', async ({ page }) => {
    await navigateTo(page, '/library');
    await waitForPromptsLoad(page);
    // The pre-loaded Pinterest prompt should have suggestedSkill = pinterest-marketer
    await expect(page.getByText('pinterest-marketer')).toBeVisible();
  });

  test('Schedule button from library navigates to scheduler with prompt pre-selected', async ({
    page,
  }) => {
    await navigateTo(page, '/library');
    await waitForPromptsLoad(page);
    // Click Schedule on the first prompt card that has the button
    await page.getByRole('button', { name: 'Schedule' }).first().click();
    // Should end up at /scheduler with a new job form open
    await expect(page).toHaveURL(/\/scheduler/);
    await expect(page.getByRole('heading', { name: /New Job|Edit Job/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ─── 3. Scheduler — skill selector ───────────────────────────────────────────

/** Wait for the scheduler job list to load */
async function waitForJobsLoad(page: Page) {
  await page.getByText('Daily Pinterest Trends & Metrics').first().waitFor({ timeout: 10_000 });
}

/**
 * Locates the "Skill" combobox in the New/Edit Job form.
 * Only the skill select has emoji-prefix options like "✍️ Content Creator".
 */
function schedulerSkillSelect(page: Page) {
  return page.locator('select').filter({
    has: page.locator('option', { hasText: 'Content Creator' }),
  });
}

test.describe('Scheduler — skill selector and cron builder (Epic #446)', () => {
  test('New Job form shows Skill dropdown with all 8 skills', async ({ page }) => {
    await navigateTo(page, '/scheduler');
    await waitForJobsLoad(page);
    await page.getByRole('button', { name: '+ New Job' }).click();

    const skillCombobox = schedulerSkillSelect(page);
    await expect(skillCombobox).toBeVisible({ timeout: 5_000 });

    const expectedOptions = [
      'Content Creator',
      'Knowledge Curator',
      'Media Director',
      'Pinterest Marketer',
      'Platform Manager',
      'Remix Engineer',
      'Research Synthesizer',
      'System Operator',
    ];
    for (const opt of expectedOptions) {
      await expect(skillCombobox.locator('option', { hasText: opt })).toHaveCount(1);
    }
  });

  test('New Job form has Simple/Advanced schedule mode toggle', async ({ page }) => {
    await navigateTo(page, '/scheduler');
    await waitForJobsLoad(page);
    await page.getByRole('button', { name: '+ New Job' }).click();

    await expect(page.getByRole('button', { name: 'Simple' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Advanced' })).toBeVisible();
  });

  test('Simple schedule mode shows preset buttons and Next runs preview', async ({ page }) => {
    await navigateTo(page, '/scheduler');
    await waitForJobsLoad(page);
    await page.getByRole('button', { name: '+ New Job' }).click();

    // Switch to Simple mode
    await page.getByRole('button', { name: 'Simple' }).click();

    // Quick presets should appear
    await expect(page.getByRole('button', { name: 'Hourly' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Daily' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Weekdays' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Weekly' })).toBeVisible();

    // Select "Daily" — then "Next runs" preview appears
    await page.getByRole('button', { name: 'Daily' }).click();
    await expect(page.getByText('Next runs')).toBeVisible({ timeout: 3_000 });
  });

  test('Edit existing Pinterest job shows skill selector', async ({ page }) => {
    await navigateTo(page, '/scheduler');
    await waitForJobsLoad(page);
    // Click Edit on the first job (Daily Pinterest Trends & Metrics)
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await expect(page.getByRole('heading', { name: 'Edit Job' })).toBeVisible();
    // The skill dropdown should be present with all options
    const skillCombobox = schedulerSkillSelect(page);
    await expect(skillCombobox).toBeVisible();
    await expect(
      skillCombobox.locator('option', { hasText: 'Pinterest Marketer' })
    ).toHaveCount(1);
  });

  test('New Job form allows selecting skill and setting schedule', async ({ page, request }) => {
    const jobName = 'e2e-test-skill-job';
    await deleteJobByName(request, jobName);

    await navigateTo(page, '/scheduler');
    await waitForJobsLoad(page);
    await page.getByRole('button', { name: '+ New Job' }).click();

    // Fill the job name
    await page.getByPlaceholder('e.g., daily-report').fill(jobName);

    // Set skill
    await schedulerSkillSelect(page).selectOption('research-synthesizer');

    // Set "Daily" in Simple mode
    await page.getByRole('button', { name: 'Simple' }).click();
    await page.getByRole('button', { name: 'Daily' }).click();

    // Verify the schedule was applied ("Next runs" preview appears after selecting a preset)
    await expect(page.getByText('Next runs')).toBeVisible({ timeout: 3_000 });

    // Cancel — we verified the form works without creating real data
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Scheduler', level: 1 })).toBeVisible();
  });
});

// ─── 4. Integration: prompt + skill + scheduler ────────────────────────────────

test.describe('Integration — prompt with skill → scheduler job (Epic #446)', () => {
  const promptName = 'e2e-integration-prompt';
  const jobName = 'e2e-integration-job';

  test.afterEach(async ({ request }) => {
    await deletePromptByName(request, promptName);
    await deleteJobByName(request, jobName);
  });

  test('create prompt with skill via API — suggestedSkill persists', async ({ request }) => {
    // Create a prompt with suggestedSkill
    const createRes = await request.post(`${API_BASE}/api/admin/prompts`, {
      headers: authHeaders(),
      data: {
        name: promptName,
        description: 'E2E integration test for Epic #446',
        template: 'Summarize the latest research on {{topic}}',
        suggestedSkill: 'research-synthesizer',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    // POST /api/admin/prompts returns the prompt object directly (not wrapped in { prompt: ... })
    const created = (await createRes.json()) as { id: string; suggestedSkill: string };
    expect(created.suggestedSkill).toBe('research-synthesizer');

    // Verify the prompt appears in the list with suggestedSkill
    const listRes = await request.get(`${API_BASE}/api/admin/prompts`, {
      headers: authHeaders(),
    });
    const listData = (await listRes.json()) as {
      prompts: Array<{ name: string; suggestedSkill?: string }>;
    };
    const found = listData.prompts.find((p) => p.name === promptName);
    expect(found).toBeDefined();
    expect(found?.suggestedSkill).toBe('research-synthesizer');
  });

  test('prompt skill badge is visible in Library UI after API creation', async ({
    page,
    request,
  }) => {
    // Create via API
    await request.post(`${API_BASE}/api/admin/prompts`, {
      headers: authHeaders(),
      data: {
        name: promptName,
        description: 'E2E prompt skill badge test',
        template: 'Analyze {{query}}',
        suggestedSkill: 'research-synthesizer',
      },
    });

    await navigateTo(page, '/library');
    await waitForPromptsLoad(page);
    await expect(page.getByText(promptName)).toBeVisible();
    // The skill badge on the card
    await expect(page.getByText('research-synthesizer')).toBeVisible();
  });

  test('create scheduler job linked to prompt — actionPayload persists via API', async ({
    request,
  }) => {
    // Create a prompt with suggestedSkill
    const promptRes = await request.post(`${API_BASE}/api/admin/prompts`, {
      headers: authHeaders(),
      data: {
        name: promptName,
        description: 'E2E integration test',
        template: 'Analyze {{query}}',
        suggestedSkill: 'research-synthesizer',
      },
    });
    expect(promptRes.ok()).toBeTruthy();

    // Create a scheduler job linked to that prompt
    // POST /api/admin/jobs returns the job object directly (not wrapped in { job: ... })
    const jobRes = await request.post(`${API_BASE}/api/admin/jobs`, {
      headers: authHeaders(),
      data: {
        name: jobName,
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        enabled: false,
        actionType: 'prompt',
        actionPayload: { promptName },
      },
    });
    expect(jobRes.ok()).toBeTruthy();
    const job = (await jobRes.json()) as {
      id: string;
      name: string;
      actionPayload: { promptName: string };
    };
    expect(job.name).toBe(jobName);
    expect(job.actionPayload.promptName).toBe(promptName);
  });

  test('scheduler job list shows linked prompt name', async ({ page, request }) => {
    // Create prompt
    await request.post(`${API_BASE}/api/admin/prompts`, {
      headers: authHeaders(),
      data: {
        name: promptName,
        description: 'E2E prompt for scheduler test',
        template: 'Daily rundown of {{topic}}',
        suggestedSkill: 'research-synthesizer',
      },
    });
    // Create job
    const jobRes = await request.post(`${API_BASE}/api/admin/jobs`, {
      headers: authHeaders(),
      data: {
        name: jobName,
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        enabled: false,
        actionType: 'prompt',
        actionPayload: { promptName },
      },
    });
    const job = (await jobRes.json()) as { id: string };
    expect(job.id).toBeTruthy();

    await navigateTo(page, '/scheduler');
    // Wait for jobs to load then verify our new job and its linked prompt appear
    await page.getByText(jobName).waitFor({ timeout: 8_000 });
    // The prompt name should appear in the job's detail section
    await expect(page.getByText(promptName)).toBeVisible({ timeout: 6_000 });
  });
});
