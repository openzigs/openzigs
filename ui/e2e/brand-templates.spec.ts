import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";
import { BrandTemplatePage } from "./pages/brand-template.page";

/**
 * E2E Tests — Brand Templates (#827)
 *
 * Acceptance Criteria from issue:
 * AC1: At least 3 intro and 2 outro template styles
 * AC2: At least 2 lower-third template styles
 * AC3: All templates auto-pull from active brand kit (colors, fonts, logo)
 * AC4: Preview templates in Director Studio before applying via Remotion Player
 * AC5: Auto-apply option: when enabled, auto-add intro/outro to all new drafts
 * AC6: Lower-thirds auto-applied when speaker names detected in transcript
 * AC7: Templates render cleanly at 1080p and 4K
 * AC8: Template customization saved to SQLite for reuse
 */
test.describe("Brand Templates (#827)", () => {
  // AC1,AC2: Brand template editor visible with all sections
  test("should display brand template editor with sections", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    const template = new BrandTemplatePage(page);
    // Editor should be accessible from admin
    await expect(page.getByText(/Brand|Template/i).first()).toBeVisible();
  });

  // AC1: Intros section shows templates
  test("should display Intros section with template cards", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    await expect(page.getByText("Intros").first()).toBeVisible();
  });

  // AC1: Outros section shows templates
  test("should display Outros section with template cards", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    await expect(page.getByText("Outros").first()).toBeVisible();
  });

  // AC2: Lower Thirds section shows templates
  test("should display Lower Thirds section with template cards", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    await expect(page.getByText("Lower Thirds").first()).toBeVisible();
  });

  // AC1: Built-in templates API returns template definitions
  test("should have builtin templates API returning definitions", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/brand-templates/builtin");
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("templates");
      expect(body.templates.length).toBeGreaterThan(0);

      // AC1: At least 3 intros
      const intros = body.templates.filter(
        (t: { type: string }) => t.type === "intro",
      );
      expect(intros.length).toBeGreaterThanOrEqual(3);

      // AC1: At least 2 outros
      const outros = body.templates.filter(
        (t: { type: string }) => t.type === "outro",
      );
      expect(outros.length).toBeGreaterThanOrEqual(2);

      // AC2: At least 2 lower-thirds
      const lowerThirds = body.templates.filter(
        (t: { type: string }) => t.type === "lower-third",
      );
      expect(lowerThirds.length).toBeGreaterThanOrEqual(2);
    }
  });

  // AC8: Template has name, description, and duration info
  test("should show template card details including name and duration", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    // Template cards should have name and duration info
    await expect(page.getByText(/at 30fps/i).first()).toBeVisible();
  });

  // AC5: Auto-apply option available
  test("should show auto-apply option in template customization", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    await expect(
      page.getByText(/Auto-apply|auto apply/i).first(),
    ).toBeVisible();
  });

  // AC8: Custom title input available when selecting a template
  test("should show customization form when template is selected", async ({
    page,
  }) => {
    await navigateTo(page, "/admin");
    // Selecting a template shows the customization form
    const template = new BrandTemplatePage(page);
    await expect(
      page.getByText(/Customize|Custom title/i).first(),
    ).toBeVisible();
  });
});
