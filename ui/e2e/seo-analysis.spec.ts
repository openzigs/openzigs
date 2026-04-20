import { test, expect } from "./helpers";

/**
 * E2E tests for the SEO Gap Analysis mode on the consolidated /seo page.
 * Migrated from the former Workbench SEO Gap Analysis dialog (#647).
 *
 * These tests navigate to /seo, select the "Gap Analysis" mode, and verify
 * that all form fields and validation behave correctly.
 */

test.describe("SEO Suite — Gap Analysis mode (#647)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/seo");
    // Select Gap Analysis mode
    await page.getByRole("button", { name: "Gap Analysis" }).click();
  });

  test("should show gap-analysis form fields", async ({ page }) => {
    await expect(page.locator("#seo-url")).toBeVisible();
    await expect(page.locator("#seo-keyword")).toBeVisible();
    await expect(page.locator("#seo-provider")).toBeVisible();
    await expect(page.locator("#seo-orch-mode")).toBeVisible();
  });

  test("should show correct placeholder on URL input", async ({ page }) => {
    await expect(page.locator("#seo-url")).toHaveAttribute(
      "placeholder",
      /https:\/\/example\.com/,
    );
  });

  test("should show keyword placeholder", async ({ page }) => {
    await expect(page.locator("#seo-keyword")).toHaveAttribute(
      "placeholder",
      /best project management tools/,
    );
  });

  test("should show search provider options", async ({ page }) => {
    const options = page.locator("#seo-provider option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText(/Auto/);
    await expect(options.nth(1)).toHaveText(/Serper/);
    await expect(options.nth(2)).toHaveText(/Brave/);
  });

  test("should show orchestration mode options", async ({ page }) => {
    const options = page.locator("#seo-orch-mode option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText(/Standard/);
    await expect(options.nth(1)).toHaveText(/Session/);
    await expect(options.nth(2)).toHaveText(/Parallel/);
  });

  test("should show model picker", async ({ page }) => {
    await expect(page.getByText("Model")).toBeVisible();
  });

  test("should show Analyze submit button", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
  });

  test("should show export PDF checkbox checked by default", async ({
    page,
  }) => {
    const checkbox = page.getByRole("checkbox", { name: /export as PDF/i });
    await expect(checkbox).toBeChecked();
  });

  test("should show error for empty URL on submit", async ({ page }) => {
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText(/URL is required/i)).toBeVisible();
  });

  test("should show error for invalid URL on submit", async ({ page }) => {
    await page.locator("#seo-url").fill("not-a-url");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText(/valid URL/i)).toBeVisible();
  });

  test("should clear error when switching modes", async ({ page }) => {
    // Trigger error
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText(/URL is required/i)).toBeVisible();

    // Switch mode
    await page.getByRole("button", { name: "Site Audit" }).click();
    await expect(page.getByText(/URL is required/i)).toBeHidden();
  });
});
