import { test, expect } from "./helpers";
import { IntegrationsPage } from "./pages/integrations.page";

/**
 * E2E tests for the Admin → Integrations panel (Epic #738, Issue #740).
 *
 * Acceptance Criteria Coverage:
 * | # | Criterion                                                       | Test(s)                                                           |
 * |---|-----------------------------------------------------------------|-------------------------------------------------------------------|
 * | 1 | Panel renders with both Airtable and Sheets sections            | should display both Airtable and Google Sheets sections           |
 * | 2 | API key input fields are masked (type="password")               | should render all credential inputs as password fields            |
 * | 3 | Test Connection buttons exist and are clickable                 | should show Test Connection buttons when configured               |
 * | 4 | Save buttons exist for both integrations                        | should display Save buttons for both integrations                 |
 * | 5 | Status indicators show appropriate states                       | should show not-configured state by default                       |
 * |   |                                                                 | should show configured state when credentials are saved           |
 * | 6 | Placeholder shows configured hint after save                    | should update placeholder text when configured                    |
 * | 7 | Navigation to integrations from admin panel                     | should expand Integrations section from collapsed state           |
 */

test.describe("Admin Integrations Panel (#738/#740)", () => {
  let ip: IntegrationsPage;

  test.beforeEach(async ({ page }) => {
    ip = new IntegrationsPage(page);
  });

  // ── AC7: Navigation — Integrations section is on /admin and expandable ──

  test("should expand Integrations section from collapsed state", async () => {
    await ip.goto();

    // Section toggle should be visible even when collapsed
    await ip.sectionToggle.scrollIntoViewIfNeeded();
    await expect(ip.sectionToggle).toBeVisible();

    // Panel content should be hidden when collapsed (defaultOpen=false)
    await expect(ip.panelDescription).toBeHidden();

    // Expand
    await ip.expandSection();
    await expect(ip.panelDescription).toBeVisible();
  });

  // ── AC1: Panel renders with both Airtable and Sheets sections ──

  test("should display both Airtable and Google Sheets sections", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    await expect(ip.airtableHeading).toBeVisible();
    await expect(ip.sheetsHeading).toBeVisible();
    await expect(ip.panelDescription).toBeVisible();
  });

  // ── AC2: API key input fields are masked (type="password") ──

  test("should render all credential inputs as password fields", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    // Airtable PAT input
    await expect(ip.airtableKeyInput).toBeVisible();
    await expect(ip.airtableKeyInput).toHaveAttribute("type", "password");

    // Sheets API key input
    await expect(ip.sheetsApiKeyInput).toBeVisible();
    await expect(ip.sheetsApiKeyInput).toHaveAttribute("type", "password");

    // Sheets OAuth token input
    await expect(ip.sheetsOAuthInput).toBeVisible();
    await expect(ip.sheetsOAuthInput).toHaveAttribute("type", "password");
  });

  // ── AC4: Save buttons exist for both integrations ──

  test("should display Save buttons for both integrations", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    await expect(ip.airtableSaveButton).toBeVisible();
    await expect(ip.sheetsSaveButton).toBeVisible();
  });

  // ── AC4 (continued): Save buttons are disabled when inputs are empty ──

  test("should disable Save buttons when inputs are empty", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    await expect(ip.airtableSaveButton).toBeDisabled();
    await expect(ip.sheetsSaveButton).toBeDisabled();
  });

  // ── AC4 (continued): Save buttons enable when input has content ──

  test("should enable Save button after entering a value", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    // Type into Airtable PAT input → Save should enable
    await ip.airtableKeyInput.fill("pat_test123");
    await expect(ip.airtableSaveButton).toBeEnabled();

    // Type into Sheets API key → Save should enable
    await ip.sheetsApiKeyInput.fill("AIzaTestKey");
    await expect(ip.sheetsSaveButton).toBeEnabled();
  });

  // ── AC5: Status indicators — not configured state ──

  test("should show not-configured state by default", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    // When not configured, Test Connection buttons should NOT appear
    await expect(ip.airtableTestButton).toBeHidden();
    await expect(ip.sheetsTestButton).toBeHidden();

    // Placeholder should show the unconfigured hint
    await expect(ip.airtableKeyInput).toHaveAttribute(
      "placeholder",
      /pat_xxxx/,
    );
  });

  // ── AC5: Status indicators — configured state ──

  test("should show configured state when credentials are saved", async () => {
    await ip.mockStatusConfigured();
    await ip.goto();
    await ip.expandSection();

    // When configured, Test Connection buttons should appear
    await expect(ip.airtableTestButton).toBeVisible();
    await expect(ip.sheetsTestButton).toBeVisible();
  });

  // ── AC6: Placeholder text changes after credentials are configured ──

  test("should update placeholder text when configured", async () => {
    await ip.mockStatusConfigured();
    await ip.goto();
    await ip.expandSection();

    // All three inputs should show the "configured" placeholder
    await expect(ip.airtableKeyInput).toHaveAttribute(
      "placeholder",
      /configured.*update/,
    );
    await expect(ip.sheetsApiKeyInput).toHaveAttribute(
      "placeholder",
      /configured.*update/,
    );
    await expect(ip.sheetsOAuthInput).toHaveAttribute(
      "placeholder",
      /configured.*update/,
    );
  });

  // ── AC3: Test Connection buttons are clickable ──

  test("should invoke test connection API when clicking Test Connection", async ({
    page,
  }) => {
    await ip.mockStatusConfigured();
    await ip.mockTestSuccess();
    await ip.goto();
    await ip.expandSection();

    // Intercept the test call
    const testRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/admin/integrations/test") &&
        req.method() === "POST",
    );

    await ip.airtableTestButton.click();
    const testRequest = await testRequestPromise;
    const body = testRequest.postDataJSON();
    expect(body).toHaveProperty("service", "airtable");
  });

  // ── AC3: Test Connection for Google Sheets ──

  test("should invoke Sheets test connection API", async ({ page }) => {
    await ip.mockStatusConfigured();
    await ip.mockTestSuccess();
    await ip.goto();
    await ip.expandSection();

    const testRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/admin/integrations/test") &&
        req.method() === "POST",
    );

    await ip.sheetsTestButton.click();
    const testRequest = await testRequestPromise;
    const body = testRequest.postDataJSON();
    expect(body).toHaveProperty("service", "sheets");
  });

  // ── AC4: Save sends correct payload ──

  test("should send Airtable save request with entered key", async ({
    page,
  }) => {
    await ip.mockStatusNotConfigured();
    await ip.mockSaveSuccess();
    await ip.goto();
    await ip.expandSection();

    const saveRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/admin/integrations/save") &&
        req.method() === "POST",
    );

    await ip.airtableKeyInput.fill("pat_my_secret_token");
    await ip.airtableSaveButton.click();

    const saveRequest = await saveRequestPromise;
    const body = saveRequest.postDataJSON();
    expect(body).toMatchObject({
      service: "airtable",
      secrets: { "airtable-api-key": "pat_my_secret_token" },
    });
  });

  // ── AC4: Save sends correct payload for Sheets ──

  test("should send Sheets save request with entered credentials", async ({
    page,
  }) => {
    await ip.mockStatusNotConfigured();
    await ip.mockSaveSuccess();
    await ip.goto();
    await ip.expandSection();

    const saveRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/admin/integrations/save") &&
        req.method() === "POST",
    );

    await ip.sheetsApiKeyInput.fill("AIzaMyKey");
    await ip.sheetsSaveButton.click();

    const saveRequest = await saveRequestPromise;
    const body = saveRequest.postDataJSON();
    expect(body).toMatchObject({
      service: "sheets",
      secrets: { "google-sheets-api-key": "AIzaMyKey" },
    });
  });

  // ── AC1/AC2: Labels are visible for all input fields ──

  test("should display labels for all credential fields", async () => {
    await ip.mockStatusNotConfigured();
    await ip.goto();
    await ip.expandSection();

    await expect(ip.airtableLabel).toBeVisible();
    await expect(ip.sheetsApiKeyLabel).toBeVisible();
    await expect(ip.sheetsOAuthLabel).toBeVisible();
  });
});
