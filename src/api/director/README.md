# Director API — Domain Map

The Director router (`src/api/director.ts`) was a 6,670-LOC monolith. Epic
[#1113](https://github.com/openzigs/openzigs/issues/1113) splits it into
domain-scoped sub-routers behind a thin composition root. This document is
the authoritative inventory of every route the composed router registers
and the file each handler lives in.

Total routes: **81** (matches `EXPECTED_ROUTES` in
`src/api/director.routes.test.ts` — the snapshot test is the regression
gate; any drift between this catalog, the snapshot, and the actual
registered routes is a behavior change).

## Composition root — `src/api/director.ts`

Mounts the four sub-routers in fixed order. No route handlers live here.

```ts
const ctx = createDirectorContext({ copilot, voiceService, ..., config });
registerAssetRoutes(router, ctx);
registerStoryboardRoutes(router, ctx);
registerRenderRoutes(router, ctx);
registerPublishRoutes(router, ctx);
```

## Shared context — `src/api/director/context.ts`

`DirectorContext` carries every cross-cutting closure dep:
`copilot`, `voiceService`, `renderOrchestrator`, `brandVoiceService`,
`toolRegistry`, `config`, `runtimeConfig`, `produceJobs`, `thumbnailJobs`,
`getAssetManager()`, `resetAssetManager()`, `probeAudioDurationSeconds()`,
`probeVideoInfo()`, `ensureGalleryTables()`, `io()`.

Late-bound Socket.IO is wired via `setDirectorIO(io)` and read through
`ctx.io()` — never via a module-level singleton inside a domain file.

## Domain breakdown

### Assets — `src/api/director/assets.ts` (26 routes) — shipped in #1165

| Method | Path |
| --- | --- |
| POST | `/assets/search` |
| POST | `/assets/download` |
| GET | `/assets/local` |
| POST | `/assets/upload` |
| POST | `/files/upload` |
| POST | `/files/upload-asset` |
| POST | `/assets/placement` |
| POST | `/assets/overlay` |
| GET | `/files/:fileName` |
| DELETE | `/assets/:id` |
| POST | `/assets/ingest` |
| GET | `/brand-kits` |
| GET | `/brand-kits/:id` |
| POST | `/brand-kits` |
| PUT | `/brand-kits/:id` |
| DELETE | `/brand-kits/:id` |
| GET | `/gallery/collections` |
| POST | `/gallery/collections` |
| PUT | `/gallery/collections/:id` |
| DELETE | `/gallery/collections/:id` |
| GET | `/gallery/collections/:id/items` |
| POST | `/gallery/collections/:id/items` |
| DELETE | `/gallery/collections/:id/items` |
| GET | `/gallery/tags` |
| POST | `/gallery/tags` |
| DELETE | `/gallery/tags` |

### Storyboard — `src/api/director/storyboard.ts` (37 routes) — #1139

Authoring surface: drafts, scenes, narration metadata, templates, voice
config, scene-level enhancement, thumbnails, blog-to-video, hero-reel,
shorts proposal, and the `/config` runtime-config endpoints (which belong
with the authoring metadata since they govern asset providers + default
model used during script generation).

| Method | Path |
| --- | --- |
| GET | `/narration/directives` |
| GET | `/config` |
| PUT | `/config` |
| GET | `/templates` |
| GET | `/templates/:id` |
| POST | `/enhance` |
| POST | `/enhance-instructions` |
| POST | `/enhance-overview` |
| POST | `/thumbnail` |
| GET | `/thumbnail-job/:jobId` |
| POST | `/drafts` |
| GET | `/drafts` |
| GET | `/drafts/:id` |
| GET | `/drafts/:id/subtitles/:format` |
| PUT | `/drafts/:id` |
| DELETE | `/drafts/:id` |
| POST | `/drafts/:id/versions` |
| GET | `/drafts/:id/versions` |
| POST | `/drafts/:id/versions/:versionId/restore` |
| GET | `/drafts/:id/renders` |
| POST | `/drafts/:id/thumbnail` |
| POST | `/scenes/:sceneIndex/regenerate` |
| POST | `/scenes/:sceneIndex/replace-from-gallery` |
| POST | `/scenes/:sceneIndex/rewrite-script` |
| POST | `/scenes/:sceneIndex/re-record` |
| POST | `/scenes/:sceneIndex/enhance-prompt` |
| POST | `/scenes/:sceneIndex/img2img` |
| POST | `/blog-to-video` |
| POST | `/hero-reel/process-inspiration` |
| GET | `/voice/engines` |
| POST | `/voice/analyze-params` |
| POST | `/voice/add-directives` |
| POST | `/drafts/:draftId/shorts/propose` |

### Render — `src/api/director/render.ts` (12 routes) — #1164

Production pipeline (ingestion → LLM → manifest → render queue), render
job lifecycle, and rendering of derived deliverables (shorts).

| Method | Path |
| --- | --- |
| POST | `/produce` |
| GET | `/produce/jobs` |
| GET | `/produce/:id` |
| POST | `/produce/:id/cancel` |
| POST | `/render` |
| POST | `/render/batch` |
| GET | `/renders` |
| GET | `/renders/:jobId/download` |
| GET | `/jobs` |
| GET | `/jobs/:id` |
| POST | `/jobs/:id/abort` |
| POST | `/shorts` |
| POST | `/shorts/from-manifest` |
| POST | `/drafts/:draftId/shorts/render` |

### Publish — `src/api/director/publish.ts` (8 routes) — #1164

YouTube publication and channel analytics.

| Method | Path |
| --- | --- |
| POST | `/youtube/publish` |
| GET | `/youtube/publish/:draftId/status` |
| POST | `/youtube/publish/:publishId/check` |
| GET | `/youtube/publish/:draftId/history` |
| GET | `/youtube/categories` |
| POST | `/youtube/generate-metadata` |
| GET | `/youtube/analytics/channel` |
| GET | `/youtube/analytics/videos` |

## Cross-domain helpers (live in `context.ts`)

- `probeAudioDurationSeconds(filePath)` — used by storyboard (re-record,
  draft duration) and assets (ingest).
- `probeVideoInfo(filePath)` — used by storyboard (regenerate, thumbnail)
  and assets (upload).
- `ensureGalleryTables(db)` — used by assets (gallery routes); not used
  outside that domain currently but lives in shared context because the
  galleryTablesReady cache is process-lifetime singleton state.
- `getAssetManager()` — singleton accessor; reset by `PUT /config` via
  `ctx.resetAssetManager()`.
- `runtimeConfig` — mutated by `PUT /config`; read by storyboard, render,
  publish, and assets when deciding default model / provider keys.
- `io()` — late-bound Socket.IO accessor for progress events.

## Convention for adding routes

1. Pick the domain by **resource ownership**, not URL prefix. A `/jobs`
   route that polls render-orchestrator state is render-domain even though
   its path doesn't say "render".
2. Add the handler in the matching `src/api/director/<domain>.ts` file
   inside the `register*Routes(router, ctx)` body. Use `ctx.<dep>` for
   every closure dependency. Never introduce a module-level singleton in
   a domain file — extend `DirectorContext` instead.
3. Append the new `METHOD /path` entry to `EXPECTED_ROUTES` in
   `src/api/director.routes.test.ts` (snapshot-sorted alphabetically).
4. Add a row to the table above so this catalog stays accurate.
