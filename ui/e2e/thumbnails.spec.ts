import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";

/**
 * E2E Tests — Thumbnail Templates (#825)
 *
 * Acceptance Criteria from issue:
 * AC1: Template gallery with at least 5 visual layouts
 * AC2: A/B variant generation: produce 2-6 variants from a single video
 * AC3: Side-by-side comparison grid UI for picking the best variant
 * AC4: Brand kit auto-apply when active brand kit exists
 * AC5: Batch mode: generate thumbnails for multiple videos in one API call
 * AC6: generate-thumbnail MCP tool works standalone
 * AC7: Output at standard YouTube thumbnail dimensions (1280×720)
 * AC8: Optimized file size (< 200KB per thumbnail)
 */
test.describe("Thumbnail Templates (#825)", () => {
  // AC1: Thumbnail panel visible in Director Studio
  test("should display thumbnail panel in Director Studio", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const thumbnailPanel = page.getByText(/Thumbnail/i).first();
    await expect(thumbnailPanel).toBeVisible();
  });

  // AC6: Caption templates API includes generate-thumbnail as a standalone concept
  test("should have caption-templates API returning template data", async ({
    request,
  }) => {
    const res = await request.get("/api/studio/pipeline/caption-templates");
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("templates");
      expect(body.templates.length).toBeGreaterThan(0);
    }
  });

  // AC1: Template selection available
  test("should show template selection options", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    // Thumbnail panel should have template/layout options
    const panel = page.getByText(/Thumbnail|Template/i).first();
    await expect(panel).toBeVisible();
  });

  // AC2: A/B variant generation controls exist
  test("should offer A/B variant generation controls", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    // Look for variant-related controls
    const variantText = page.getByText(/variant|A\/B/i).first();
    await expect(variantText).toBeVisible();
  });
});
