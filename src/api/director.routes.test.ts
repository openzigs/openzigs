/**
 * Route-equivalence snapshot for the Director router.
 *
 * The Director router (`src/api/director.ts`) is being split into per-domain
 * sub-routers (#1113, #1143, #1165–#1168). This test pins the *complete*
 * (method, path) tuple set the composed router registers. Any decomposition
 * checkpoint that drifts from the snapshot is, by definition, a behavior
 * change and must be rejected.
 *
 * The snapshot is intentionally hand-maintained: a regression here means a
 * route went missing or moved. Update only when you intend to change the
 * public API.
 */

import { describe, expect, it } from "vitest";
import { Router } from "express";
import { createDirectorRouter } from "./director.js";

interface RouteEntry {
  method: string;
  path: string;
}

function listRoutes(router: Router): RouteEntry[] {
  const out: RouteEntry[] = [];
  // Express internals — typed as any because the stack/layer API is not public.
  const stack: any[] = (router as any).stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      const path: string = layer.route.path;
      const methods = layer.route.methods ?? {};
      for (const method of Object.keys(methods)) {
        if (methods[method]) {
          out.push({ method: method.toUpperCase(), path });
        }
      }
    } else if (layer.handle && (layer.handle as any).stack) {
      // Nested router mounted via router.use(path, subRouter).
      // For now Director doesn't mount sub-routers under a prefix, but
      // tolerate it for future decomposition steps.
      for (const r of listRoutes(layer.handle as Router)) {
        out.push(r);
      }
    }
  }
  return out;
}

function normalize(entries: RouteEntry[]): string[] {
  return entries
    .map((e) => `${e.method} ${e.path}`)
    .sort((a, b) => a.localeCompare(b));
}

function buildRouter(): Router {
  // Registration only reads option values; no I/O is triggered until a route
  // handler runs. Therefore mock-objects-as-any are sufficient for the
  // snapshot test.
  const router = createDirectorRouter({
    copilot: {} as any,
    voiceService: {} as any,
    renderOrchestrator: {} as any,
    brandVoiceService: {} as any,
    toolRegistry: {} as any,
    config: {
      enabled: true,
      outputDir: "/tmp/director-out",
      defaultTemplate: "Minimalist",
      assets: {
        localLibraryPath: "/tmp/director-lib",
        downloadCachePath: "/tmp/director-cache",
        pixabayApiKey: "",
        jamendoClientId: "",
        pexelsApiKey: "",
      },
    },
  });
  return router;
}

/**
 * Baseline snapshot captured from `src/api/director.ts` at the start of
 * the #1113 split refactor. Every checkpoint of the decomposition must
 * keep this set identical — adding or removing entries here without the
 * matching behavioral justification is a regression.
 */
const EXPECTED_ROUTES = [
  "DELETE /assets/:id",
  "DELETE /brand-kits/:id",
  "DELETE /drafts/:id",
  "DELETE /gallery/collections/:id",
  "DELETE /gallery/collections/:id/items",
  "DELETE /gallery/tags",
  "GET /assets/local",
  "GET /brand-kits",
  "GET /brand-kits/:id",
  "GET /config",
  "GET /drafts",
  "GET /drafts/:id",
  "GET /drafts/:id/renders",
  "GET /drafts/:id/subtitles/:format",
  "GET /drafts/:id/versions",
  "GET /files/:fileName",
  "GET /gallery/collections",
  "GET /gallery/collections/:id/items",
  "GET /gallery/tags",
  "GET /jobs",
  "GET /jobs/:id",
  "GET /narration/directives",
  "GET /produce/:id",
  "GET /produce/jobs",
  "GET /renders",
  "GET /renders/:jobId/download",
  "GET /templates",
  "GET /templates/:id",
  "GET /thumbnail-job/:jobId",
  "GET /voice/engines",
  "GET /youtube/analytics/channel",
  "GET /youtube/analytics/videos",
  "GET /youtube/categories",
  "GET /youtube/publish/:draftId/history",
  "GET /youtube/publish/:draftId/status",
  "POST /assets/download",
  "POST /assets/ingest",
  "POST /assets/overlay",
  "POST /assets/placement",
  "POST /assets/search",
  "POST /assets/upload",
  "POST /blog-to-video",
  "POST /brand-kits",
  "POST /drafts",
  "POST /drafts/:draftId/shorts/propose",
  "POST /drafts/:draftId/shorts/render",
  "POST /drafts/:id/thumbnail",
  "POST /drafts/:id/versions",
  "POST /drafts/:id/versions/:versionId/restore",
  "POST /enhance",
  "POST /enhance-instructions",
  "POST /enhance-overview",
  "POST /files/upload",
  "POST /files/upload-asset",
  "POST /gallery/collections",
  "POST /gallery/collections/:id/items",
  "POST /gallery/tags",
  "POST /hero-reel/process-inspiration",
  "POST /jobs/:id/abort",
  "POST /produce",
  "POST /produce/:id/cancel",
  "POST /render",
  "POST /render/batch",
  "POST /scenes/:sceneIndex/enhance-prompt",
  "POST /scenes/:sceneIndex/img2img",
  "POST /scenes/:sceneIndex/re-record",
  "POST /scenes/:sceneIndex/regenerate",
  "POST /scenes/:sceneIndex/replace-from-gallery",
  "POST /scenes/:sceneIndex/rewrite-script",
  "POST /shorts",
  "POST /shorts/from-manifest",
  "POST /thumbnail",
  "POST /voice/add-directives",
  "POST /voice/analyze-params",
  "POST /youtube/generate-metadata",
  "POST /youtube/publish",
  "POST /youtube/publish/:publishId/check",
  "PUT /brand-kits/:id",
  "PUT /config",
  "PUT /drafts/:id",
  "PUT /gallery/collections/:id",
];

describe("director router — route equivalence snapshot", () => {
  it("registers exactly the expected (method, path) tuples", () => {
    const actual = normalize(listRoutes(buildRouter()));
    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it("has no duplicate route registrations", () => {
    const actual = normalize(listRoutes(buildRouter()));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of actual) {
      if (seen.has(entry)) duplicates.push(entry);
      seen.add(entry);
    }
    expect(duplicates).toEqual([]);
  });
});
