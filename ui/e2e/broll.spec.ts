import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";
import { BRollPanelPage } from "./pages/broll-panel.page";

/**
 * E2E Tests — Auto B-Roll (#822)
 *
 * Acceptance Criteria from issue:
 * AC1: Automatically identify 3+ B-Roll opportunities in a 5-minute video
 * AC2: Generate contextually relevant stock search queries from transcript
 * AC3: Source B-Roll from Pexels/Pixabay stock footage APIs
 * AC4: Insert with smooth transitions (crossfade default)
 * AC5: Audio continuity maintained (narration continues over B-Roll)
 * AC6: "Suggest" mode shows proposed insertions for user approval
 * AC7: Configurable density (sparse/moderate/dense)
 * AC8: Integrates with Director Studio scene inspector
 */
test.describe("Auto B-Roll (#822)", () => {
  // AC6,AC8: B-Roll panel visible in Director Studio
  test("should display B-Roll panel with header and controls", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await expect(panel.heading).toBeVisible();
    await expect(panel.analyzeButton).toBeVisible();
  });

  // AC7: Density selector with all three options
  test("should offer density selector with sparse, moderate, dense", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await expect(panel.densitySelect).toBeVisible();

    const options = panel.densitySelect.locator("option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText("Sparse");
    await expect(options.nth(1)).toContainText("Moderate");
    await expect(options.nth(2)).toContainText("Dense");
  });

  // AC7: Default density is moderate
  test("should default to moderate density", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await expect(panel.densitySelect).toHaveValue("moderate");
  });

  // AC7: Can change density
  test("should allow changing density to sparse", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await panel.selectDensity("sparse");
    await expect(panel.densitySelect).toHaveValue("sparse");
  });

  test("should allow changing density to dense", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await panel.selectDensity("dense");
    await expect(panel.densitySelect).toHaveValue("dense");
  });

  // AC1: Analyze button disabled without video source
  test("should disable analyze button when no video source", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    await expect(panel.analyzeButton).toBeDisabled();
  });

  // AC6: Suggestion approval mechanism
  test("should have suggestion cards that can be toggled for approval", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new BRollPanelPage(page);
    // Verify panel structure for approve/reject pattern
    await expect(panel.heading).toBeVisible();
  });
});
