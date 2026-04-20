import { test } from "@playwright/test";

/**
 * Epic #910 — Issue #830: UI: Caption template gallery and per-word editor
 *
 * Audit ACs (2026-04-19):
 *   AC1: Template gallery displays all 6 caption styles with visual previews
 *   AC2: Clicking a template applies it to the current draft  ✅ pre-existing
 *   AC3: Per-word editor allows timing adjustment & style overrides
 *   AC4: Brand kit colours auto-apply when supportsBrandKit is enabled
 *
 * Wiring status (PR #913):
 *   - <CaptionTemplatePreview> implemented at
 *       ui/components/director/studio/caption-template-preview.tsx
 *   - <CaptionWordEditor> implemented at
 *       ui/components/director/studio/caption-word-editor.tsx (+ unit tests)
 *   Neither is imported by caption-style-panel.tsx, so the AC1 / AC3 / AC4
 *   user-facing surfaces do not exist yet. All e2e assertions below are
 *   parked as `test.fixme` for the FIX phase to flip.
 */
test.describe("Epic #910 / Issue #830 — Caption template gallery & per-word editor", () => {
  test.fixme("AC1: caption-style panel renders 6 visual template previews", async () => {
    // BLOCKED: <CaptionTemplatePreview> not wired into caption-style-panel.tsx.
    // Component logic covered by caption-template-preview.test.tsx (if present)
    // and AC2 (click-to-apply) is already covered by existing UI.
  });

  test.fixme("AC3: per-word editor allows drag-to-retime and style overrides", async () => {
    // BLOCKED: <CaptionWordEditor> not mounted anywhere in the studio UI.
    // Per-word logic is covered by caption-word-editor.test.tsx.
  });

  test.fixme("AC4: brand kit colours auto-apply when template.supportsBrandKit is true", async () => {
    // BLOCKED: no integration point reads the brand kit and feeds it into
    // <CaptionTemplatePreview>. Awaiting caption-style-panel rewrite.
  });
});
