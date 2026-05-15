import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Admin → Integrations panel.
 * Encapsulates locators and interactions for the IntegrationsPanel
 * component added in Epic #738 (Airtable & Google Sheets MCP Integration).
 */
export class IntegrationsPage {
  readonly page: Page;

  // -- Admin page heading --
  readonly adminHeading: Locator;

  // -- SectionCard toggle for Integrations (defaultOpen=false) --
  readonly sectionToggle: Locator;

  // -- Panel description --
  readonly panelDescription: Locator;

  // ── Airtable section ──
  readonly airtableHeading: Locator;
  readonly airtableKeyInput: Locator;
  readonly airtableLabel: Locator;
  readonly airtableSaveButton: Locator;
  readonly airtableTestButton: Locator;
  readonly airtableSection: Locator;

  // ── Google Sheets section ──
  readonly sheetsHeading: Locator;
  readonly sheetsApiKeyInput: Locator;
  readonly sheetsApiKeyLabel: Locator;
  readonly sheetsOAuthInput: Locator;
  readonly sheetsOAuthLabel: Locator;
  readonly sheetsSaveButton: Locator;
  readonly sheetsTestButton: Locator;
  readonly sheetsSection: Locator;

  constructor(page: Page) {
    this.page = page;
    this.adminHeading = page.getByRole("heading", { name: "Administration" });

    // SectionCard renders a <button> containing <h2> with "Integrations"
    this.sectionToggle = page.getByRole("button", { name: "Integrations" });

    this.panelDescription = page.getByText(
      "Configure Airtable and Google Sheets credentials",
    );

    // -- Airtable --
    this.airtableHeading = page.getByRole("heading", { name: "Airtable" });
    this.airtableLabel = page.getByText("Personal Access Token (pat_...)");

    // Scope to the Airtable bordered container first, then locate inputs
    this.airtableSection = page.locator("div.rounded-lg").filter({
      has: page.getByRole("heading", { name: "Airtable", exact: true }),
    });
    this.airtableKeyInput = this.airtableSection.locator(
      'input[type="password"]',
    );
    this.airtableSaveButton = this.airtableSection.getByRole("button", {
      name: "Save",
    });
    this.airtableTestButton = this.airtableSection.getByRole("button", {
      name: /Test Connection/i,
    });

    // -- Google Sheets --
    this.sheetsHeading = page.getByRole("heading", { name: "Google Sheets" });
    this.sheetsApiKeyLabel = page.getByText("API Key (read-only access)");
    this.sheetsOAuthLabel = page.getByText("OAuth2 Access Token (read/write)");

    this.sheetsSection = page
      .locator("div.rounded-lg")
      .filter({ has: page.getByRole("heading", { name: "Google Sheets" }) });
    // Sheets has two password inputs: API key (first) and OAuth token (second)
    this.sheetsApiKeyInput = this.sheetsSection
      .locator('input[type="password"]')
      .first();
    this.sheetsOAuthInput = this.sheetsSection
      .locator('input[type="password"]')
      .last();
    this.sheetsSaveButton = this.sheetsSection.getByRole("button", {
      name: "Save",
    });
    this.sheetsTestButton = this.sheetsSection.getByRole("button", {
      name: /Test Connection/i,
    });
  }

  /** Navigate to /admin and wait for page load */
  async goto() {
    await this.page.goto("/admin");
    await this.page.waitForLoadState("domcontentloaded");
    await this.adminHeading.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Expand the Integrations SectionCard (starts collapsed by default) */
  async expandSection() {
    await this.sectionToggle.scrollIntoViewIfNeeded();
    await this.sectionToggle.click();
    await this.panelDescription.waitFor({ state: "visible", timeout: 5_000 });
  }

  /** Mock the integrations status API — "not configured" state */
  async mockStatusNotConfigured() {
    await this.page.route("**/api/admin/integrations/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          airtable: { configured: false },
          sheets: { configured: false, hasApiKey: false, hasOAuth: false },
        }),
      }),
    );
  }

  /** Mock the integrations status API — "configured" state */
  async mockStatusConfigured() {
    await this.page.route("**/api/admin/integrations/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          airtable: { configured: true },
          sheets: { configured: true, hasApiKey: true, hasOAuth: true },
        }),
      }),
    );
  }

  /** Mock the save endpoint — success */
  async mockSaveSuccess() {
    await this.page.route("**/api/admin/integrations/save", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      }),
    );
  }

  /** Mock the test endpoint — success */
  async mockTestSuccess() {
    await this.page.route("**/api/admin/integrations/test", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, message: "Connection successful!" }),
      }),
    );
  }

  /** Mock the test endpoint — failure */
  async mockTestFailure(message = "Connection failed.") {
    await this.page.route("**/api/admin/integrations/test", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, message }),
      }),
    );
  }
}
