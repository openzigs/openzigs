import { test } from "@playwright/test";

/**
 * Epic #910 — Issue #833: UI: NLE export dialog for FCP XML and EDL
 *
 * Audit ACs (2026-04-19):
 *   AC1: Format selector (FCP XML, EDL)             ✅ pre-existing
 *   AC2: Track selection for multi-track exports
 *   AC3: Download button that triggers file save
 *   AC4: Success toast with file path               ✅ pre-existing
 *   AC5: Accessible from Director Studio toolbar    ✅ pre-existing
 *
 * Wiring status (PR #913):
 *   - <NleTrackSelector> implemented at
 *       ui/components/director/studio/nle-track-selector.tsx (+ unit tests)
 *   - <NleDownloadButton> referenced in the PR description was not found on
 *     disk in this pass; the matching `downloadFile` helper was also absent.
 *   - Neither track selector nor browser download trigger is wired into
 *     nle-export-panel.tsx; AC2 and AC3 have no live UI surface.
 */
test.describe("Epic #910 / Issue #833 — NLE export track selector & browser download", () => {
  test.fixme("AC2: NLE export panel renders per-track checkboxes (video / audio / captions / b-roll)", async () => {
    // BLOCKED: <NleTrackSelector> not mounted in nle-export-panel.tsx.
  });

  test.fixme("AC3: Export action triggers a real browser download (Blob URL or <a download>)", async () => {
    // BLOCKED: no download trigger; the panel still surfaces the server
    // path as text only.
  });
});
