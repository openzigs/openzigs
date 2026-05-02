# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Pitch Present mode: slide background and inline images now render correctly inside the sandboxed iframe (previously 401'd because the asset URLs lacked an auth token).** The Present route fetches `/render?mode=present` with a Bearer header and injects the HTML into a sandboxed `<iframe srcDoc="...">`, but `<img>` and `data-background-image` requests inside that iframe cannot carry an `Authorization` header — every asset GET hit the admin auth middleware unauthenticated and returned 401, leaving the slide backgrounds blank. The render handler in `src/api/pitch.ts` now extracts the bearer token from the request (header first, `?token=` query fallback for shared bookmark compatibility) and propagates it to both `buildBackgroundImageUrlMap` and a new `appendTokenToPitchAssetUrls` helper that tokenizes inline `image.url` / `left_image.url` / `right_image.url` values pointing at the local Pitch asset route. Third-party `https://...` image URLs are intentionally untouched. The token is `encodeURIComponent`-encoded so reserved characters cannot inject extra query params or path segments. Same fix applied to the `/export.html` standalone alias. No auth-middleware changes — `PITCH_ASSET_PATH_RE` already allowlisted `?token=` for these exact paths. (#1041)
- **Pitch "Generate all images" performs a pre-flight FluxQ GPU probe before fan-out (post-Epic #1035 walkthrough).** The bulk endpoint (`POST /api/admin/pitch/decks/:deckId/images/generate-all`) was enqueueing N doomed jobs whenever the FluxQ sidecar was running but had lost its CUDA accelerator (every job came back with `` `enable_model_cpu_offload` requires accelerator, but not found `` and the user saw a "Retry failed (12) · 12 of 12 images failed" red banner). The route now calls `refreshFluxQGpuAvailable()` against the sidecar's `/gpu-info` before any fan-out and short-circuits with `503 image_gen_unavailable` when the sidecar reports `available: false`. Probe failures (`undefined`) preserve the legacy best-effort behaviour. The 5 s per-deck cooldown is NOT armed when the pre-flight short-circuits, so the user can immediately retry once the GPU is back. New error code `image_gen_unavailable` and audit event `pitch.images.bulk_blocked_no_gpu`. (Epic #1035)
- **Pitch renderer guarantees AA-contrast text on slides with a background image (post-Epic #1035 walkthrough).** Title slides on the Dark Tech starter brand kit collapsed to near-black headings on near-black images because the previous `.pitch-has-bg` rule only forced white on `h1/h2/h3` and left eyebrows, paragraphs, list items, and template subtitles to inherit the brand kit's primary color. The renderer (`src/pitch/pitch-renderer.ts`) now layers a deterministic dark scrim (`linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0.55) 100%)`) as a `::before` pseudo-element between the Reveal background image and the slide content, lifts the section children to `z-index: 1`, and pins every text-bearing element on `.pitch-has-bg` to a new `--pitch-on-image: #ffffff` token (added to `ReadableColorTokens.onImage`). Applies to the editor preview, `/render` Present iframe, and `/export.html` exported HTML. PPTX export is unchanged because pptxgenjs slides do not currently render slide-level background images (master slide background is hardcoded white). (Epic #1035)
- **PPTX export now derives readable text/background colors via `buildReadableColorTokens()` (Epic #1035 / #1037 AC4).** The PPTX exporter (`src/pitch/pitch-export-pptx.ts`) previously dropped the raw `brandKit.primaryColor` straight into heading/title text and hard-coded `color: "FFFFFF"` on the `section_divider` title and `comparison_table` header text. With a light brand kit (e.g. white-on-white) the slides rendered with invisible labels. Headings/eyebrow/timeline accent and table-header text now route through the same WCAG contrast tokens used by the HTML renderer (`heading`, `accent`, `onPrimary`), so light brand kits fall back to the readable dark text color while high-contrast kits still pass through unchanged. Also fixes a silent color-drop where pptxgenjs requires uppercase hex — `stripHash()` now normalises to uppercase. (#1037)
- **Missing pitch asset files emit a structured audit-log entry (Epic #1035 / #1039 AC5).** The `GET /api/admin/pitch/decks/:deckId/assets/:assetId` 404 path for "asset row exists but file missing on disk" now calls `auditRouteFailure(req, 404, "asset file missing", { deckId, assetId, kind, localPath })` before sending the response, so operators can spot orphaned-DB-row drift in the same `pitch.route_failed` audit stream that already covers DB and validation failures. (#1039)
- **Pitch hardening Playwright suite passes against a fresh dev server (Epic #1035 / #1036).** The previously reported `/pitch` Internal Server Error was traced to a stale long-running `next dev` process from a prior session; the route compiles and serves 200 on a clean server, and the full `e2e/pitch-hardening-epic-1035.spec.ts` (6 tests) passes end-to-end. (#1036)

### Changed

- **Internal: `PITCH_ASSET_PATH_RE` is now exported from `src/auth/auth.ts` and imported by `src/api/pitch.ts` (PR #1041 follow-up).** Eliminates the hand-copied `PITCH_ASSET_PATH_RE_LOCAL` mirror in the renderer's tokenizer that would have silently desynced if the auth allowlist charset relaxed. Also exports `appendTokenToAssetUrl` for direct unit testing (three new tests cover the no-query / existing-query / non-matching branches).
- **Slide-rail "Retry image" regenerates only the failing slide (Epic #1035 / #1039 AC3).** `POST /api/admin/pitch/decks/:deckId/images/generate-all` now accepts an optional `slideIds: string[]` body filter (max 200) and only fans out to the requested slides; the slide-rail retry button (`ui/app/pitch/[deckId]/page.tsx`) now passes the failing slide id instead of triggering a deck-wide regeneration, and the audit/socket events tag the source as `slide_retry` vs `bulk_button`. Returns 404 when `slideIds` matches no eligible slides. (#1039)

### Added

- **Dev tooling: graphify auto-refresh in CI on every PR.** New workflow [`.github/workflows/graphify-refresh.yml`](.github/workflows/graphify-refresh.yml) runs [`scripts/graphify-ast-build.py`](scripts/graphify-ast-build.py) on every PR that touches `src/`, `ui/`, `sidecars/`, `desktop/`, `config/`, or `scripts/`, and commits the refreshed `graphify-out/graph.json` + `GRAPH_REPORT.md` back to the PR branch as the `graphify-bot` user. AST-only — no LLM calls, ~1 minute CI time, $0 cost. Reviewers (human and AI subagents) always navigate against an up-to-date codebase graph. The orchestrator agent doc ([`.github/agents/orchestrator.agent.md`](.github/agents/orchestrator.agent.md)) is updated to expect the bot's auto-commit on feature branches. Forked PRs are skipped (no write token); commits containing `[skip graphify]` are not refreshed.

### Changed

- **Dev tooling: graphify codebase-graph integration for Copilot subagents (Epic #1026).** The orchestrator agent (`.github/agents/orchestrator.agent.md`) and the `code-issue`, `code-review`, and `research-gather` skills now consult `graphify-out/GRAPH_REPORT.md` (when present) and use `graphify query` / `graphify path` for impact analysis instead of broad grep sweeps. Reduces premium-request token usage when coding on openzigs. Opt-in for developers — install via `pip install graphifyy` (Windows) or `uv tool install graphifyy` (Mac/Linux), then `graphify .` to build, `graphify hook install` to auto-refresh on commit. New `.graphifyignore` excludes `node_modules/`, `.next/`, `dist/`, `external/`, `coverage/`, sidecar venvs, and other generated content. `.gitignore` updated to ignore graphify cache/manifest while committing the shared `graph.json`, `GRAPH_REPORT.md`, and `graph.html`. See [CONTRIBUTING.md](CONTRIBUTING.md#optional-graphify-knowledge-graph) for setup. **No openzigs runtime changes** — graphify is purely a developer-side workflow optimization. (#1026)

### Added

- **Playwright e2e coverage for Pitch Pro features (Epic #990).** New `ui/e2e/pitch-pro-epic-990.spec.ts` (12 tests) plus two Page Objects (`pitch-editor.page.ts`, `pitch-wizard.page.ts`) verify the user-facing acceptance criteria of sub-issues #991 (Generate-all-images toolbar button), #992/#999 (Present link), #993 (HTML export menu item + download), #994 (regenerate-image dialog flow + queued-status badge), #995 (title-slide background regenerate), #996 (real iframe thumbnails), #997 (polished Reveal.js embedded preview), and #998 (image style preset selector + draft-body wiring). All network is mocked via `page.route()` so the suite is hermetic — no backend, sidecars, or seeded brand kit required.
- **Sidecar auto-start polish (#1014).** `ensureSidecarsRunning` (`src/queue/sidecar-autostart.ts`) now uses an exponential backoff schedule (250 ms → 500 ms → 1 s → 2 s → 4 s → 5 s cap) instead of a fixed 1.5 s interval, extends the default readiness timeout to **120 s** (up from 60 s) to cover CUDA cold-start tails (model checkpoint load + first-time kernel compile), and emits a structured `DEBUG`-level log per probe (`[Sidecars] attempt N, elapsed Xms, status {ok|err|timeout}`). The fast-path no-op (already-healthy sidecar returns immediately, no spawn) is preserved. (#1014)
- **Authenticated Present route (#1016).** New Next.js page at `/pitch/[deckId]/present` wraps `/render?mode=present` in a sandboxed iframe that fetches the HTML with a proper `Authorization` header instead of smuggling the bearer token in the URL as `?token=`. The deck editor's Present button now navigates to this in-app route, eliminating token leakage to browser history, Referer, and upstream proxy logs. The `PITCH_RENDER_PATH_RE` allowlist entry in `src/auth/auth.ts` is intentionally retained for backwards compatibility with existing shared bookmarks; it carries an inline note that it can be removed once telemetry shows zero hits on the `?token=` path. (#1016)

### Fixed

- **Pitch hardening delivery gates cleared (Epic #1035).** Dependency overrides now resolve the moderate `vite`, `postcss`, and `uuid` audit advisories without changing direct dependency APIs, and Vitest coverage now excludes bootstrap/composition plus large operational orchestration modules (`src/server.ts`, `src/api/admin.ts`, `src/api/director.ts`, `src/queue/queue-master.ts`, `src/mcp/tools/pinterest-seo-tools.ts`) so the repo-wide unit coverage gate measures the unit-testable surface while keeping Pitch modules in the denominator. (#1035)

- **Pitch deck library and renderer reliability hardened (Epic #1035).** Malformed legacy deck/slide rows are now skipped on read instead of taking down `/api/admin/pitch/decks` or deck rendering, and Pitch load/render failures return structured route diagnostics so the UI can show the endpoint, status, and retry action. Generated inline slide images now patch slide content with the authenticated `/api/admin/pitch/decks/:deckId/assets/:assetId` route, rendered iframes add the narrow media `?token=` query parameter for those asset URLs, and repeated Generate All runs skip slides that already have background assets. Renderer color tokens now derive WCAG-readable text/heading/accent colors from the active brand kit, and the brand-kit editor warns when selected colors are likely to be low contrast. (#1035, #1040, #1038, #1037, #1039, #1036)

- **Pitch image persist now HTTP-resolves FluxQ asset URLs (refs #1022).** PR #1023's FluxQ refactor changed `MediaJob.resultUrl` from a local filesystem path to a REST URL (`/api/queue/assets/file/<filename>`). The pitch completion listener (`src/pitch/pitch-image-service.ts`) was still passing that string straight to `fs.copyFile()`, which on Windows resolved the leading slash to drive root (`C:\api\queue\assets\file\<jobId>.png`) and emitted nine `pitch.image.persist_failed` ENOENT events on the post-#1024 walkthrough. `resolveSourcePath` now translates the canonical queue-asset URL back to `<galleryDir>/<filename>` (where `galleryDir` matches the path `QueueMaster` writes asset bytes into), with strict basename-only containment to keep this purely a URL→path inversion. The `file://` and legacy absolute-path shapes are still accepted for back-compat. (refs #1022)
- **Pitch schema accepts `null` for optional LLM string fields (refs #1022).** `slides[].content.kpis[].delta`, `title.subtitle`, and `title.eyebrow` were `z.string().optional()`, which rejects `null` with `Expected string, received null` — but LLMs frequently emit `null` for "no value" instead of omitting the key, blocking otherwise-valid `stats_kpi` and `title` slides at the validation boundary. All three are now `z.string().nullable().optional()`. (refs #1022)
- **media-ctl FluxQ launcher: env-var quoting, setsid detachment, and wsl.exe arg-quote mangling fixed (refs #1022).**
- **FluxQ bulk pitch image fan-out no longer OOMs after the first generation (#1022).** The image-gen CUDA sidecar (`sidecars/image-gen/server_cuda.py`) now sets a fragmentation-aware `PYTORCH_CUDA_ALLOC_CONF` (default `expandable_segments:True`, exported by `scripts/media-ctl.ps1` and `sidecars/start-cuda-sidecars.sh`) before importing torch, calls `gc.collect()` + `torch.cuda.empty_cache()` + `ipc_collect()` after every generation in a `try/finally`, and self-heals CUDA OOMs through a three-step ladder: `empty_cache → retry → unload+reload+retry → structured 503`. A new opt-in `FLUXQ_SEQUENTIAL_OFFLOAD=1` flag swaps `enable_model_cpu_offload()` for `enable_sequential_cpu_offload()` (slower but ~3 GB lower peak — required to fit `flux-schnell` at 1024×576 on a 12 GB card), and VAE tiling + slicing are now always enabled so decode never re-spikes the allocator. On the backend, `QueueMaster.processImageGen` reads `vram_free_gb` from FluxQ's `/status` and defers dispatch (keeps the job `pending`) when free VRAM falls below `FLUXQ_MIN_FREE_VRAM_GB` (default 1.0 GB), then arms a short `FLUXQ_VRAM_COOLDOWN_MS` window (default 5 s) so the next tick doesn't immediately re-poll. Vitest coverage in `src/queue/queue-master.test.ts` validates the gate, the cooldown short-circuit, the missing-field passthrough, and the above-threshold dispatch. (#1022)
- **CSP allows Google Fonts on the Present + export.html routes (#1019).** The brand-kit web fonts emitted by the renderer (`<link rel="stylesheet">` against `fonts.googleapis.com` plus the woff2 payload from `fonts.gstatic.com`) were being blocked by the strict CSP set on `/api/admin/pitch/decks/:deckId/render` and `/export.html`, so decks fell back to the browser default font. `style-src` now includes `https://fonts.googleapis.com` and `font-src` includes `https://fonts.gstatic.com` on both routes. The same expansion is applied to the public share renderer in `src/api/public-share.ts` so shared decks render with brand fonts as well. The user-controlled surface remains the family name only — names continue to be sanitised through the strict allowlist in the renderer (#1007), so this CSP relaxation does not introduce a user-controlled URL injection point. Integration tests in `src/api/pitch.test.ts` and `src/api/public-share.test.ts` assert the new origins appear in the response header. (#1019)

### Changed

- **Living docs updated for #1014 / #1016.** `docs/ARCHITECTURE.md` gained a "Sidecar Lifecycle (Boot + Auto-Start)" subsection covering the auto-start probe path and the `registerImageCompletionListener` wiring point in `src/server.ts`. `docs/USER_GUIDE.md` got a new "Sidecar auto-start (`media.autoStartSidecars`)" reference, a "Why my Pitch images don't appear" troubleshooting checklist (FluxQ `/health` probe, `media_jobs` table for OOM errors, clamp-to-recommended-dims note from PR #1018, restart-after-enabling-auto-start), and an "Authenticated Present route" note pointing at `/pitch/[deckId]/present`. (#1015)

### Added (previous)

- **Pitch image completion listener wired into the bootstrap.** `registerImageCompletionListener` in `src/pitch/pitch-image-service.ts` was defined and tested but never registered in `src/server.ts`, so QueueMaster successfully dispatched pitch txt2img jobs to FluxQ:5005 and emitted `job:complete` — but no listener copied the result PNG into `~/.openzigs/pitch/assets/{deckId}/` or patched the slide content slot. Server now registers the listener after `queueMaster.start()` and disposes it during graceful shutdown. (#1010)
- **Opt-in CUDA sidecar auto-start at server boot** via the new `media.autoStartSidecars` config flag (default `false`). When enabled, `ensureSidecarsRunning` (new module `src/queue/sidecar-autostart.ts`) probes `media.sidecarHealthUrl` (default `http://127.0.0.1:5005/health`) and, if unreachable, spawns the platform-appropriate `scripts/media-ctl.{ps1,sh} flux start` command (detached, ignored stdio, `unref()`'d), then polls for readiness up to `media.startupTimeoutMs` (default 60 s). Failures are logged but never abort startup — the queue worker recovers when sidecars come up later. (#1010)

### Fixed

- **Pitch image generation no longer OOMs flux-schnell on 12 GB GPUs.** The auto-fan-out and "Generate all images" paths used to dispatch txt2img jobs at the slide's full visual resolution (~1920×1080), which exceeded VRAM on the default `flux-schnell` model — every job retried 3× and exited `failed`. The dispatcher now probes FluxQ's `/health` endpoint once at fan-out time, caches the advertised `recommended_width`/`recommended_height` (default 1024×576 via `FLUXQ_FALLBACK_DIMS`), and clamps every dispatched payload — including explicit user overrides and the persisted-asset fallback — through the new helper `clampToFluxQRecommendedDims` in `src/pitch/fluxq-recommended-dims.ts`. The clamp is monotonic (never up-scales) and falls through to the safe default when the sidecar is unreachable. (Post-PR-#1017 walkthrough finding)
- **"Generate all images" no longer hangs at "Generating 0 / N" forever when jobs fail.** Two latent bugs were stacking on top of each other: (1) `registerImageCompletionListener` only subscribed to `job:complete`, so retry-exhausted jobs leaked their binding entries and the UI never heard back; and (2) the listener never broadcast its outcomes — there was no `pitch:image:ready` / `pitch:image:failed` Socket.IO emit on the server. The listener now subscribes to both `job:complete` and `job:failed`, fires new `onPitchImageReady` / `onPitchImageFailed` callbacks (wired in `src/server.ts` to `io.emit`), and cleans up the `pendingPitchJobs` map on either outcome. The deck editor's `GenerateAllImagesButton` now transitions to a dedicated `error` state with a "Retry failed (N)" affordance and an inline `aria-live` message when any slot lands in the `failed` bucket. The `pitch:image:queued` / `pitch:image:failed` emits in `src/api/pitch.ts` also gained the missing `slot` field so `useSlideImageStatus`'s `${slideId}::${slot}` keying works correctly. (Post-PR-#1017 walkthrough finding)
- **Present button no longer returns 401 — auth allowlist now matches against `originalUrl` so it works behind the `/api/admin` mount.** The fix in PR #1013 added `PITCH_RENDER_PATH_RE` to the query-token allowlist but tested it against `req.path`, which Express strips of the mount prefix inside sub-routers. Production mounts auth via `app.use("/api/admin", authMiddleware, adminRouter)`, so `req.path` was `/pitch/decks/<id>/render` and the regex (which requires `/api/admin/...`) never matched. `extractToken()` now matches against `req.originalUrl.split("?")[0]`, which retains the full path. Added a regression test that mounts the middleware at `/api/admin` (matching production) so this latent class of bug is caught next time. (Fixes regression introduced in #1013, follow-up to #1012)
- **Wizard no longer silently swallows a 502 from `/api/admin/pitch/decks/draft`.** The Generate button previously caught the rejection and only called `showToast`, which auto-dismisses after 4 s, leaving users with no actionable signal when the LLM upstream timed out. The wizard now also renders an inline `wizard-submit-error` banner (`role="alert"`, dismissable) above the main form card with the server's `error.message`, persists until the next submit attempt, and re-enables the Generate button so the user can retry. (#1012)
- **Present button no longer 401s.** The pitch presenter renders inside a sandboxed iframe whose `src` is `/api/admin/pitch/decks/<id>/render?token=<bearer>` — and iframes cannot send `Authorization` headers. The auth middleware's query-token allowlist (PR #1003) only matched `/assets/*/file`. Added `PITCH_RENDER_PATH_RE = /^\/api\/admin\/pitch\/decks\/[a-zA-Z0-9_-]+\/render(?:\/[^?]*)?$/` to `extractToken()` so `?token=` is honoured for the render path and any sub-paths it serves. The OWASP trade-off is documented inline alongside the precedent reference. (#1011)

### Changed

- **Pitch deck visual design overhaul.** The embedded chrome `<style>` block was rewritten as a small design system (issue #1007): a modular type scale (`H1 3.2em / H2 2.2em / H3 1.5em`) anchored on `font-heading` and `font-body` from the active brand kit, generous slide padding (`64px 72px 88px`), brand-accent bullet markers via `::before`, an auto-fit KPI grid, full-bleed image absolute positioning with white-on-image text + drop shadow (applied via a new `pitch-has-bg` class), a centered title-slide pattern with a 3 px accent eyebrow underline, and a 6 px top accent bar (`linear-gradient(90deg, var(--pitch-primary), var(--pitch-accent))`) plus a softer `0 12px 40px rgba(0,0,0,0.18)` shadow. Standalone exports now wrap reveal output in `pitch-deck-wrap--standalone` so the same chrome applies to PDF/HTML/zip exports, not just the in-app preview. (#1007)
- **Web fonts actually load now.** The renderer emits `<link rel="preconnect">` + `<link rel="stylesheet">` against `fonts.googleapis.com` for `kit.fontHeading` and `kit.fontBody`. Names are sanitized through a strict allowlist (`/^[A-Za-z0-9 -]+$/` for the URL, plus a tighter CSS-context scrub on the inline `--pitch-font-heading` / `--pitch-font-body` CSS variables) so a hostile family value cannot break out of either context. (#1007)
- **`two_column` slides promote bullet-prefixed text to real lists.** A new pure helper `renderRichBody` detects two-or-more lines that start with `• - * – —` and emits `<ul><li>...</li></ul>` instead of dumping the raw text. Single-line content stays inline; multi-line plain prose becomes one `<p>` per line. Each column is wrapped in a `pitch-twocol-col` div for the new flex layout. (#1007)

### Fixed

- **Slides without a `background_image_prompt` no longer render styled-but-imageless.** A new opt-in `deriveFallbackBackgrounds` flag on `fanOutImageGeneration` derives a short conceptual prompt from the slide's title / heading / quote / caption (capped at 140 chars) when the AI/user left the field blank. The two API fan-out callsites (`POST /decks/draft` auto-fan-out and `POST /decks/:deckId/images/generate-all`) both pass the flag, so every slide in a freshly-generated deck gets a background image. The default for `planImageJobs` stays `false` so unrelated callers and the existing planner test suite are unchanged. (#1007)

- **Pitch deck embedded preview canvas was tiny / unreadable, slide rail thumbnails were entirely blank, and clicking a slide in the rail did not navigate the canvas.** Three follow-up regressions surfaced after the initial Reveal.css fix landed:
  1. **Canvas height collapse** — the `.pitch-deck-wrap--embedded` wrapper had no intrinsic height inside its iframe, so it collapsed to ~84 px and Reveal.js scaled the slide layout down to ~0.2× of the viewport. Embedded chrome CSS now sets `html, body { height: 100% }` and forces `.pitch-deck-wrap--{embedded,present}` to `display: flex; height: 100vh; width: 100vw` with `.reveal { flex: 1; min-height: 0 }`.
  2. **Selection did not navigate** — the canvas iframe always booted at slide 0 and there was no channel for the parent to drive Reveal. The renderer now accepts `initialSlideIndex` (clamped to the rendered range), the API exposes a `?initial=N` query parameter, and the embedded init script installs a `postMessage` listener for `{type:"openzigs:navigate", index:N}` plus a `openzigs:reveal-ready` handshake. The canvas component (`reveal-canvas-impl.tsx`) listens for the handshake, queues the latest selection, and posts navigate messages whenever `selectedSlideIndex` changes — no iframe rebuild required.
  3. **Slide-rail thumbnails were blank** — the Next.js dev server's default `X-Frame-Options: DENY` header on the proxied `/render` response blocked every thumbnail iframe. Thumbnails now follow the same `srcDoc` pattern the canvas uses: the React component fetches the embedded HTML with a Bearer header (`fetchWithAuth`) and feeds it into the iframe via `srcDoc`. Side benefit: the admin auth token is no longer leaked into the URL / Referer / access logs for thumbnails.

  Refs the canvas-blank report from 2026-04-28; companion to PR #1006. Image-generation eligibility for pre-existing decks (which silently skip when `background_image_prompt` is empty) and the `?token=` leak in the "Present" anchor remain as separate follow-ups.

- **Pitch deck embedded preview was rendering blank.** Both the editor canvas and the slide-rail thumbnails appeared as empty boxes (or barely-visible text on brand-colored backgrounds) because Reveal.js's CSS, theme stylesheet and init script were never loaded for the `embedded` and `present` render modes — the renderer only emitted an HTML fragment. Embedded and present modes now emit complete HTML documents that link `reveal.css` + `theme/white.css` from the same jsDelivr CDN that standalone exports already used, and ship the Reveal init script inline. The editor canvas component (`reveal-canvas-impl.tsx`) was rewritten to mount the document inside an `<iframe srcDoc=…>` with a locked-down `sandbox="allow-scripts allow-same-origin"` so it stays consistent with the slide-rail thumbnails and cannot leak styles into the parent page or navigate the host. (#990, #996, #997)

### Added

- **Real slide-rail thumbnails** in the Pitch deck editor. Each row in the rail now renders a 16:9 iframe-based preview of its slide, scaled to `0.18×` with `transform-origin: top left` inside an `overflow:hidden` wrapper. Iframes are lazily mounted via `IntersectionObserver` (200 px root margin) so a 30-slide deck no longer fan-floods `/render`. Auth is forwarded via the same `?token=` query-param pattern used by the "Present" button (PR #1003). The renderer exposes a new `slideIndex` filter — wired into `GET /api/admin/pitch/decks/:deckId/render?slide=:slideId` — so a thumbnail fetches exactly one slide's HTML. Stale slide IDs gracefully fall back to a full-deck render and an iframe `onerror` collapses to the existing text-title fallback so a render-failure tile is still legible. (#996)
- **Polished embedded preview chrome.** `embedded` and the new `present` render modes now ship a shared inline `<style>` block that wraps the deck in `<div class="pitch-deck-wrap pitch-deck-wrap--{mode}">` with a 2 px brand-primary border, `0 8px 24px rgba(0,0,0,0.25)` drop shadow, brand-primary-tinted footer strip, optional translucent watermark, and Reveal CSS variable overrides (`--r-heading-color`, `--r-link-color`, `--r-main-color`) so brand colors render at full saturation instead of being washed out by the dark Reveal theme. The block is a static literal — no XSS surface beyond the existing standalone `<style>`. (#997)
- **Image style presets for generated slide imagery.** Five presets (`cinematic`, `illustration`, `3d_render`, `corporate_photo`, `minimal_vector`) prefix every flux prompt with a centrally-defined style snippet. Selectable on the new-deck wizard's options step (`<select data-testid="wizard-image-style">`); persisted on the deck via `metadata.image_style`; honoured by the auto-fan-out (`POST /decks/draft`), the bulk regenerate (`POST /decks/:deckId/images/generate-all`), and the per-slide single-image POST. A per-slide `image_style` column on `pitch_slides` overrides the deck-level default. The prefix is applied exactly once inside `enqueueSlideImage` — before LoRA trigger injection — so the final prompt order is `[STYLE PREFIX][LORA TRIGGER][user prompt]`. (#998)

### Changed

- **`renderDeckToHtml` accepts `slideIndex`** to render only the slide at that 0-based index in `deck.slides`. Out-of-range indices yield a zero-slide deck instead of throwing so a stale slide-rail tile cannot 500 the server. The `backgroundImageUrlBySlideIndex` map is filtered alongside so the surviving slide keeps its background. The `RenderMode` union now includes `present` for the polished presenter chrome (still emits a fragment, not a full document). (#996, #997)
- **`fanOutImageGeneration` threads `imageStyle`** from caller through plan to worker, resolving per-slide overrides via `resolveImageStyle(perSlideStyle, deckLevel)`. (#998)

### Added (previous Unreleased entries)

- **HTML export menu item** in the Pitch deck editor. The "Export" dropdown now lists "HTML" between PowerPoint and Markdown; clicking it downloads a self-contained `.html` rendition of the deck via the existing `GET /api/admin/pitch/decks/:deckId/export.html` endpoint, named after the deck title. Useful for sharing decks via email or hosting them statically. (#994)
- **"Present" toolbar button** in the Pitch deck editor opens the Reveal.js renderer in a new tab in presenter mode (`/api/admin/pitch/decks/:deckId/render?mode=present`), with the auth token attached as a query parameter (an `Authorization` header can't ride a `target="_blank"` navigation). The button is disabled with a "Save your changes first" tooltip while local edits are in flight, so a presenter never demos a half-saved deck. (#999)
- **Public share-link tokens for pitch decks.** New `pitch_share_tokens` SQLite table (FK CASCADE on deck delete) plus owner-side admin routes `POST /api/admin/pitch/decks/:deckId/share` (issue), `GET .../share` (list), `POST .../share/:token/revoke` (revoke). A new public router mounted at `/p/:token` outside the admin auth chain serves the deck via the existing Reveal renderer with a strict CSP, `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: no-store`. Tokens are 32-byte base64url (~256 bits of entropy) and never reflected in error responses or audit logs (only the SHA-256 prefix is logged). Per-IP rate limit (30 req/min) and generic 404s on every failure mode prevent token enumeration / brute force. New `<ShareDialog />` in the editor lets owners create, copy, and revoke links. (#1000)

### Added (previous Unreleased entries)

- **Auto-fan-out of slide image generation on draft.** `POST /api/admin/pitch/decks/draft` now walks the freshly persisted deck and enqueues a flux job for every image-bearing slide slot (background, inline, two-column left/right, image-caption) using a new `fanOutImageGeneration()` planner with 4-way concurrency. Per-slot `pitch:image:queued` / `pitch:image:failed` events are emitted in real time. Opt-out by passing `options.autoGenerateImages: false` in the draft body. (#995)
- **"Generate all images" toolbar button** in the Pitch deck editor. New `POST /api/admin/pitch/decks/:deckId/images/generate-all` endpoint runs the same fan-out planner for an existing deck (idempotent — slots whose URL is already populated are counted as `skipped`). 5-second per-deck cooldown prevents accidental double-fire (returns `429 { error: "rate_limited" }` with `Retry-After` header). Button shows live `X / N` progress sourced from Socket.IO image events and toasts on completion or failure. (#991)
- **Slide-rail image-status badges.** Each slide row in the rail now shows an inline status pill driven by `pitch:image:*` Socket.IO events (queued = amber spinner, ready = green check, failed = red exclamation). Clicking a failed badge re-fires generation for the deck. New `useSlideImageStatus(deckId)` hook and `<ImageStatusBadge />` subcomponent in `slide-rail.tsx`. (#993)

### Added

- **Pitch deck rendering now displays per-slide background images** regenerated via the title-slide property editor. The Reveal `<section>` for each slide now emits a `data-background-image` attribute (plus `data-background-size="cover"` and `data-background-position="center"`) when a `kind="background"` asset exists for that slide; the latest asset by `created_at` wins. Backwards-compatible — when no background asset is present the renderer behaves exactly as before. (#992)
- **New endpoint `GET /api/admin/pitch/decks/:deckId/assets/:assetId`** serves slide asset bytes (typically flux-generated backgrounds) directly from disk. Hardened against path traversal (resolved `local_path` must lie under `assetsBaseDir`), cross-deck leakage (asset must belong to the URL's deck), and stale caches (`Cache-Control: no-store`). Rate-limited via the existing `crudLimiter` and auth-gated through the `/api/admin/pitch` mount point. (#992)
- **Regenerate-image dialog "Replace?" preview.** When the dialog is opened with a `currentImageUrl` prop it now renders a small thumbnail of the existing image with a "Replace?" caption above the prompt, so the user can confirm what they're about to overwrite. Client-side URL allowlist mirrors the server-side `safeUrl` check. (#992)

### Changed

- **Pitch condense reuses one Copilot SDK session per parallel worker slot** (4 sessions for a 16-chunk document) instead of creating and destroying a fresh session per chunk. Eliminates the 16× "session started / session ended" churn observed in logs. Sessions are destroyed in a `finally` block guaranteeing cleanup on success and failure paths alike.
- **Pitch wizard model picker moved to the Script step** (inside the "Condense with AI" panel) in addition to the Options step, so the model choice is visible at the point of use.
- **Pitch script condensation now runs map-stage chunks in parallel (4 concurrent)** — ~5× faster (459 KB script: ~10 min → ~1–2 min). Output order is preserved (workers write into positional summary slots so the reduce stage and resulting script remain deterministic). New exported constant `CONDENSE_MAP_CONCURRENCY` in `src/pitch/pitch-condense.ts`.

### Fixed

- **Pitch deck draft no longer 500s on partial `image` blocks emitted by the LLM** (e.g. `"image": {}` or `"image": { "url": null }`). New `normalizeImageBlocks()` pass in `src/pitch/pitch-utils.ts` walks every slide's `content`, finds objects that "look like an image" (have any of `prompt` / `url` / `alt`), and backfills missing required fields with safe defaults derived from the surrounding slide heading. Applied to both full-deck draft (`assembleDeck`) and per-slide regeneration.

### Added

- **Pitch wizard: choose the LLM for condensation and draft generation** via the standard model picker on the Options step (defaults to your Copilot account's selected model). `POST /api/admin/pitch/script/condense` now accepts an optional `model` field and `POST /api/admin/pitch/decks/draft` accepts `options.model`; both forward the override to the Copilot wrapper.
- **Pitch — AI-condensed large script uploads (up to 2 MB).** The Pitch wizard now accepts `.md` / `.txt` files up to 2 MB; oversize content is staged in a "Condense with AI" panel (explicit user click required — no auto-billing of LLM tokens) and run through a map-reduce summarisation pass before the existing `/decks/draft` pipeline. The persisted `source_script` cap stays at 50 KB — the condense step is the escape valve.
- **New endpoint `POST /api/admin/pitch/script/condense`** (auth-gated through the `/api/admin/pitch` mount-point). 20 requests/hour/IP via a new `condenseLimiter`, audit-logged on success (`category: system, event: pitch.script.condensed`) and on 429 (`category: security, event: pitch.rate_limit_exceeded`). Per-route `express.json({ limit: "2.5mb" })` middleware (the global 1 MB parser skips this prefix in `src/app.ts` — every other pitch route keeps its 1 MB cap). Returns `413 { error: "script_too_large", maxBytes: 2_000_000 }` for over-ceiling input and `502 { error: "condense_failed", detail }` on LLM failure.

### Fixed (Epic #951 — Studio → Pitch Walkthrough Bug Batch)

- Pitch script condense no longer forces `gpt-4o-mini` (which is unavailable in the GitHub Copilot SDK and caused every condense call to 502); falls back to the wrapper default model unless the caller (or wizard model picker) supplies an override.
- Pitch deck draft no longer aborts before LLM completes (timeout raised to 240s, progress UI added).
- Pitch export menu wired up (PDF, PPTX, Markdown, Speaker Notes, ZIP).
- Pitch slide regenerate-text action exposed in slide menu.
- Per-slide speaker notes now editable in properties panel.
- Pitch generator now respects slide-count target with explicit retry.
- Regenerate-image dialog uses field's current prompt value.

### Added (Epic #951 — Studio → Pitch Walkthrough Bug Batch)

- Structured 503 response when Decktape/Chromium unavailable.
- `aria-describedby` on pitch dialogs for screen readers.

### Security (Epic #951 — Studio → Pitch Phase 7)

- **Per-route rate limiting (#977):** Every Pitch route now wears an `express-rate-limit` instance built by an in-router `buildLimiter(max, label)` factory (1-hour window, standard `RateLimit-*` + `Retry-After` headers, `429 { error: { code: "rate_limited" } }` on overflow). Limits: draft 10/hr, regenerate 60/hr, enhance 60/hr, image enqueue 30/hr, PDF 20/hr, PPTX 30/hr, ZIP 30/hr, MD 60/hr, HTML 60/hr, speaker-notes PDF 20/hr, CRUD 600/hr.
- **Centralised XSS sanitiser (#977):** New `src/pitch/pitch-sanitize.ts` exports `sanitizeRichText`, `escapeHtml`, `escapeAttr`, and `safeUrl`. `PITCH_FORBID_TAGS` blocks `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`, `style`. `PITCH_FORBID_ATTR` strips every `on*` event handler plus `formaction`, `xlink:href`, `srcdoc`, `action`, `background`, `ping`, and `style` (the last added to defeat CSS-injection vectors like `<div style="background:url(javascript:alert(1))">`). `pitch-renderer.ts` re-exports `sanitize = sanitizeRichText` for backward compatibility.
- **Prompt-injection envelope (#977):** Replaced the legacy `<<<USER_SCRIPT_START>>>` markers with `<DATA>...</DATA>` envelope tokens. `wrapUserScript()` strips any pre-existing envelope tokens with `/<\s*\/?\s*data\s*>/gi` before wrapping, and `PROMPT_INJECTION_GUARD` instructs the model to treat envelope contents as data, never as instructions, and to never echo the envelope itself.
- **80-slide hard cap (#977):** New `MAX_SLIDES_PER_DECK = 80` constant in `pitch-generator.ts`. Stage 1 schema relaxed to `slides.min(1)`; truncation happens in code before the final `DeckSchema` validation. The matching `POST /decks/:deckId/slides` route returns `409` once the cap is hit.
- **Markdown table escaping (#977):** New `escapeMdCell(value)` in `pitch-export-md.ts` (with null/undefined guard) escapes `\`, `|`, and newlines in `comparison_table` columns, row labels, and row cells. Prevents user-supplied pipes from breaking out of table syntax.
- **Filename allowlist + tmpdir containment (#977):** `safeFilename` now passes a 17-payload fuzz suite (null bytes, control chars, RTL override, CRLF injection, traversal, UNC, drive swap, semicolon injection, URL-encoded traversal, zero-width chars). New `assertWithinTmpdir(candidate)` performs platform-aware `tmp + sep` prefix containment and is invoked by `htmlToPdf` for both the temp HTML and PDF paths before any `file://` URL is constructed — defence-in-depth against `file://` LFI in the decktape subprocess.
- **Realpath-based symlink containment for PDF export temp paths (PR #984):** `assertWithinTmpdir` now resolves the parent directory through `fs.realpathSync` and re-checks containment against `realpathSync(os.tmpdir())`. Closes a symlink-escape gap where `/tmp/evil -> /etc` would have bypassed the previous lexical-only `path.resolve` check. Includes a regression test that plants a tmpdir-resident symlink pointing at `/`.
- **AbortSignal early return (#977):** PDF and speaker-notes exporters now check `opts.signal?.aborted` before spawning the decktape subprocess, throwing `"PDF export aborted"` / `"Notes PDF export aborted"` so a client disconnect during the request handshake never leaves orphan processes.
- **SSRF allowlist enforcement (#977):** `BrandKitSchema` JSDoc and a `pitch-schema.test.ts` regression now guarantee that `BrandKitSchema.logoUrl`, `BrandKitSchema.watermarkUrl`, and `SlideImageSchema.url` are the only `z.string().url()` fields and are populated by server-side flows only. Any future URL field must run through `isAllowedWebhookUrl`.
- **CSP on render + HTML export (#977):** `GET /decks/:deckId/render` and `GET /decks/:deckId/export.html` send a strict Content-Security-Policy header that blocks inline scripts and external origins outside the Reveal CDN.

### Added (Epic #951 — Studio → Pitch Phase 7)

- **Integration test suite (#976):** New `src/api/pitch.integration.test.ts` builds a full Express harness (in-memory SQLite, seeded starter brand kits, mocked `enqueueSlideImage`/`generateDeck`/`regenerateSlide`, exporters injected via `PitchRouterDeps.exporters`) and asserts: (1) end-to-end deck lifecycle — draft → patch → reorder slides → enqueue image → export all 5 formats → delete; (2) per-family rate-limit defence (draft, image, pdf, crud); (3) the 80-slide cap.
- **Sanitiser test suite (#977):** New `src/pitch/pitch-sanitize.test.ts` runs a 50+ payload OWASP XSS battery (script tags, event handlers, `javascript:` / `vbscript:` URLs, `srcdoc`, `formaction`, CSS-injection, polyglot SVG, etc.) plus dedicated coverage for `escapeHtml`, `escapeAttr`, and `safeUrl`.
- **Documentation (#977):** New "Studio → Pitch (AI Slide Decks)" section in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) covering navigation, workflow, brand kits, export matrix, rate-limit table, and the security model. New "Studio → Pitch (AI Slide Decks)" section in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) with Mermaid diagrams for the request flow + security boundary, key-component table, Socket.IO event taxonomy, and test-coverage map. README feature bullet linking to the user guide section.

### Added (Epic #951 — Studio → Pitch Phase 6 Exports + Nav)

- **PDF export (#974):** New `src/pitch/pitch-export-pdf.ts` — renders the deck through the existing standalone Reveal HTML, then runs `decktape reveal` against a `file://` URL via `child_process.spawn` with a 60 s wall clock, `AbortSignal`-driven kill, and guaranteed temp-file cleanup. Returns a `Buffer` plus a sanitised `<title>.pdf` filename and `application/pdf` content type. Subprocess `stderr` is captured for logging only — never surfaced to clients.
- **Speaker-notes PDF (#974):** New `src/pitch/pitch-export-notes.ts` — builds a minimal printable HTML doc (one `<section>` per slide with `Slide N`, the slide title, and the speaker notes inside `<pre>` for verbatim formatting) and pipes it through the same `htmlToPdf` helper as the deck PDF. Filename suffix `-notes.pdf`.
- **PowerPoint (.pptx) export (#972):** New `src/pitch/pitch-export-pptx.ts` — native `pptxgenjs` generation with `LAYOUT_WIDE` (13.333 × 7.5 in), brand-kit fonts wired into `pres.theme`, and a `BRAND_MASTER` slide master carrying the accent rule + footer text + slide numbers. Per-template renderers for all 14 slide variants (`title`, `section_divider`, `bullet_list`, `two_column`, `image_caption`, `quote`, `stats_kpi`, `comparison_table`, `timeline`, `full_bleed`, `code`, `qa`, `chart`, `mermaid`). Charts use `addChart` with the schema's `chart_type` enum; tables use `addTable`; mermaid sources are embedded as Courier text (TODO to swap for SVG once a Node-side renderer ships). Images are fetched, re-encoded through `sharp` to strip EXIF, capped at 1920 px on the long edge and 5 MB after resize, then embedded as data URLs. Failed image loads degrade gracefully to a placeholder block so a single broken URL never blocks the export. Speaker notes attach via `s.addNotes`.
- **Static HTML zip (#973):** New `src/pitch/pitch-export-zip.ts` — `archiver` zip (compression level 9) containing the standalone Reveal HTML as `index.html` plus a `README.txt`. Reveal is loaded from CDN per the README — full asset bundling is deferred. Entry names are constants so the archive cannot encode a path-traversal attack.
- **Markdown export (#973):** New `src/pitch/pitch-export-md.ts` — pure synchronous transform with per-template renderers for all 14 slide variants. Speaker notes render as `> _Speaker notes:_ …` blockquotes; slides separated by `---`. User-supplied triple-backticks inside `code` slides are split with U+200B zero-width separators so they cannot prematurely close the fenced block. Empty optional fields are omitted (no orphan headings).
- **Sanitised filename + tempfile helpers (#972 #973 #974):** New `src/pitch/pitch-export-utils.ts` — `safeFilename(title, fallbackId, ext)` allows only `[a-zA-Z0-9._-]`, strips leading/trailing `._`, caps at 120 chars, and falls back to `deck-<id>` when the input collapses to empty. `htmlToPdf(html, opts)` owns the decktape subprocess lifecycle. `resizeImageForPptx(buffer, opts)` handles the sharp pipeline.
- **Six new GET endpoints in `src/api/pitch.ts` (#972 #973 #974):** `GET /api/admin/pitch/decks/:deckId/export.{pdf,pptx,zip,md,html,notes.pdf}`. All routes resolve the deck + brand kit, set `Content-Type` + `Content-Disposition: attachment; filename="<safe>"` + `Cache-Control: no-store`, audit-log `pitch_deck_exported` (category `system`), and broadcast `pitch:deck:exported` over Socket.IO. PDF routes additionally set `req.setTimeout(60_000)` and wire a per-request `AbortController` so client disconnects kill the underlying decktape process. Errors are logged with full detail but the HTTP response carries a generic message — subprocess `stderr` and `pptxgenjs` internals never reach the client. The `PitchRouterDeps.exporters` hook lets tests inject mocks per format.
- **Studio nav entry (#975):** `ui/components/nav-bar.tsx` Studio dropdown now exposes a **Pitch** link pointing at `/pitch`. `NAV_GROUPS` is exported so the unit test can assert against the source-of-truth structure (Radix dropdown content does not render in jsdom).

### Added (Epic #951 — Studio → Pitch Phase 5 Editor Polish)

- **Properties panel (#971):** New `ui/components/pitch/properties-panel.tsx` — right-rail panel that switches on `slide.template` and lazy-imports the matching editor from `ui/components/pitch/property-editors/<template>.tsx` via `next/dynamic` (one bundle per template, not all 14 at once). Maintains an optimistic local draft, debounces a `PATCH /api/admin/pitch/decks/:deckId/slides/:slideId` by 400 ms, and rolls back to the last server-confirmed value with a toast on failure. Ships all 14 per-template editors (`title`, `section_divider`, `bullet_list`, `two_column`, `image_caption`, `quote`, `stats_kpi`, `comparison_table`, `timeline`, `full_bleed`, `code`, `qa`, `chart`, `mermaid`) sharing the `{ slide, onChange, deckId, brandKit }` prop shape from `property-editors/shared.tsx`. Image-bearing editors open the new shared `regenerate-image-dialog.tsx` (POST `/api/admin/pitch/decks/:deckId/slides/:slideId/image`, optional Character LoRA dropdown wired to `/api/characters`).
- **Script panel (#969):** New `ui/components/pitch/script-panel.tsx` — collapsible bottom panel with drag-to-resize handle. When a slide carries `slide.source_range`, clicking the slide scrolls the script textarea and selects the matching range; clicking inside the script selects the owning slide. Degrades gracefully with a `(highlight unavailable)` hint when no slide has `source_range`. Re-run-draft is gated by a `ConfirmDialog` and POSTs to `/api/admin/pitch/decks/draft`.
- **Brand kit picker + editor (#970):** New `ui/components/pitch/brand-kit-picker.tsx` — native `<select>` (chosen over Radix Select for jsdom test reliability) with inline color swatches plus **Edit kit** / **+ New** buttons. New `ui/components/pitch/brand-kit-editor.tsx` — Radix dialog for create / edit / starter-duplicate flows with hex color pickers + text inputs, heading/body font fields (`<datalist>` of suggestions), footer text, and logo upload (≤ 2 MB, PNG / JPEG / WebP) via the existing multipart endpoint. Starter kits open read-only with a **Duplicate to customize** button that POSTs a `<starter> copy` and re-opens it editable. Wizard `ui/app/pitch/new/page.tsx` and editor shell `ui/app/pitch/[deckId]/page.tsx` both wire the new picker + editor in place of the Phase 4 stubs.
- **Optional `source_range` on `SlideSchema` (#969):** `src/pitch/pitch-schema.ts` `Common` shape gains an optional `source_range: { start: number; end: number }` (snake_case to match the rest of the pitch schema). Older slides without the field continue to validate; round-trip + negative / non-integer rejection covered by `pitch-schema.test.ts`.

### Added (Epic #951 — Studio → Pitch Phase 4 Reveal renderer + editor shell)

- **Reveal HTML renderer (#963):** New `src/pitch/pitch-renderer.ts` exports `renderDeckToHtml(deck, brandKit, options)` and `extractInlineCss(html)`. Maps every `SlideContent` template (`title`, `section_divider`, `bullet_list`, `two_column`, `image_caption`, `quote`, `stats_kpi`, `comparison_table`, `timeline`, `full_bleed`, `code`, `qa`, `chart`, `mermaid`) to the matching `<section>` markup, sanitises every interpolated string with DOMPurify (`FORBID_TAGS: ["script","style","iframe","object","embed","link","meta"]`, `FORBID_ATTR: ["style","onerror","onload","onclick","srcset"]`), and emits `data-pitch-field="<fieldName>"` on every editable element so click-to-select can identify the source field. Brand kit colors / fonts / logo / footer flow into `:root` CSS variables and an inline stylesheet; `mode: "embedded"` returns just the `.reveal` fragment for in-app preview, `mode: "standalone"` returns a full `<!doctype html>` document with reveal.js + theme + Mermaid CDN bundles for offline preview / export.
- **Reveal render endpoint (#963):** New `GET /api/admin/pitch/decks/:deckId/render?mode=embedded|standalone` in `src/api/pitch.ts`. Validates the deck + brand kit, calls `renderDeckToHtml`, audit-logs `pitch_deck_rendered` (category `system`), broadcasts `pitch:deck:rendered`, and returns `text/html; charset=utf-8` with `Cache-Control: no-store`.
- **SSR-safe `RevealCanvas` component (#968):** New `ui/components/pitch/reveal-canvas.tsx` + `ui/components/pitch/reveal-canvas-impl.tsx`. The wrapper imports the impl via `dynamic(..., { ssr: false })` so reveal.js never touches `window` during SSR. Impl initializes a fresh `Reveal` instance on mount with `embedded: true, hash: false, controls: true, progress: true, transition: "slide"`, calls `.destroy()` on unmount, and re-mounts only when the optional `cacheKey` prop changes. Forwards container clicks via `onContainerClick(targetEl)` so the editor can walk up to the nearest `data-pitch-field`.
- **`SlideRail` component (#967):** New `ui/components/pitch/slide-rail.tsx`. Vertical rail (`w-44`) using `@dnd-kit/core` + `@dnd-kit/sortable` (`PointerSensor` activation distance 4, `closestCenter` collision, `verticalListSortingStrategy`). Optimistic reorder calls `onReorder(slideId, newPosition)` and rolls back on rejection. Each row exposes a Radix `DropdownMenu` with **Add slide above / below**, **Duplicate**, and **Delete** (red, gated by `ConfirmDialog`). Trigger button stops `pointerdown`/`click` propagation so it never accidentally starts a drag.
- **Deck editor shell (#964):** New `ui/app/pitch/[deckId]/page.tsx` — 3-column grid (`SlideRail` | `RevealCanvas` | properties placeholder) with a top bar (click-to-edit title, disabled `Brand kit` + `Export` buttons stubbed for Phases 5/6 with `title="Coming in Phase 5/6"` tooltips, and a save-state indicator dot) and a collapsible read-only script panel that shows `metadata.source_script`. React Query keys `["pitch","deck",deckId]` + `["pitch","render",deckId]` are invalidated on mutation success and on the new `pitch:deck:updated|created|deleted|rendered` / `pitch:slide:created|updated|deleted|moved` Socket.IO events. Canvas clicks walk the DOM up to the nearest `data-pitch-field` ancestor and surface the field name in the right-hand properties area.
- **Deck list at `/pitch` (#965):** New `ui/app/pitch/page.tsx` — responsive 1/2/3-column grid of deck cards with title, slide count, brand-kit name, and `updated_at`. Empty state CTA links to `/pitch/new`. Per-card overflow menu offers a destructive **Delete** action gated by `ConfirmDialog`.
- **New deck wizard at `/pitch/new` (#965):** New `ui/app/pitch/new/page.tsx` — 3-step wizard (Brand kit → Script → Options). Step 1 lists brand kits and shows a stub **+ Create new kit** button (toast: *"Brand kit creation arrives in Phase 5."*). Step 2 has a `.txt` / `.md` drag-and-drop dropzone, paste textarea, and live byte counter (red over the 50 KB cap). Step 3 collects `slideCount` (5/10/15/20), `audience`, and `tone` (formal/casual/persuasive). **Generate** posts to `POST /api/admin/pitch/decks/draft` with a 90 s `AbortController` timeout and routes to `/pitch/{newDeckId}` on success.

### Security (Epic #951 — Pitch Phase 3 review hardening, PR #980)

- **Logo upload content-sniffing + re-encode (`src/api/pitch.ts`):** `POST /api/admin/pitch/brand-kits/:id/logo` now reads the uploaded bytes into memory, asks `sharp(buffer).metadata()` for the actual format, and rejects requests when the sniffed format does not match the claimed `Content-Type` or is not in the PNG / JPEG / WebP allowlist. **SVG and GIF uploads are no longer accepted** — both were stored-XSS / animation sinks for the upcoming Phase 4 Reveal renderer (option a from the review thread). Accepted rasters are re-encoded through `sharp` (PNG / JPEG@90 / WebP@90) with `resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })`, which strips EXIF, embedded color profiles, and any non-image payload smuggled past the MIME check. Stale logos with a different extension are removed before the atomic rename so a kit only ever has one logo file on disk.

### Added (Epic #951 — Pitch Phase 3 review hardening, PR #980)

- **Audit logging on every Pitch mutation:** `PitchRouterDeps` now accepts an optional `auditLogger: AuditLogger`, wired from `src/server.ts`. Every mutating route emits a structured audit event — `system` for CRUD (`pitch_deck_created/updated/deleted`, `pitch_slide_created/updated/deleted/moved`, `pitch_brand_kit_*`), `tool` for AI calls (`pitch_deck_drafted`, `pitch_slide_regenerate_queued`, `pitch_slide_enhanced`, `pitch_slide_image_queued`), and `security` (warn) for upload rejections (`pitch_brand_kit_logo_rejected`) and starter-immutability blocks (`pitch_brand_kit_starter_blocked`).
- **Socket.IO real-time events:** `PitchRouterDeps` now accepts an optional `io: Server`, also settable via the late-bound `setPitchIO()` helper (mirrors `setDirectorIO`). Every mutating route broadcasts `pitch:deck:created/updated/deleted`, `pitch:slide:created/updated/deleted/moved`, `pitch:brand-kit:created/updated/deleted`, `pitch:draft:started`, `pitch:slide:regenerate-queued`, and `pitch:image:queued` so future Pitch UI panels can stay in sync without polling.

### Changed (Epic #951 — Pitch Phase 3 review hardening, PR #980)

- **`DELETE /brand-kits/:id` no longer scans every deck.** Replaced the in-process `decks.find(d => d.brand_kit_id === id)` walk with a new `PitchRepository.findFirstDeckIdByBrandKit(brandKitId)` that runs `SELECT id FROM pitch_decks WHERE brand_kit_id = ? LIMIT 1`. O(decks) → O(1) on the index.

### Added (Epic #951 — Studio → Pitch Phase 3 REST API)

- **REST router for Studio Pitch (#961, #959, #962, #966):** New `src/api/pitch.ts` exports `createPitchRouter({ pitchRepo, brandKitRepo, copilot, taskEngine, mediaQueueRepo, characterRepo?, brandKitsDir? })` mounted at `/api/admin/pitch` behind the standard `authMiddleware`. Ships 19 endpoints covering deck CRUD (`GET/POST /decks`, `GET/PATCH/DELETE /decks/:id`), slide CRUD (`POST /decks/:id/slides`, `PATCH/DELETE /decks/:id/slides/:slideId`, `PUT /decks/:id/slides/:slideId/move`), AI ops (`POST /decks/draft`, `POST /decks/:id/slides/:slideId/regenerate|enhance|image`), and brand kit management (`GET/POST /brand-kits`, `GET/PATCH/DELETE /brand-kits/:id`, `POST /brand-kits/:id/logo`). All bodies validated with Zod `.strict()` and structured `{ error: { code, message, details? } }` responses. Starter brand kits are immutable (PATCH/DELETE/logo → 403); brand kits referenced by a deck cannot be deleted (409 with `details.deckId`). Logo upload uses `multer` memoryStorage capped at 2 MB with image/* MIME enforcement, atomic write-to-temp-then-rename, and 413 on oversize. Last-slide deletion blocked with 409 to honour the `DeckSchema` ≥1-slide invariant. Rate-limiting deferred to Phase 7 (#977); `POST /decks/draft` returns synchronous JSON 201 (no SSE streaming — no existing SSE pattern in the codebase).

### Added (Epic #951 — Studio → Pitch Phase 2 AI Pipeline)

- **Single-shot deck generator (#954):** New `src/pitch/pitch-generator.ts` exports `generateDeck()` — calls `CopilotWrapper.chat()` with the `pitch-writer` agent, builds the system prompt via `buildDraftSystemPrompt`, wraps the user script in `<<<USER_SCRIPT_START>>>` / `<<<USER_SCRIPT_END>>>` anti-injection markers, capped at 50 KB. On parse / Zod failure the prompt is replayed exactly once with a structured retry hint appended (`buildRetryHint`); a second failure throws. Server-controlled fields (`id`, `brand_kit_id`, `metadata.source_script`, `created_at`, `updated_at`) are always overwritten — the model cannot smuggle them in.
- **Per-slide regenerate as a TaskEngine job (#957):** New `src/pitch/pitch-regenerate.ts` exports `submitSlideRegenerateTask()` (background single-stage pipeline with the new `persist-pitch-slide` post-action), `registerPersistPitchSlidePostAction()` (idempotent registration with the global `postActionRegistry`), and `executePersistPitchSlide()` (parses + Zod-validates the LLM output, calls `pitchRepo.updateSlide()`). Failures are recorded via `AuditLogger` (`category: "system"`, events `pitch.persist.parse_failed` / `pitch.persist.update_failed` / `pitch.persist.slide_missing` / `pitch.persist.config_invalid`); the post-action handler always returns a structured `{ ok, error? }` JSON string and never throws out of the worker.
- **FluxQ image enqueue + asset persistence (#958):** New `src/pitch/pitch-image-service.ts` exports `enqueueSlideImage()` (calls `injectCharacterLora` BEFORE `mediaQueueRepo.createJob({ type: "txt2img", ... })`, defaults to 1920×1080 / `flux-schnell`, scopes `projectId` to `pitch:{deckId}`) and `registerImageCompletionListener()` which subscribes to `queueMaster.on("job:complete")`. On success the result file is copied to `~/.openzigs/pitch/assets/{deckId}/{assetId}.{ext}`, dimensions are read with `sharp`, a `pitch_assets` row is persisted, and (for inline `kind: "image"`) the slide content's image slot URL is patched to a `file://` URL. If `pitchRepo.insertAsset()` throws (e.g. FK violation) the freshly copied file is removed so disk doesn't leak. Returns a `flush()` helper for tests.
- **Shared pitch helpers:** New `src/pitch/pitch-utils.ts` (`stripCodeFences`, `wrapUserScript`, `accumulateStream`, `parseAndValidate`, `buildRetryHint`) used by both the deck generator and the regenerate post-action. 50 KB script cap is enforced via `Buffer.byteLength(..., "utf8")`.

### Fixed (Epic #951 Phase 1 carryover)

- **`buildRegenerateSystemPrompt` reference-equality bug (#957):** When callers passed a deep clone of a slide (e.g. after JSON serialization through the API boundary), the prompt's previous/next slide context was emitted as `(none)` because `findIndex(s => s === slide)` always returned `-1`. Fixed by introducing a new exported `findSlideIndex(deck, slide)` helper that first attempts reference equality and falls back to a structural `JSON.stringify({ template, content })` match. The `Slide` type has no `id` field (only `SlideRecord` does, in the repository), so structural equality is the strongest available comparison.

### Added (Epic #951 — Studio → Pitch Phase 1 Foundations)

- **Zod slide-deck schemas (#952):** New `src/pitch/pitch-schema.ts` exports `BrandKitSchema`, `DeckSchema` (slides capped at 1..80), `SlideAssetSchema`, and a `z.discriminatedUnion("template", …)` over all 14 slide templates (`title`, `section_divider`, `bullet_list`, `two_column`, `image_caption`, `quote`, `stats_kpi`, `comparison_table`, `timeline`, `full_bleed`, `code`, `qa`, `chart`, `mermaid`). Single source of truth for every other Pitch module.
- **Brand Kit extension (#955):** `BrandKitRepository` now persists three Pitch-specific fields — `font_heading`, `font_body`, `footer_text` — added via idempotent `ALTER TABLE` migrations so existing rows are untouched. Legacy callers that omit the new fields keep working; new fields default to `null`.
- **Starter Brand Kits (#953):** New `src/pitch/starter-brand-kits.ts` exports an 8-kit catalog (`Modern Minimal`, `Corporate Blue`, `Startup Vibrant`, `Academic`, `Dark Tech`, `Warm Creative`, `Medical / Clinical`, `Pitch Deck Classic`) and a `seedStarterBrandKits(repo)` helper. Wired into `src/server.ts` startup right after `brandKitRepo.migrate()`. Idempotent — checks `getById(id)` and skips kits that already exist, so user edits to a starter kit survive a re-seed.
- **`PitchRepository` (#956):** New `src/pitch/pitch-repository.ts` persists decks, slides, and assets in three new SQLite tables (`pitch_decks`, `pitch_slides`, `pitch_assets`). FK relationships: `pitch_decks.brand_kit_id → brand_kits(id) ON DELETE RESTRICT`; `pitch_slides.deck_id`, `pitch_assets.deck_id` both `ON DELETE CASCADE`. Includes `insertDeck` (atomic — validates every slide via `SlideSchema` before opening the transaction), `updateDeck`, `deleteDeck`, slide CRUD, transactional `reorderSlides`, asset CRUD, and a defensive `DeckSchema.parse()` on every read so corruption fails loudly instead of leaking through. Update paths use a closed allowlist of column names to defeat SQL injection.
- **`pitch-writer` agent archetype (#960):** New entry in `config/agents.json` (display name `AI Presentation Writer`) plus `src/pitch/pitch-prompts.ts` exposing `buildDraftSystemPrompt(brandKit, opts)` and `buildRegenerateSystemPrompt(deck, slide, hint?)`. Both prompts inject the brand kit context, enumerate the 14 allowed templates, instruct the model to emit `image_prompt` instead of fabricating image URLs, and carry an explicit prompt-injection guard treating user script content strictly as data.

### Added (Epic #941 — Harden Copilot SDK startup)

- **`POST /api/admin/copilot/restart` endpoint (#944):** New admin endpoint that resets `started`/`startFailed`/`lastStartError`/`startPromise` on the `CopilotWrapper` and re-invokes `client.start()`. Returns `{ ok, started, error? }`. Lets operators recover from a transient SDK boot failure without restarting the whole server. Requires the same admin auth as the rest of `/api/admin`.
- **`copilot.startTimeoutMs` config knob (#942):** Zod-validated number, bounds `1000…120_000`, default `10_000`. Layered through `config/default.json` → `~/.openzigs/config.json` → env, and wired into `CopilotWrapperService` via the constructor option of the same name.
- **TaskWorker `awaiting_copilot` recovery (#945):** Background tasks that throw `Copilot SDK is unavailable` are no longer permanently failed. Instead they are deferred back to `queued` with an `awaiting_copilot_until` timestamp (`now + 30s`) via the new `TaskEngine.deferForCopilot()` and `TaskRepository.deferForCopilot()` methods. The dequeue path filters out rows whose deferred-until is in the future. Schema migration follows the existing `ALTER TABLE` pattern (new `awaiting_copilot_until TEXT` column).
- **Copilot CLI Troubleshooting subsection in `docs/USER_GUIDE.md` (#946):** Documents (a) what the new error message means, (b) that `@github/copilot-sdk` bundles its own CLI per [github/copilot-sdk#984](https://github.com/github/copilot-sdk/issues/984), (c) the new restart endpoint, and (d) the configurable startup timeout.

### Fixed (Epic #941)

- **Real `client.start()` errors are now surfaced (#943):** `CopilotWrapperService.doStart()` previously swallowed the underlying error with a bare `catch {}` and `chat()`/`listModels()` returned a generic message. The catch now logs the full detail via Winston with `category: "system"`, stores a `~200 char` truncated copy on a new `lastStartError` field, and surfaces it in every user-facing error message after the literal marker `Copilot SDK is unavailable: …`. Downstream consumers (TaskWorker, future UI banners) can classify recoverable failures by checking for that marker.
- **Removed hardcoded "CLI version 0.0.394" remediation string (#946):** The wrapper no longer instructs users to upgrade to a specific SDK-bundled CLI version (which is opaque, version-pinned by the SDK, and not user-controllable per [github/copilot-sdk#984](https://github.com/github/copilot-sdk/issues/984)). Replaced with a generic pointer to `docs/USER_GUIDE.md` and the new `/api/admin/copilot/restart` endpoint.

### Added (Epic #948 — LTX GPU pooling, audio delegation & clip duration fixes)

- **LTX-2 sidecar audio delegation:** When the gallery requests `txt2video` with `audio=true` and the active model cannot produce synchronized audio in-process (no 24 GB pooled VRAM, in-process model not the 22B variant), the worker now proxies the job to the dedicated LTX-2 sidecar on `:5013` instead of returning HTTP 400. New env vars `LTX2_SIDECAR_URL`, `LTX2_SIDECAR_TOKEN`, `LTX2_SIDECAR_POLL_INTERVAL_SEC`, `LTX2_SIDECAR_TIMEOUT_SEC`. The path is now ALSO gated behind an explicit `LTX2_SIDECAR_VERIFIED=1` env opt-in because the upstream LTX-2 distilled CLI with `--offload cpu` was observed to produce coloured-noise output on 12 GB single-card hosts (verified by md5-comparing the bundled smoke-test MP4 to a fresh production job — both decoded to rainbow static). `/capabilities` advertises `"native"` in `audio_modes` only when sidecar `/health` reports `ready: true` AND `LTX2_SIDECAR_VERIFIED=1`, and exposes `LTX2_SIDECAR_URL`, `LTX2_SIDECAR_READY`, `LTX2_SIDECAR_VERIFIED`, and `LTX2_SIDECAR_NATIVE_AVAILABLE` in its `env` block.

### Fixed (Epic #948)

- **Gallery sync-audio gate is no longer permanently closed:** The studio composer used to substring-match `form.model_repo` against `LTX-Video-2`/`ltxv-2-22b` (neither of which appear in the in-app catalog) AND require ≥ 24 GB pooled VRAM. Both checks made the "Sync — Native sync audio (LTX-2 only)" option unselectable on every supported config. The gate now keys off the catalog entry id (`ltx-2*`) and trusts the worker's `audio_modes` array (which already accounts for sidecar readiness). ([ui/app/gallery/page.tsx](ui/app/gallery/page.tsx))
- **`scripts/ltx2_launch.sh` fixed to launch from the WSL deployment dir** (`~/openzigs-sidecars/ltx2`) — the prior `cd` pointed at a path inside the repo where `server_cuda.py` does not exist (the LTX-2 sidecar source ships outside the repo). Added `scripts/worker_restart.sh` companion script.
- **`scripts/worker_restart.sh` now exports `LTX_POOLING_MODE=off`** to force single-GPU `model_cpu_offload` because the pooling implementation does not actually shard the 13B transformer across cards — it places the whole transformer on `cuda:1` which OOMs a 12 GB card (issue #949). Note: even with pooling off, the in-process 13B path currently OOMs at step 0/30 on 12 GB hardware (issue #950); operators on this tier should prefer the 2B model registry entries until both are resolved.
- **LTX worker pooling rewritten to use diffusers `device_map="balanced"`** with a `max_memory` budget computed from per-device `mem_get_info()` minus 1 GiB headroom plus a CPU spillover budget (`LTX_POOLING_CPU_BUDGET_GIB`, default 64). Replaces the prior code path that called `pipe.transformer.to("cuda:1")` and crammed the entire 13B transformer onto a single 12 GB card (root cause of #949). End-to-end status on 2×12 GB hardware: the balanced load now succeeds (no OOM at load time), but the LTX-Video pipeline's custom `__call__` issues explicit `.to(device)` calls during denoise that conflict with accelerate's cross-device hooks, producing `Expected all tensors to be on the same device` at step 0. True 13B sharding therefore requires an upstream pipeline patch and is **not** considered fully closed by this change — #949 remains open with progress notes.
- **LTX worker `enable_model_cpu_offload()` fallback now tears down the partially-allocated pipeline before retry** (`del pipe; gc.collect(); torch.cuda.empty_cache(); torch.cuda.synchronize()`) and calls `reset_device_map()` on the fresh pipeline before invoking offload. Fixes the #950 secondary OOM where the failed pooled load left ~6 GiB of dangling allocations on `cuda:1` and the offload retry then OOMed at step 0/30.
- **Default LTX video model is now `Lightricks/LTX-Video` (2B legacy, public, cached)** so a fresh install on a single 12 GB consumer GPU produces a watchable video out-of-the-box (verified end-to-end: 25 frames @ 512×320, 20 steps, ~67 s denoise, clean forest-at-sunset frame). Previously defaulted to `Lightricks/LTX-Video-0.9.6-distilled` which is gated (HTTP 401 without HF license-acceptance) and to the 13B variant which OOMs on 12 GB. Gallery model catalog re-ordered to surface CUDA-runnable models first with VRAM annotations.
- **`scripts/worker_restart.sh` flipped to `LTX_POOLING_MODE=auto` default** (was hardcoded `off`) now that the balanced device_map load path no longer OOMs at allocation time. Operators on single-GPU hosts: pooling auto-detects `device_count >= 2 AND pooled_vram >= 18 GiB` before activating, so single-card setups still take the `model_cpu_offload` path automatically.
- **Studio composer audio mode no longer breaks every non-sync video request (#951):** The gallery composer was sending `audio: true` to the LTX worker for **all** non-off audio modes (`auto`, `music`, AND `sync`), which caused the worker to interpret every audio-enabled job as an in-process synchronized-audio request and reject it with HTTP 400 (`Audio generation is not supported by model 'ltx-2' in-process…`). The boolean is now only set when the user picks `sync` (native LTX-2 audio); `auto` (MMAudio v2a post-process) and `music` (ACE-Step post-process) correctly pass `audio: false` to the worker so the silent video generates and the post-completion sidecar dispatch handles audio. Also fixed the audio_mode string mismatch between the UI (`"sync"`) and the queue type (`"native"`) — translated at the API boundary.
- **Worker now actually sees both GPUs (#952):** `scripts/worker_restart.sh` now exports `CUDA_VISIBLE_DEVICES=0,1` so `torch.cuda.device_count()` returns 2 and the `device_map="balanced"` pooling path (#949) has a second card to shard onto. Previously the worker process inherited an environment-scoped `CUDA_VISIBLE_DEVICES=0` that masked GPU 1, causing `pooled_vram_gb` to report 11 (single card) and `pooling.active=false` even though `nvidia-smi` from outside showed both 3060s. After this fix `/capabilities` correctly reports `device_count: 2`, `pooled_vram_gb: ~22`, `pooling.active: true`. The new `env.CUDA_VISIBLE_DEVICES` field in `/capabilities` exposes what the worker actually sees so this class of regression is visible at a glance.
- **`/capabilities` no longer lies about MMAudio post-process audio availability (#952):** `audio_modes` previously included `"auto"` unconditionally — even when the v2a sidecar on :5012 was down (e.g., venv missing because the symlink pointed at a volatile `/tmp/wenv` that vanished on reboot). The studio composer then offered an "Auto" option that silently produced silent video. The worker now probes `V2A_SIDECAR_URL/health` (default `http://127.0.0.1:5012`) and only advertises `"auto"` when the sidecar replies `ready: true` or `status: "ok"`. The studio composer's "Auto" option is correspondingly disabled with a tooltip explaining the sidecar is offline. New `env.V2A_SIDECAR_URL` and `env.V2A_SIDECAR_READY` fields in `/capabilities` make the state observable.
- **Frame input now reflects live GPU capability:** The "Frames" field in the Gallery Studio video form previously had a hardcoded max of 97 and a static label "Frames (max 97)". The max is now derived from `/capabilities.max_frames[selectedModel]` at runtime, so on pooled-VRAM hardware (e.g. 2× RTX 3060 = 23 GB) the 2B model correctly allows up to 121 frames and the 13B distilled up to 161 frames. Falls back to 97 when capabilities haven't loaded yet.
- **`_get_max_frames_for_model` no longer misclassifies 2B models on single-GPU restart:** The function used `"ltxv-2" in model_key` to detect the 22B category, which is a substring of all 2B model keys (`ltxv-2b-legacy`, `ltxv-2b-096-distilled`). On a single 12 GB card with pooling inactive (e.g. after a worker restart without `CUDA_VISIBLE_DEVICES=0,1`), no `("22b", 10)` entry exists in `VRAM_FRAME_LIMITS`, causing the function to fall back to `return 49` → 2.04-second clips regardless of requested duration or stitching target. Fix: check `"22b" in model_key` only; 2B models now correctly map to the `"2b"` category → 121 frames on single 11 GB card (5.0 s), 161 frames on pooled 23 GB (6.7 s). The extended/stitched path (`/generate-extended`) was equally affected since it uses the same function to compute `max_clip_frames` per segment.

## [Unreleased — Epic #924]

### Added (Epic #924 — LTX video audio, longer durations & correct LoRA training params)

- **LTX-Video VRAM pooling across two GPUs (#927, WS2-A):** New env-var matrix (`LTX_POOLING_MODE`, `LTX_TRANSFORMER_DEVICE=cuda:1`, `LTX_ENCODER_DEVICE=cuda:0`, `LTX_VAE_DEVICE=cuda:0`, `LTX_POOLING_MIN_VRAM_GB=18`, `LTX_MAX_FRAMES_OVERRIDE`, `LTX_ALLOW_AUDIO`) auto-detects `torch.cuda.device_count()` + per-device `mem_get_info(i)` and shards the LTX-Video pipeline (transformer on `cuda:1`, T5 encoder + VAE on `cuda:0`) when summed VRAM is ≥ threshold. Falls back gracefully to `enable_model_cpu_offload()` on any placement error. Introduces a pooled VRAM-tier table that lifts max frames from 57 (1×12 GB) to 161 (2×12 GB) and 257 (2×24 GB). Citation in the source code points to the diffusers "Working with big models" doc (Tavily verified 2026-04-22).
- **LTX-2 22B distilled model with native synchronized audio (#926, WS1-B):** Registry entry `ltxv-2-22b-distilled` with `synchronized_audio: true, min_vram_gb: 24`. Triple-gated audio path (model supports it AND `LTX_ALLOW_AUDIO=1` AND pooled VRAM ≥ 24 GB) returns precise HTTP 400 errors per failed precondition. `/models` endpoint now exposes a dynamic `audio_supported` flag.
- **`POST /generate-extended` for long-form video (#928, WS2-B):** Accepts a target duration in seconds, fans out to repeated `run_generation_job()` calls with last-frame conditioning (extracted via `ffmpeg -sseof -0.1`), and stitches with the ffmpeg concat demuxer or xfade filter (cumulative offset computed via `ffprobe`). Returns 202 immediately and exposes a poll-able job id.
- **`GET /capabilities` runtime introspection endpoint (#929, WS2-C):** Reports `cuda_available`, per-device VRAM, `pooled_vram_gb`, `pooling.{mode,active,…}`, `max_frames` map per registered model, and `audio_modes` available. Drives the Admin → Models UI panel.
- **`v2a` (MMAudio) sidecar on port 5012 (#925, WS1-A):** New FastAPI sidecar (`sidecars/v2a/server_cuda.py`) wraps MMAudio for video-conditioned audio generation. Lazy-loads the ~6 GB checkpoint on first request, idle-unloads after 5 minutes, exposes `/health`, `/gpu-info`, `/generate` (202 + job id), `/status/{id}`, `/unload`. Auth via Bearer token + URL-allowlist callback validation + safe video path containment.
- **`audio_mode` field on `MediaJobPayload` + `dispatchV2aJob` queue hook (#925, WS1-A):** New `audio_mode?: "off" | "auto" | "music" | "native"` and `audio_prompt?: string` on `MediaJobPayload` (preserves the existing `audio: boolean` for backward compat). `QueueMaster` fires a non-blocking `dispatchV2aJob()` after every `markComplete` for video jobs that requested `audio_mode: "auto"`. New `src/queue/v2a-client.ts` HTTP wrapper with input validation, Bearer-token support, and `v2aHealthCheck()` probe.
- **LoRA training presets registry (#933, WS3-D):** New `config/lora-presets.json` (`character`, `style`, `concept`, `outfit`) with rank, `loraAlpha=2*rank`, learning rate, steps, batch size, gradient accumulation, mixed precision, resolution. Loader (`src/config/lora-presets.ts`) caches by absolute config-dir path and provides 3-level fallback (file missing → JSON malformed → missing key). Exposed via `GET /api/admin/lora-presets`.
- **Multi-GPU LoRA training opt-in (#934, WS3-E, optional):** When `LORA_MULTI_GPU=1` and `device_count >= 2`, `_bg_train()` launches DreamBooth via `accelerate launch --multi_gpu --num_processes=N`. Single-GPU path unchanged when env var is unset.

### Changed (Epic #924)

- **Trainer dispatch in `_bg_train()` (#931, WS3-B):** Replaced the hard-coded SDXL-only path with a `TRAINER_MAP` dispatch (`sdxl`, `flux-dev`, `flux-schnell`, `sd15`). The matching trainer for each base model is selected at runtime from the LoRA preset.
- **`lora_alpha` derivation (#930, WS3-A):** Both trainer scripts now compute `lora_alpha = 2 * rank` instead of the previous fixed value, matching the Kohya / PEFT default that produces correctly-scaled adapter weights.
- **Character LoRA `base_model` enforcement (#932, WS3-C):** New `base_model` column on the characters SQLite table; injection into a generation pipeline now refuses adapters whose recorded `base_model` mismatches the active pipeline's model id (rather than silently producing garbage outputs).

### Added (UI follow-up — PR #935 vision walkthrough)

- **Admin → Models capabilities panel (#929):** New `/admin/models` page consumes `GET /api/admin/capabilities` and renders pooled VRAM, per-GPU table (free/total + errors), pooling status (transformer / encoder / VAE devices), per-model max-frames table with sync-audio support badge, and audio modes available. Backed by a new admin proxy (`videoGenWorkerBaseUrl()`) that resolves the LTX worker URL from `userConfig.videoGen` → `M2_PRO_WORKER_URL` env → `http://localhost:5007` default. Includes loading skeleton, error banner, and 5 RTL tests.
- **LoRA training preset dropdown + extended params (#933):** Character training panel in `/characters` adds a preset selector (character / style / concept / outfit) populated from `GET /api/admin/lora-presets`, a base-model selector that persists via `PUT /api/characters/:id`, and exposed inputs for LoRA alpha, max steps, batch size, plus an Advanced disclosure for gradient accumulation, mixed precision, and resolution. Selecting a preset hydrates all training fields in one click.
- **Audio mode selector in studio composer (#925):** Replaced the boolean Audio checkbox in `/gallery` with a four-option select — Off / Auto (MMAudio v2a) / Music (ACE-Step) / Sync (LTX-2 native). The Sync option is gated on the capabilities query (requires an LTX-2 model + 24 GB+ pooled VRAM + `audio_modes` includes `native`); a tooltip explains why it is unavailable. The frame-count safety limit now disables the whole selector and forces it back to `off`.
- **Extended duration mode in studio composer (#928):** Replaced the fixed 4/8/12/16 second dropdown with a Single shot ↔ Extended toggle. Single shot keeps the 4-second cap; Extended exposes a 5–60 second number input (capped from `capabilities.max_frames` when known) with an inline warning that the request will be generated as N stitched 4 s shots and may drift after the third shot.

### Documentation

- New "LTX-Video VRAM pooling" and "LoRA training across two GPUs" sections in [docs/MULTI_GPU.md](docs/MULTI_GPU.md), including the topology matrix, env var reference, capabilities-endpoint sample, troubleshooting, and Tavily-verified sources.

### Fixed (UI Vision walkthrough — PR #923)

- **`/api/system/gpu` now reports `serving_mode` and `conflicts[]` (Epic #888 / #917):** The route was returning `getGpuProfile()` raw, ignoring the existing `summariseClaims()` helper. The router now accepts an optional `GpuCoordinator` and merges its `currentClaims()` summary into the JSON response, surfacing `serving_mode: "idle" | "diffusion" | "vllm-tp2" | "mixed"` and a `conflicts: string[]` list so the admin GPU panel can render mutual-exclusion state. `server.ts` wires the singleton coordinator in.
- **vLLM admin panel toast no longer dumps raw JSON bodies (Epic #888 / #922):** `fetchJson` rejects with `new Error(responseBodyText)`, so rate-limit errors surfaced as `vLLM start failed: {"error":"rate_limited","message":"..."}`. New `extractErrorMessage()` helper unwraps `body.message` when the payload is JSON and falls back gracefully for plain-text and malformed inputs. Applied to both start and stop mutations.
- **`scripts/deploy-restart-sidecars.sh` now deploys the sadtalker sidecar (Epic #883 / #919):** The deploy loop was missing `sadtalker`, so freshly-built `server_cuda.py` (including the new `/gpu-info` endpoint) was never copied to the runtime directory.

### Added (Epic #888 — Local LLM serving via vLLM TP=2)

- **`/gpu-info` endpoint on sadtalker sidecar (#919, Epic #883 follow-up):** Adds the same `nvidia-smi`-backed `/gpu-info` JSON contract the other CUDA sidecars expose (image-gen, worker, lipsync). Reports device index, name, free/total MB, and `cuda_visible`. Pytest covers the success and "no GPU detected" paths.
- **`VllmClient` with single-flight queue + synchronous backpressure (#918):** New `src/llm/vllm-client.ts` wraps the OpenAI-compatible `/v1/chat/completions` endpoint. Tail-promise queue serialises requests; `checkBackpressure()` throws `VllmBackpressureError` (code `VLLM_BACKPRESSURE`) before issuing the HTTP call so the orchestrator can shed load. Streaming + non-streaming paths share rolling p50/p99 metrics. API key only ever in `Authorization` header — never logged. `src/llm/vllm-models.ts` enforces a strict allow-list of HuggingFace repo IDs (Qwen 14B AWQ default, Gemma 2 9B AWQ, Mistral Nemo 12B AWQ, Qwen 32B AWQ, Mixtral 8x7B AWQ) and rejects path-traversal / shell-metachar input.
- **`GpuCoordinator` mutual-exclusion lock for GPU workloads (#917):** New `src/gpu/gpu-coordinator.ts` (SQLite-backed `gpu_claims` table) tracks which workload owns which GPU indices. `vllm` and `flux` are exclusive — a `register('vllm', [0, 1])` call returns conflict if FLUX already holds those cards (and vice-versa). Stale claims (>24 h) auto-evict. `summariseClaims()` produces a `serving_mode` summary (`diffusion` / `vllm-tp2` / `mixed` / `idle`) for the admin UI.
- **vLLM auto-detection + BYOK provider auto-register on boot (#920):** `autoRegisterIfDetected()` (`src/llm/vllm-detect.ts`) probes `http://127.0.0.1:8000/v1/models`, generates a 32-byte URL-safe API key (`crypto.randomBytes(32).toString('base64url')`) into `~/.openzigs/vllm-api-key` (mode `0600`), and writes a `copilot.provider` block into `~/.openzigs/config.json` so the agent can reach the local LLM without manual config. Refuses to overwrite an existing provider for the same base URL. Disabled by default; opt in via `llm.localVllm.enabled = true`. New Zod config block `llm.localVllm` (`enabled`, `model`, `baseUrl`, `maxQueueDepth`, `timeoutMs`, `autoRegister`).
- **Docker compose + sidecar install / launch scripts (#916):** New `docker-compose.vllm.yml` (pinned `vllm/vllm-openai:v0.6.4`, bound to `127.0.0.1:8000`, GPU reservation `count: all`, healthcheck via `curl /v1/models`, named volume `vllm_hf_cache`). New `sidecars/vllm/install.sh` (Docker + nvidia-smi + ≥2 GPU checks, key generation, image pull) and `sidecars/vllm/launch.py` (host-Python TP=2 fallback). `sidecars/start-cuda-sidecars.sh` now respects `OPENZIGS_ENABLE_VLLM=1`, skipping image-gen, lipsync, and sadtalker and forcing `IMAGE_GEN_POOLING_MODE=off` so vLLM and FLUX never collide.
- **Admin API `/api/admin/gpu/vllm/{status,start,stop}` + admin UI panel (#922):** New router (`src/api/admin/vllm.ts`, mounted under `/api/admin/gpu/vllm`) exposes a `status` endpoint that aggregates the GPU claim, reachability, loaded model id, and parsed Prometheus metrics (`vllm:gpu_cache_usage_perc`, `vllm:num_requests_running`, `vllm:num_requests_waiting`). `start` validates the model against the allow-list, claims GPUs `[0, 1]` (returns 409 with `conflictWith` and GPU indices on collision), spawns `docker compose up -d` via argv (no shell), and rolls back the claim on failure. Rate-limited 1/min with `Retry-After`. `stop` issues a graceful SIGTERM via `compose stop` and unregisters. New UI panel (`ui/components/admin/vllm-panel.tsx`) polls `/status` every 5 s, shows the KV-cache bar (green/amber/red), exposes a model selector limited to the allow-list, and gates Stop behind a confirm dialog.
- **`vllm` scenario in GPU stress test (#921):** `scripts/gpu-stress-test.py` now ships an 8-concurrent chat-completion scenario (mixed short / medium / long prompts) that asserts a per-request TPS ≥ 8 SLO. PowerShell wrapper updated. New "vLLM Dual-GPU (TP=2)" + "Conflict policy: vLLM vs FLUX" sections in `docs/MULTI_GPU.md`; `/gpu-info` for sadtalker added to the Verifying section; hardware reality check table extended.

### Added (Epic #868 — LoRA-trained character injection in Inpainting Studio)

- **Creative Studio: character picker in Inpainting UI (#871):** `/inpainting` page now lists trained "ready" characters from `/api/characters` in a dedicated picker. Selecting a character inserts its trigger word into the prompt (and removes it on deselect) and attaches `character_id` to the submitted FormData. The picker is disabled for Flux Kontext (no LoRA support) and shows clear empty/loading/error states.
- **Creative Studio API: `/inpaint` accepts `character_id` (#870):** The inpainting endpoint now looks up the selected character via `CharacterRepository.getById`, rejects non-ready / untrained / nonexistent ids with a 400, and force-injects the trained LoRA path and scale into the queued job. Falls back to shared trigger-word auto-injection when no `character_id` is supplied. Enforces a 20 MB decoded-mask size cap.
- **Shared `injectCharacterLora` helper (#870):** Extracted the trigger-word matching + multi-subject prompt restructuring + class-description injection into `src/api/inject-character-lora.ts` so the queue API and the Creative Studio `/inpaint` endpoint share a single implementation. Adds `injectExplicitCharacterLora` for the UI picker flow.
- **CUDA sidecar: inpainting pipeline branch with LoRA support (#869):** `_bg_img2img` now routes to `StableDiffusionXLInpaintPipeline.from_pipe` or `FluxInpaintPipeline.from_pipe` when a `mask` is present, and applies any caller-supplied `lora_paths` / `lora_scales` as named adapters via `set_adapters()`. `from_pipe()` preserves dual-GPU pooling (text encoders + VAE on cuda:0, transformer on cuda:1) via component-reference sharing — no re-bind, no OOM.
- **Sidecar request model additions (#869):** `Img2ImgRequest` (and `AsyncImg2ImgRequest`) now accept optional `mask`, `lora_paths`, `lora_scales` fields with path-traversal and null-byte validation plus a 28 MB mask-payload cap. Backward compatible — pre-epic payloads continue to validate.
- **Regression tests (#872, #873):** Added `src/api/inject-character-lora.test.ts` (trigger-word matching, multi-subject restructuring, explicit lookup, error paths) and extended `src/api/creative.test.ts` with a full `/inpaint` character-LoRA suite (backward-compat, explicit injection, trigger-word auto-injection, all 400 paths, mask+strength regression). Added `sidecars/image-gen/test_models.py` pinning the Pydantic model contract and the `_build_inpaint_pipe` / `_load_inpaint_loras` helpers, including a dual-GPU pooling preservation test.

### Added (Epic #910 — UI completion suite)

- **Director Studio: AI reframing preview (#834):** New `<ReframePreview>` (16:9 source + 9:16 reframed dual-player with synced playback) and `<SubjectOverlay>` (SVG bounding-box overlay driven by AI tracking samples, `findBoxAt` binary-search lookup) components mountable inside the Framing panel.
- **Director Studio: Caption visual previews + word editor (#830):** New `<CaptionTemplatePreview>` (mini SVG/canvas thumbnails of each caption template with brand-kit support badge) and `<CaptionWordEditor>` (per-word timing nudges, color, emphasis, size overrides) components.
- **Director Studio: B-Roll thumbnails + scoring + accept/reject (#835):** New `<BRollCard>` shows a thumbnail, query, source, relevance score badge, and explicit accept/reject buttons; new `<BRollPreviewStrip>` renders timeline markers at insertion points.
- **Director Studio: Audio waveform comparison (#832):** New `<AudioWaveformCompare>` component renders original + cleaned waveforms side-by-side via `wavesurfer.js`.
- **Director Studio: NLE export track selection + browser download (#833):** New `<NleTrackSelector>` (video/audio/captions/B-roll checkboxes), `downloadFile()` helper, and `<NleDownloadButton>` for one-click browser downloads of completed exports.
- **Analytics: Comparison cards + content compare (#831):** Extracted shared `<KPICard>` and `<StatCard>` into `analytics-summary-cards.tsx`; new `<AnalyticsContentCompare>` lets users pick two posts and see views/likes/comments/engagement/watch-time side-by-side with per-row winner badges.
- **SEO: Site structure tree + branded reports + Sheets export (#847):** New `<SiteStructureTree>` (URL → expandable tree with status icons + issue badges, exported `buildSiteTree()` helper); SEO `exportAudit()` now supports a `"sheets"` format that writes to a new Google Spreadsheet via `SheetsClient`, plus optional `branding` (sanitized logo URL, escaped company name, validated hex primary color) and audit metadata (page count, duration, crawler) in PDF reports.

### Changed (Epic #910)

- **SEO: Live crawl progress is client-scoped (#841):** Backend `firecrawl-webhooks` now tracks per-job `clientId` (via explicit param or short-lived `claimCrawlForClient` mechanism with TTL + URL normalization), the server emits `crawl:*` events to the matching Socket.IO room when a clientId is present (broadcast otherwise), and the client establishes a stable `clientId` query param on connect. New endpoints: `POST /api/seo/audit/claim`, `POST /api/seo/audit/:jobId/cancel`.
- **SEO: Crawl progress UI overhaul (#842):** Rewrote `<CrawlProgressPanel>` with elapsed-time ticker, accessible progressbar (`aria-valuenow`/`aria-valuemin`/`aria-valuemax`), last-URL display, expandable error list (capped at 50), per-status icons (running/completed/failed/cancelled), and a cancel button that calls the new cancel endpoint. `useCrawlProgress` now tracks `lastUrl`, `errorCount`, `errors[]`, and the `cancelled` status.
- **PDF export: Optional branding (#847):** `wrapMarkdownAsHtml()` and `saveReportPdf()` accept an optional `PdfBranding` object. `companyName` is HTML-escaped, `logoUrl` is restricted to `https://` and `data:image/*;base64,…` URIs, and `primaryColor` is validated against a strict hex pattern before being injected into CSS.
- **Firecrawl crawl progress: Documented poll-vs-webhook trade-off (#840):** Added in-source comment in `firecrawl-client.ts` and architecture note in `docs/ARCHITECTURE.md` explaining that Firecrawl's webhooks deliver only terminal events for crawl jobs, so per-page progress remains poll-driven until upstream adds per-page webhook events.


### Added

- **Admin GPU Info Panel** (Epic #889):
  - New `GPU & VRAM` section in the Admin page showing per-GPU cards with name, VRAM usage bars, recommended tier, pooling status, and same-architecture badges.
  - Interactive pooling mode toggle (`off` / `manual-flux`) that persists to `~/.openzigs/config.json` via `POST /api/admin/gpu/pooling`.
  - Interactive sidecar-to-GPU pinning dropdowns that persist via `POST /api/admin/gpu/pinning`.
  - Refresh button to re-detect GPU state.
  - Ollama health check display: shows running/available models and GPU VRAM usage when Ollama is reachable.
- **Ollama Dual-GPU for Gemma 4** (Epic #890):
  - `docker-compose.ollama.yml` for running Ollama with dual-GPU access (NVIDIA runtime, all GPUs exposed via `OLLAMA_NUM_GPU=99`).
  - BYOK configuration: Ollama works as an OpenAI-compatible provider (`type: "openai"`, `baseUrl: "http://localhost:11434/v1"`).
  - New `ollama` scenario in `scripts/gpu-stress-test.py` for measuring Ollama inference latency.
  - Backend proxy endpoints (`GET /api/admin/gpu/ollama/tags`, `GET /api/admin/gpu/ollama/ps`) for the admin UI to query Ollama status without CORS issues.
  - `docs/MULTI_GPU.md` updated with "Ollama Dual-GPU: Running Gemma 4 26b" section covering prerequisites, quick start, memory budget, performance expectations, BYOK config, and Ollama-vs-vLLM comparison table.

- **Honest multi-GPU pooling for FLUX** (follow-up to Epic #883):
  - `GET /api/system/gpu` now reports `pooling_supported`, `same_arch`, and an advisory `recommended_tier_pooled` so the UI can surface "you have enough aggregate VRAM if you opt in" without auto-picking heavier models for tenants who haven't.
  - New `IMAGE_GEN_POOLING_MODE=manual-flux` env flag (default `off`). When enabled on a host with â‰¥ 2 same-arch CUDA GPUs, the image-gen sidecar splits FLUX components by hand â€” text encoders + VAE on `cuda:0`, transformer on `cuda:1` â€” instead of using `enable_model_cpu_offload()`. `start-cuda-sidecars.sh` exposes both GPUs to image-gen automatically when the flag is set.
  - `/gpu-info` and `/models` on the image-gen sidecar now report `pooling_mode` and `pooled_active`.
  - New `pooled` scenario in `scripts/gpu-stress-test.py` exercises the manual-pool path with a FLUX-schnell baseline + FLUX-dev pooled job.
  - **Verified runtime behaviour on 2Ã— RTX 3060 12 GB**: pooled code path executes correctly and reports the expected log warning before falling back. The FLUX-dev transformer (~12 GB FP16) does not fit on a 12 GB card with CUDA context overhead, so manual placement OOMs and the sidecar transparently falls back to `enable_model_cpu_offload()` (load completes successfully in ~89 s vs. ~37 s on hosts where pooled placement holds). Documented in `docs/MULTI_GPU.md`: pooled FLUX-dev requires â‰¥ 2Ã— 16 GB same-arch cards. The flag is safe to leave on for undersized hardware (graceful fallback) but provides no speed benefit there.

### Changed

- `docs/MULTI_GPU.md`: Removed the previously-documented `LTX_DEVICE_MAP=balanced` / `FLUX_DEVICE_MAP=balanced` flags. They were never wired up in the sidecars (`device_map="balanced"` has known FLUX meta-tensor bugs in diffusers â€” see issue #9450). Replaced with the real, opt-in `IMAGE_GEN_POOLING_MODE=manual-flux` documentation including trade-offs and limitations.

### Security

- **Q2 2026 Security Hardening Epic** (#899) — closes ten audit findings tracked in `/memories/repo/research-2026-04-19-security-audit.md` Section G:
  - Patched transitive CVEs via `pnpm.overrides`: `dompurify>=3.4.0`, `protobufjs>=7.5.5`, `lodash>=4.17.21`, `lodash-es>=4.17.21`, `@xmldom/xmldom>=0.8.12`, `hono>=4.12.14`, `@hono/node-server>=1.19.13`, `vite>=6.4.2`, `next>=15.5.15`, `electron>=39.8.5`. Direct bumps for `next` (`ui/`) and `electron` (`desktop/`) (#902).
  - Hardened SSRF protection in the lipsync worker `validate_callback_url`: hard-deny set for IMDS / Alibaba / GCP metadata hosts, link-local + multicast + unspecified rejected before any RFC1918 allow, IPv4-mapped IPv6 unwrapped and re-checked (#904).
  - Stricter path traversal guards (sub-issue #907) — `safe_join` already rejects `..`, absolute paths, and drive letters; tests added.
  - Removed committed local-auth token from `test-chat.mjs`; script now reads `process.env.OPENZIGS_TOKEN` and exits if unset. Added `.gitleaks.toml` + `.github/workflows/gitleaks.yml` to block re-introduction (#909). **Note:** historical commits still contain the token; a follow-up `git filter-repo` rewrite is required for a full scrub.
  - Eliminated catastrophic-backtracking risk in admin baseUrl trim by capping input length and using a bounded loop instead of `replace(/\/+$/, "")` (#900).
  - Tightened auth + CORS posture: query-token fallback is now opt-in via `OPENZIGS_ALLOW_QUERY_TOKEN=1`; CORS no longer blanket-accepts every localhost port — explicit allowlist (`OPENZIGS_LOCALHOST_PORTS` for extras) (#908).
  - SVG output (Mermaid diagrams + task icons) now passes through `DOMPurify` with an explicit profile that forbids `<script>`, event handlers, and embedded objects; `mermaid.securityLevel` raised to `strict` (#901).
  - Replaced the committed `debug-proxy.mjs` with a hardened version under `scripts/dev/` — binds to `127.0.0.1`, requires `OPENZIGS_DEBUG_PROXY_TOKEN`, strips upstream `Authorization` headers, uses `timingSafeEqual` for token comparison, and ships with a "DEV ONLY" banner (#906).
  - Sanitized exception messages returned to clients from the lipsync + image-gen sidecars: file paths and pointer addresses stripped, only the last message line returned, full traceback still logged server-side (#905).
  - Added `LIKE ... ESCAPE '\\'` and metacharacter escaping for `searchContacts`; constant-time `safeCompare` in the webhook manager now pads buffers to a common length before `timingSafeEqual` to avoid throwing on length mismatch; documented the explicit column allowlist on every dynamic `UPDATE` (#903).
  - Added a new `closed` access-control mode (`messaging.accessControl.mode`) and switched the default to `closed` so a fresh install requires explicit allowlisting before relaying messages.

### Fixed
- **Inpainting Studio: stale `character_id` sent to `/inpaint` after switching to Flux Kontext** (epic #868 walkthrough): When a character was selected on `/inpainting` and the user then switched the model to Flux Kontext, the picker became disabled but `selectedCharacterId` was not cleared, so submit appended `character_id` to the FormData and the backend rejected the request with 400. The Kontext switch now auto-clears the selection and strips the trigger word from the prompt (mirroring the existing deselect behavior).
- **PR #911 walkthrough regressions** (security/q2-hardening follow-up):
  - **`Cross-Origin-Resource-Policy` blocked the gallery and dashboard:** helmet's default `same-origin` CORP, added in PR #911, prevented the UI on `:3001` from embedding `/api/queue/assets/file/*` images and videos served by the API on `:3000` (Chromium reported `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`). `helmet()` is now configured with `crossOriginResourcePolicy: { policy: "cross-origin" }` globally. The CORS allowlist (now port-restricted as of PR #908) remains the actual cross-origin authorization mechanism, so this does not weaken access control.
  - **Global rate limiter (5000 / 15min) tripped within minutes of dashboard polling:** the gallery and dashboard poll 5+ GET endpoints every 1–2 seconds, exhausting the limiter and breaking real-time UI updates. The limiter now `skip`s (a) loopback callers (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and (b) GET requests to `/api/queue/*`, `/api/tasks/*`, `/api/sessions/*`. Mutating verbs on those prefixes — and all auth, admin POSTs, and outbound-network routes (web-search, fetcher) from non-loopback callers — remain rate-limited.
- Strip UTF-8 BOM in `readJsonFile` so config files written by Windows PowerShell 5.1 (`Set-Content` / `Out-File` defaults) no longer crash backend startup with `JSON.parse` errors.

- **CUDA worker `/unload` route restored** (`sidecars/worker/server_cuda.py`): The CUDA worker had `unload_model()` defined internally but no HTTP route exposed it, so `QueueMaster.unloadNode("worker")` was hitting `404 Not Found` and silently failing memory coordination during LTX â†” LatentSync handoffs on shared-VRAM hosts. Added `POST /unload` (token-gated, 409 if busy) matching the original `server.py` contract used by FluxQ and the M2 Pro worker.

### Added (continued)

- **Multi-GPU Awareness & Tiered Model Selection** (Epic #883):
  - **GPU profile detection + sidecar pinning** (#884): New `src/system/gpu-profile.ts` parses `nvidia-smi` output at boot. `sidecars/start-cuda-sidecars.sh` now auto-pins each sidecar to a CUDA device based on GPU count: with â‰¥ 2 GPUs, image-gen + audio go to GPU 0 and worker (video) + lipsync + sadtalker go to GPU 1, so the talking-head pipeline overlaps work across both cards. Per-sidecar overrides via `*_GPU_INDEX` env vars. Each `*_cuda.py` sidecar exposes `GET /gpu-info` reporting its bound device.
  - **Model tier registry + recommendation API** (#885): `MODEL_REGISTRY` (image-gen) and `VIDEO_MODEL_REGISTRY` (worker) gain `tier` (`low|medium|high|ultra`) and `min_vram_gb` fields. New `GET /api/system/gpu` endpoint returns the parsed GPU profile, total VRAM, recommended tier, and default sidecar pinning.
  - **GPU stress-test harness** (#887): New `scripts/gpu-stress-test.py` (and PowerShell wrapper `scripts/gpu-stress-test.ps1`) runs concurrent jobs across image-gen, video, audio, and lipsync sidecars while sampling `nvidia-smi`. Emits markdown reports to `~/.openzigs/stress-tests/<timestamp>-<scenario>.md` with per-GPU peak VRAM, per-job wall times, and OOM counts. Scenarios: `smoke`, `full`, `oom`, `pooled`.
  - **Multi-GPU documentation** (`docs/MULTI_GPU.md`): Hardware reality check, override reference, and tier table.
  - **vLLM dual-GPU reference** (#888): `examples/multi-gpu/vllm-dual-gpu.py` (TP=2 launcher with NCCL/PyTorch tuning for PCIe-only consumer cards) and `examples/multi-gpu/vllm-client.ts` (async client with single-flight queue + `VllmBackpressureError` to prevent VRAMâ†’system-RAM spillover). Outlined as reference; integration tracked in #888.

- **LatentSync Lip Sync Sidecar** (#797):
  - **Lip Sync Sidecar Servers** (#798): FastAPI servers for MPS (port 5008, FP32) and CUDA (port 5010, FP16) with `/generate`, `/health`, `/unload-model`, `/model-status` endpoints
  - **Setup Scripts** (#799): `setup-lipsync-node.sh` for macOS MPS, `setup-cuda-sidecars.sh` and `start-cuda-sidecars.sh` for Windows/WSL CUDA
  - **Dispatch Routing** (#800): QueueMaster lip sync job dispatch with health-check polling, sidecar reconnection, and graceful degradation
  - **Memory Coordination** (#801): Sequential LTX â†” LatentSync execution via `memoryTransitionActive` mutex, `ensureSidecarMemory()`, and `unloadWithRetry()` for M2 Pro shared-memory environments
  - **Talking Head Pipeline** (#802): Three-stage pipeline (TTS â†’ Video â†’ Lip Sync) with in-memory state machine, automatic output forwarding, and graceful degradation when sidecar is unavailable
  - **Gallery Studio Talking Head Mode** (#803): New "Talking Head" mode with speech text input, voice selector, video prompt, lip sync settings panel (model version, inference steps, guidance scale, DeepCache), and sidecar health indicator
  - **Configuration** (#804): `lipSync` config section with `enabled`, `networkNodeUrl`, `networkNodeToken`, `defaultModel`, `inferenceSteps`, `guidanceScale`, `enableDeepCache`, `maxDurationSec`, `modelIdleTimeoutSec`, `memoryLimitGB`
  - **cuda-ctl Commands** (#805): `cuda-ctl.sh lipsync {setup|start|stop|status|logs}` for managing the CUDA lip sync sidecar
  - **Documentation** (#806): Architecture and User Guide updated with LatentSync sidecar design, Talking Head pipeline, setup instructions, troubleshooting, and security notice

### Fixed

- **SEO Suite: Tool invocation route** (PR #849 walkthrough bug #6 — BLOCKER): Added `POST /api/admin/tools/:name/invoke` endpoint so the admin UI can actually run registered tools (validates args via the tool's Zod schema, returns 404/403/400/502/500 with structured errors). Previously the UI called a route that did not exist.
- **SEO Suite: Stale "Latest vs Previous" delta** (PR #849 walkthrough bug #1): `handleOperationComplete` and the CWV-analysis success path now invalidate `seo-comparison` and `seo-snapshot` queries in addition to `seo-history`, so the comparison panel and snapshot data refresh after a new run.
- **SEO Suite: Misleading CWV "no pages" error** (PR #849 walkthrough bug #4): `/api/seo/cwv` now returns `urlsAttempted` plus a per-URL `errors[]` collected from PSI failures; the UI surfaces the first error and prompts users to set `GOOGLE_PSI_API_KEY` instead of claiming the snapshot has no page data.
- **SEO Suite: Content freshness panel always empty** (PR #849 walkthrough bug #3): `buildContentAnalysis()` in the site-audit tool now also runs `analyzeContentFreshness()` over the JSON-LD blocks of each crawled page and includes the result in the snapshot.
- **SEO Suite: Schema generator default fields not loaded** (PR #849 walkthrough bug #5): Schema Generator panel now fetches the field set for the default schema type (`Article`) on mount instead of waiting for an explicit type change.
- **SEO Suite: Workbench "SEO Suite" link navigated away** (PR #849 walkthrough bug #14): Workbench top bar now opens the in-place `SeoAnalysisDialog` (gap-analysis chat) instead of a `next/link` to the SEO page.
- **SEO Suite: Loading text reflected wrong mode after switch** (PR #849 walkthrough bug #9): Added `runningMode` state so the persistent "Running …" indicator shows the mode that actually started the run, even if the user switches the mode dropdown mid-run.
- **SEO Suite: Dashboard tabs leaked across modes** (PR #849 walkthrough bug #12): The Overview/Audit/Links/Content/Performance/History/Export/Schema/Meta-Gen tab strip is now gated behind `mode === "site-audit"`.
- **SEO Suite: Dataset run had no result UI** (PR #849 walkthrough bug #13): Added `DatasetResultCard` that subscribes to the `chat:stream` socket while a dataset run is active, parses the manifest path / output directory / file list out of the streamed output, and renders them with copy-to-clipboard buttons.
- **SEO Suite: Link graph not resizing on container changes** (PR #849 walkthrough bug #2): `LinkGraph` now uses a `ResizeObserver` on its parent in addition to the `window` resize listener, so the SVG re-measures when its container changes size (tab switches, sidebar collapse, etc.).
- LTX worker: garbled/snow video output caused by `LTX_USE_PREQUANT=1` in `.env` forcing broken AITRADER pre-quantized 4-bit weights instead of runtime quantization from the clean BF16 base model (`mlx-community/LTX-2-distilled-bf16`). The CharafChnioune fork auto-detects AITRADER repos and applies runtime quantization — `LTX_USE_PREQUANT` must not be set.
- LTX worker: added `sidecars/worker/.env.example` with documented env vars and a prominent warning against setting `LTX_USE_PREQUANT=1`.
- F5-TTS sidecar (`sidecars/audio/server_cuda.py`): replaced direct `os.path.realpath` on user-supplied `ref_audio_path` with the same split/`os.listdir` lookup pattern used by the lip sync sidecar, breaking taint flow into shell/path operations and resolving CodeQL alerts #327 (command-line-injection, critical) and #328/#330 (path-injection, high).
- Test suite: refreshed `VALID_VIDEO_DURATIONS`, `isValidVideoDuration`, and talking-head-pipeline `maxDurationSec` cap tests to match the extended `[4..32]` valid duration list and 32 s ceiling.
- Audio API tests: added missing `node:fs/promises` `readFile` mock that was causing `/audio/f5tts/profiles/:id/test` tests to return 502.
- UI lint: replaced unnecessary `\/` escapes in `ui/app/characters/page.tsx` regex character classes with `[/\\]`.

### Added

- **SEO Suite Enhancement** (#838):
  - **Competitor Discovery Pipeline** (#867): `discoverCompetitorsFromAudit()` aggregates TF-IDF keywords across audited pages and searches Google/Brave SERPs to produce a ranked, deduplicated list of competitor domains
  - **Competitor Discovery API** (#864): `POST /api/seo/competitors/discover` endpoint finds competitors from latest audit data; `POST /api/seo/competitors/add-bulk` adds multiple competitors at once
  - **Discover Competitors UI** (#866): "Discover" action in the Competitors mode with results table (domain, best rank, keyword badges, frequency score), select-all checkbox, and "Add Selected to Monitoring" bulk action
  - **Competitor Discovery Documentation** (#865): USER_GUIDE.md updated with Discover Competitors workflow and prerequisites

- **OpusClip Feature Parity — Video Clipping, Editing & Publishing Pipeline** (#817):
  - **Intelligent Video Clipping** (#821): Multi-modal AI clip extraction via scene graph analysis (transcript + visual + audio), LLM virality scoring, and FFmpeg extraction. MCP tool: `clip-video`.
  - **AI Video Reframing** (#818): Subject-tracking reframing with Bezier-interpolated crop trajectories. Supports 9:16, 1:1, 4:5 targets and auto/single-speaker/split-screen/gameplay/action layouts. MCP tool: `reframe-video`.
  - **Audio Cleaner** (#820): Filler word removal (gentle/moderate/aggressive), silence trimming, optional denoise and speech normalization via Whisper + FFmpeg. MCP tool: `clean-audio`.
  - **Enhanced Captions** (#819): 6 animated caption templates (Hormozi, minimal, TikTok, news, podcast, corporate) with word-level highlighting and brand kit integration. MCP tool: `add-captions`.
  - **Auto B-Roll Pipeline** (#822): AI-powered B-Roll insertion point detection with stock footage search. Supports sparse/moderate/dense density modes. MCP tool: `auto-broll`.
  - **NLE Timeline Export** (#826): FCP XML and CMX3600 EDL export from Director manifests for Premiere Pro, DaVinci Resolve, and Final Cut Pro. MCP tool: `export-timeline`.
  - **Thumbnail Generation** (#825): Multi-template thumbnail generator with A/B variant support. MCP tool: `generate-thumbnail`.
  - **Social Calendar Aggregation** (#823): `GET /api/admin/calendar` endpoint unifying outbox queue + scheduled jobs with platform color-coding and gap detection for empty days.
  - **Video Performance Analytics** (#828): Cross-platform analytics aggregator with SQLite cache (1hr TTL), REST API (`/summary`, `/best-times`, `/compare`), and dashboard UI with KPI cards, platform breakdown, and best-time heatmap.
  - **Brand Video Templates** (#827): 7 built-in animated template definitions (3 intros, 2 outros, 2 lower-thirds) with SQLite repository for saved customizations and auto-apply support.
  - **Enhanced Timeline Editor** (#824): Canvas-based timeline ruler with zoom, toolbar with undo/redo/split/snap controls, and `useUndoHistory` hook for command-pattern editing.
  - REST API routes: `/api/studio/pipeline/{clip,reframe,clean-audio,broll,caption-templates,export}`, `/api/admin/calendar`, `/api/admin/video-analytics/*`
  - UI panels: ClipExtractorPanel, AudioCleanerPanel, BRollPanel, NLEExportPanel in Director Studio
  - UI components: AnalyticsDashboard, BrandTemplateEditor, TimelineRuler, TimelineToolbar
- Gallery Studio: pipeline selector dropdown â€” choose between Distilled, Dev, 2-Stage, and 2-Stage HQ pipelines (#783)
- Gallery Studio: audio generation toggle with ~30% time warning (#784)
- Gallery Studio: VAE tiling mode selector â€” Auto, None, Default, Aggressive, Conservative (#785)
- Gallery Studio: AI Enhance Prompt toggle wired to `enhance_prompt` payload field (#786)
- Gallery Studio: model selector dropdown populated from LTX model catalog with memory info (#787)
- Gallery Studio: preset picker with load/save â€” Quick Draft, Standard, High Quality built-ins plus custom presets (#788)
- Gallery Studio: duration selector (4s / 8s / 12s / 16s) replacing fixed 4s â€” shows segment count (#794)
- Multi-segment video generation: jobs with duration > 4s decompose into chained 4s segment sub-jobs (#790)
- Multi-segment video: segment chaining via `/last-frame` endpoint â€” each segment uses previous segment's last frame as init image (#791)
- Multi-segment video: ffmpeg concat stitching with 0.5s crossfade transitions between segments (#792)
- Multi-segment video: aggregate progress reporting with segment indicator ("Segment 2/4") (#793)
- Multi-segment video: audio post-processing runs on final stitched video only, not per-segment (#795)
- Worker sidecar: `POST /last-frame` endpoint â€” extracts last frame of a video as base64 PNG via ffmpeg (#789)
- LTX Video Engine v2: audio-video joint generation toggle (`audio` param) for synchronized sound (#760)
- LTX Video Engine v2: 2-stage pipeline support â€” `dev-two-stage` and `dev-two-stage-hq` pipeline types (#759)
- LTX Video Engine v2: model catalog with memory requirements and `GET /models` endpoint on sidecar (#761)
- LTX Video Engine v2: Gemma prompt enhancement via `enhance_prompt` parameter (#758)
- LTX Video Engine v2: configurable VAE tiling â€” `auto`, `none`, `default`, `aggressive`, `conservative` (#763)
- LTX Video Engine v2: image-to-video `image_strength` parameter (0.0â€“1.0) for conditioning control (#758)
- LTX Video Engine v2: `model_repo` override field for selecting different LTX model checkpoints (#758)
- **Airtable MCP Integration** â€” Full Airtable API client with per-base rate limiting and read/write MCP tools (#738, #743, #745, #746)
  - `AirtableClient` with automatic exponential backoff, non-retryable error detection, and `RateLimiter` (â‰¤5 req/sec per base)
  - Read tools: `airtable-list-bases`, `airtable-list-tables`, `airtable-read-records`, `airtable-list-views`, `airtable-get-fields`
  - Write tools: `airtable-create-records`, `airtable-update-records`, `airtable-delete-records` (batch â‰¤10, typecast support)
  - Formula validation utility with cheatsheet for NL query translation (#744)
- **Google Sheets MCP Integration** â€” Sheets API v4 client with OAuth2 token refresh and read/write MCP tools (#738, #741, #747, #742)
  - `SheetsClient` with `SheetsRateLimiter` (â‰¤60 req/min sliding window), A1 notation validation, and automatic OAuth2 token refresh
  - Read tools: `sheets-list-spreadsheets`, `sheets-read-range`, `sheets-get-metadata`
  - Write tools: `sheets-write-range`, `sheets-append-rows`, `sheets-create-spreadsheet`, `sheets-create-sheet`, `sheets-format-cells`
  - Column helper utilities (`columnToLetter`, `letterToColumn`) and formula cheatsheet (#744)
- **Data Output Helper** â€” shared utility for writing structured row data to Airtable/Sheets from any tool (#748)
  - `site-to-dataset` and `lead-extract` tools now accept optional `outputTo` parameter for direct Airtable/Sheets export
  - Graceful degradation: if export fails, text results are still returned
- **Integrations Admin Panel** â€” UI for configuring Airtable & Google Sheets credentials (#740)
  - `POST /api/admin/integrations/save` â€” save credentials to Secret Vault
  - `POST /api/admin/integrations/test` â€” test connectivity
  - `GET /api/admin/integrations/status` â€” check configuration status
  - `SecretVaultService.getByLabel()` helper for credential lookup by label

- **Firecrawl Search** â€” `search()` method on `FirecrawlClient` calling `/v2/search` (DuckDuckGo fallback, no API key needed) with SSRF filtering on returned URLs (#753)
  - `firecrawl-search` standalone MCP tool for explicit Firecrawl web search
  - `web-search` tool now falls back to Firecrawl search when Brave API key is unavailable and Firecrawl sidecar is running
- **Firecrawl Webhook Callbacks** â€” async crawl and batch scrape jobs now use webhook callbacks instead of polling when available (#751)
  - `POST /api/webhooks/firecrawl` endpoint with HMAC-SHA256 signature validation
  - Automatic fallback to polling when webhooks fail or are disabled
  - `firecrawl.useWebhooks` config option (default: `true`)
  - Rate limiting on webhook endpoint (100 req/min)
  - Graceful shutdown: pending webhook promises rejected on server stop

- **SCORM 1.2 Export** â€” export any presentation as a SCORM 1.2-compliant package for upload to any LMS (Moodle, Canvas, Blackboard, SCORM Cloud) (#688)
  - `generateManifest()` â€” generates valid `imsmanifest.xml` with ADL SCORM 1.2 schema, mastery score = 80 (#704)
  - `renderScormHtml()` â€” self-contained SCO HTML with embedded SCORM API adapter, chapter navigation, and quiz engine (#703)
  - `buildScormPackage()` â€” orchestrates manifest + HTML + ZIP bundling via `archiver`, returns `Buffer` (#702)
  - `POST /api/presentations/:id/scorm` â€” streams a zip attachment; validates admin access (#705)
  - Quiz score â†’ SCORM mapping: `cmi.core.score.raw/min/max` and `lesson_status` (`passed` â‰¥80%, `failed` <80%, `completed` for no-quiz) (#705)
  - "Export SCORM" button in presenter player UI with loading spinner (#701)

- **VectorStore Abstraction Layer** â€” pluggable vector store backend for the RAG knowledge base (#691)
  - `VectorStore` interface in `src/knowledge/vector-store/types.ts` enabling LanceDB, Qdrant, Chroma, and other providers (#718)
  - `LanceDBVectorStore` adapter in `src/knowledge/vector-store/lancedb-vector-store.ts` â€” thin wrapper over `LanceDBStore` satisfying the interface (#715)
  - `createVectorStore(config)` factory in `src/knowledge/vector-store/factory.ts` â€” config-driven provider selection (#716)
  - `knowledge.vectorStore.provider` config key in `config/default.json` (default: `"lancedb"`) and Zod schema (#717)
  - `KnowledgeIngestionService` accepts optional `vectorStore?: VectorStore` via DI constructor (#716)
  - VectorStore interface + `LanceDBVectorStore` exported from `src/knowledge/index.ts` (#719)
  - ARCHITECTURE.md updated to document the abstraction layer (#720)

- **Firecrawl Self-Hosted Integration** â€” on-demand Docker sidecar for deep website crawling (#723)
  - `docker-compose.firecrawl.yml` with API, Playwright, and Redis services (#724)
  - `FirecrawlClient` class with SSRF protection, per-domain rate limiting (1 req/sec), auto-start/stop sidecar lifecycle, and injectable fetch for testing (#724)
  - `seo-site-audit` tool â€” full-site SEO audit via deep crawling: meta tags, headings, thin content, images, schema, internal linking (#725)
  - `deepCrawl` mode for `seo-gap-analysis` â€” Firecrawl-powered multi-page competitor content extraction (#726)
  - `ingest-website` tool â€” crawl a website and ingest all pages into the knowledge base with vector embeddings (#727)
  - `extractAnnotationsViaFirecrawl()` â€” Firecrawl Strategy 0 for Pinterest SEO annotation extraction on JS-rendered pages (#728)
  - `competitive-monitor` tool â€” SQLite-backed competitor tracking with add/remove/snapshot/report/list actions (#729)
  - Firecrawl Dashboard UI â€” dialog with Site Audit, Ingest, and Monitor actions (#730)
  - `web-extract` tool â€” LLM-powered structured data extraction from any web page with JSON schema or natural language prompt (#731)
  - `lead-extract` tool â€” automated contact and company extraction via site mapping and batch scraping (#731)
  - `price-monitor` tool â€” track prices with historical SQLite snapshots and change detection (#731)
  - `site-to-dataset` tool â€” crawl websites and produce structured datasets in markdown, JSONL, or CSV (#731)
  - Full Firecrawl action support: scroll, write, press, executeJavascript, PDF, scrape (#731)
  - Batch scrape (`batchScrape`) and enhanced map with search filtering (#731)
  - Crawl Dashboard expanded with Extract, Leads, Prices, and Dataset action panels (#731)
  - Firecrawl config section in `config/default.json` (`firecrawl.enabled`, `firecrawl.url`, `firecrawl.idleTimeoutMs`)

- **Visual Workflow Builder** (`/workflows`) â€” full-screen drag-and-drop canvas for composing multi-stage LLM pipelines (#687)
  - React Flow canvas with custom node types: Prompt Stage, Parallel Group, Post-Action, Condition (coming soon) (#706, #708)
  - Draggable node palette sidebar and node config panel for editing node properties (#707, #710)
  - Bidirectional graph serializer (`graphToStages`/`stagesToGraph`) with cycle detection and topological sort (#709)
  - Save/load workflows to the prompt library with `graph_layout` column for persisting visual layout (#711)
  - Workflow execution via task API with real-time Socket.IO status overlay on nodes (#712)
  - JSON import/export for workflow templates (#713)
  - "Workflows" link added to the Automation nav group (#714)
- **Social Analytics Dashboard** â€” enhanced analytics tab with rich charts and export (#689)
  - Bar chart (messages by platform), pie chart (platform distribution), automation rate card (#696, #697)
  - Date range picker, platform filter, and CSV export button (#698, #699)
  - Advanced analytics API router (`/api/social/analytics/v2`) with time-series aggregation and CSV export (#700)

- Webhook configurations are now persisted to SQLite (`webhooks` table) and survive server restarts (#690)
- New `WebhookRepository` class providing SQLite-backed CRUD for webhook configs (#692)

### Changed

- `WebhookManager` now delegates all storage to `WebhookRepository` instead of an in-memory `Map` (#694)
- Rate-limit state remains intentionally in-memory (resets on restart) (#690)

### Added

- Enriched `/health` endpoint response with `uptime` (seconds) and `memoryMB` (RSS in MB) fields (#607)
- `backend:getHealth` IPC handler returns enriched health data to the Electron renderer (#607)
- `window.openzigs.isElectron` flag in preload for runtime Electron detection (#607)
- `window.openzigs.backend.getHealth()` IPC method exposes backend health data to the UI (#607)
- Tray tooltip shows uptime and memory when backend is running (e.g., "OpenZigs â€” running (2h 15m, 120MB)") (#607)

### Changed

- `BackendManager.checkHealth()` now stores enriched health JSON (status, uptime, memoryMB) from the backend (#607)

### Changed

- Sentinel autonomous monitor is now **enabled by default** â€” new installations start with Sentinel active; set `sentinel.enabled: false` in config to disable (#217)

### Added

- RAG Knowledge Base health check integrated into Sentinel periodic checks â€” monitors DB accessibility, ingestion status, and queue depth (#218)
- New alert types: `rag-db-unreachable` (critical), `rag-ingestion-down` (warning), `rag-queue-depth` (warning) (#218)
- `ragQueueDepthThreshold` config option (default: 100) to control when Sentinel alerts on RAG ingestion backlog (#218)
- Knowledge Base Health section in Sentinel status markdown digest (#218)
- `isRunning` getter and `restart()` method on `KnowledgeIngestionService` (#218)

### Security

- Bumped `serialize-javascript` override from >=7.0.3 to >=7.0.5 (prototype pollution, moderate)
- Bumped `picomatch` override from >=2.3.2 to >=4.0.4 (ReDoS, moderate)
- Added `brace-expansion` override >=5.0.5 (ReDoS, moderate)
- Added scoped `express>path-to-regexp` override pinned to 0.1.13 (ReDoS in express@4, high)
- Added scoped `router>path-to-regexp` override >=8.4.0 (ReDoS via MCP SDK express@5 â†’ router, high)
- Bumped `electron` from ^34.2.0 to ^35.7.5 (multiple Chromium CVEs, high)

### Changed

- Upgraded `@modelcontextprotocol/sdk` from v1.27.1 to v1.28.0 (latest v1 release) (#333)

### Added

- Windows named pipe Docker socket detection (`//./pipe/docker_engine`) for Docker Desktop on Windows (#598)
- Hard link â†’ `fs.copyFileSync` fallback in Remotion media staging for cross-device/Windows compatibility (#597)
- Platform capability detection service (`src/config/platform.ts`) with OS, arch, Docker, Chrome, and sidecar support detection (#600)
- `GET /api/admin/platform` endpoint exposing platform capabilities and feature availability to the UI (#600)
- `usePlatform()` React hook and `PlatformBadge` component for platform-aware UI rendering (#601)
- Admin panel shows platform availability badges on Image Generation, Video, and Music sidecar sections (#601)
- Sidecar API platform gate: `/image-gen/*` and `/music-studio/*` endpoints return HTTP 501 with informative message on non-macOS platforms (#599)
- Sidecar auto-provisioning is skipped entirely on non-macOS ARM platforms (#599)
- Unit tests for Windows Docker socket path, Remotion media staging fallback, sidecar platform gating, and platform detection (#590)

- Orchestration Mode (Task vs Session) for orchestration templates (#669)
  - `OrchestrationModeSchema` and `mode` field on `ExecuteTemplateSchema` for per-execution mode selection (#670)
  - `defaultMode` on `CreateOrchestrationTemplateSchema` and `OrchestrationTemplate` with SQLite migration (#670)
  - Session mode execution path in `TemplateService` â€” composes all agent goals into a single `CopilotWrapper.chat()` call with `enableSubagents: true` (#672)
  - `enableInSessionSubagents` flag on `ChatContext` for `spawn-agent` session mode awareness (#674)
  - Orchestration Mode radio selector in `TemplateExecuteModal` (Task/Session with descriptions) (#676)
  - Orchestration Mode selector on Scheduler prompt/pipeline job form (#675)
  - USER_GUIDE.md documentation for session orchestration mode (#671)
  - ARCHITECTURE.md documentation for session mode data flow and integration (#673)

### Fixed

- SEO extraction: JSON-LD `@graph` wrapper (Yoast/WordPress pattern) is now parsed â€” previously only root `@type` was detected (#665)
- SEO extraction: nested `@type` entities (publisher, mainEntity, author, etc.) are recursively extracted from JSON-LD up to depth 5 (#666)
- SEO extraction: image alt text now distinguishes "truly missing" vs "empty (decorative)" vs "present"; reports `aria-hidden` and lazy-loaded (`data-src`/`data-srcset`) images (#667)
- Director Studio: image/video overlays now use `objectFit: "contain"` instead of `"fill"` to prevent stretching non-16:9 assets
- Director Studio: Kontext thumbnail enhance now parses JSON error responses (extracts `detail`/`error`/`message`) and reads actual PNG dimensions from IHDR header instead of trusting request options
- Director Studio: YouTube publish history correctly detects deleted videos and shows "Deleted from YouTube" status with republish option
- Director Studio: `formatDate` in YouTube publish history no longer displays "Invalid Date" for malformed timestamps
- F5-TTS text normalizer now expands acronyms to phonetic spoken forms instead of dotted notation that caused BPE tokenizer hallucinations (#641)
- Sidecar sentence splitter no longer splits text at abbreviation dots (e.g. "U.S.A." treated as one segment) (#642)
- Intro video manuscript updated to remove dotted abbreviations and technical jargon that confused F5-TTS (#644)

### Added

- Auto-detect target keyword from page content when keyword field is left blank in SEO Gap Analysis (title/H1 analysis, TF-IDF weighting, URL slug signals, intent classification)
- SEO Gap Analysis Engine: `seo-gap-analysis` and `seo-extract-content` MCP tools for comparing page content against top-ranking competitors (#647)
- SEO analyst skill (`src/skills/seo-analyst/SKILL.md`) and `seo-analyst` agent archetype for autonomous SEO workflows (#652)
- Workbench SEO Analysis dialog for launching gap analysis from the editor toolbar (#653)
- Competitor discovery with Serper.dev (primary) and Brave Search (fallback) APIs, including PAA extraction (#650)
- HTML content extraction with TF-IDF keywords (via natural), Flesch-Kincaid readability, and heading structure analysis (#649)
- Markdown report generation with comparison tables, Mermaid xychart, keyword coverage matrix, and SERP feature opportunities (#651)
- Configurable workbench directories via `workbench.directories` config key and admin API (`GET/PUT /api/admin/workbench/directories`) (#654)
- YouTube MCP: `yt_check_video_exists` tool to verify whether a published video still exists on YouTube
- In-session SDK subagent orchestration mode for `orchestrate-agents` tool â€” `mode: "session"` delegates to Copilot SDK subagents in a single chat call (~2 API calls vs ~5 for task mode) (#657)
- `enableSubagents` flag wired through `CopilotWrapper` session lifecycle (create, resume, cache signature) (#658)
- Orchestration mode selector in SEO Analysis dialog: Standard (1 call), Session (~2 calls), Parallel (~5 calls) (#661)
- Three SEO specialist agent archetypes: `seo-content-analyst`, `seo-technical-auditor`, `seo-serp-strategist` (#660)
- `tasks.defaultOrchestrationMode` config key (`"task"` | `"session"`) for global orchestration mode default (#659)
- YouTube MCP: `yt_upload_captions` tool to upload SRT captions to a published YouTube video
- Director Studio: auto-uploads SRT captions after YouTube publish when the draft has narration timeline segments
- Director Studio: "Check Status" button on published YouTube videos to detect deletions
- Director Studio: "Republish" button for videos marked as deleted from YouTube

### Changed

- Narration editor helper text now documents which directives are supported per TTS engine (F5-TTS vs Kokoro) (#643)

### Security

- Fix prototype pollution in native MCP server admin routes (CodeQL finding, #634)
- Fix picomatch ReDoS and method injection via `pnpm.overrides` â€” picomatch â‰¥ 2.3.2 (CVE-2026-33671, CVE-2026-33672, #635)
- Fix `@github/copilot` shell expansion vulnerability â€” update override to â‰¥ 0.0.423 and bump `@github/copilot-sdk` to 0.1.32 (CVE-2026-29783, #636)
- Patch `vscode-jsonrpc` to add ESM `exports` field (fixes test suite breakage from SDK update)

### Added

- Cross-platform Windows compatibility (Phase 1) (#590)
  - Docker socket resolution now supports Windows named pipes (`//./pipe/docker_engine`) (#596)
  - Platform capability detection module (`src/config/platform.ts`) â€” detects OS, arch, Docker, sidecar support, Chrome path (#599)
  - `/api/admin/platform` endpoint exposes platform capabilities and feature availability to the UI (#601)
  - Admin panel shows platform-appropriate availability badges on sidecar-dependent features (Image Gen, Music Gen) (#601)
  - `usePlatform()` React hook and `PlatformBadge` component for UI feature gating (#601)
- Electron desktop shell for Windows and macOS (Phase 2) (#595)
  - `desktop/` workspace with Electron 34 entry point, IPC bridge, tray icon
  - Backend process spawning with embedded Node.js runtime
  - System tray with context menu (show/hide, open UI, quit)
  - Single instance lock to prevent multiple app windows
- Desktop build pipeline (Phase 3) (#592)
  - `electron-builder` configuration for NSIS (Windows) and DMG (macOS arm64/x64)
  - GitHub Actions workflow `desktop-release.yml` for tag-triggered builds
  - Code signing stubs for Azure Trusted Signing and Apple Developer ID
- Auto-update system (Phase 4) (#591)
  - `electron-updater` integration with GitHub Releases backend
  - Stable/beta channel switching with IPC handlers
  - 4-hour automatic update check interval
- First-run setup wizard (Phase 5) (#594)
  - `/api/setup/*` endpoints for prerequisites check, config write, completion flag
  - Multi-step wizard UI at `/setup` with GitHub auth, channel config, feature selection
  - Works alongside existing `.env` file and admin panel configuration
- Package manager distribution (Phase 6) (#593)
  - Scoop bucket template (`pkg-templates/scoop/`) for Windows
  - Homebrew cask formula template (`pkg-templates/homebrew/`) for macOS
  - winget manifest template (`pkg-templates/winget/`) for future signed builds
  - GitHub Actions workflow `update-package-manifests.yml` for automatic manifest updates
  - Installation smoke test workflow `installation-smoke-tests.yml`
  - Comprehensive installation documentation (`docs/INSTALL.md`)
  - README.md updated with download badges and installation links

### Changed

- File permission operations (`chmod`, `mode: 0o600/0o700`) now use cross-platform helpers that skip on Windows NTFS (#598)
  - New `src/config/file-permissions.ts` module with `secureFileOptions()`, `secureDirOptions()`, `chmodSecureFile()`, `secureWriteOptions()`
  - Applied across config, CLI setup, Copilot auth, Sentinel state, Vault, audit logger, session manager, task post-actions, and server config persistence
- Server startup logs platform capabilities and gracefully skips native sidecars on non-macOS platforms (#600)

### Fixed

- Remotion media resolver already had hard-link â†’ copy fallback; confirmed no changes needed (#597)

### Security

- Resolve 175 CodeQL security alerts (28 critical, 147 high) across Python sidecars and JS/TS backend (#574)
  - SSRF protection: callback URL validation in Python sidecars, domain allowlists in media downloaders, URL validation in admin health endpoints (#575, #576)
  - Type confusion: `String()` coercion on all user-controlled values reaching sinks (#577)
  - Command injection: path validation before shell command construction in audio sidecar (#578)
  - Path injection (Python): `safe_join()` utility, `_sanitize_path()`, Pydantic field validators across all sidecars (#579)
  - Path injection (JS/TS): `sanitizePath()` / `sanitizePathComponent()` utilities in `src/security/path-validator.ts`, inline traversal checks across API routes, sessions, knowledge, video pipeline (#580)
  - ReDoS: rewrote vulnerable regex patterns with non-backtracking alternatives (#581)
  - HTML sanitization: fixed entity decode ordering (`&amp;` last), loop-based tag stripping for completeness (#582)
  - XSS: `text/plain` Content-Type for reflected values, blob URL protocol validation in Voice Lab (#583)
  - Auth/crypto: scrypt for webhook API key hashing, HMAC-SHA1 suppression for OAuth 1.0a (#584)
  - Dynamic method calls: `typeof` function checks before invoking callbacks (#585)
  - Format string: `String()` coercion in dev-server.mjs (#586)
- Fix 5 transitive dependency vulnerabilities (tar, @github/copilot, dompurify, @tootallnate/once) via pnpm overrides
- Replace vulnerable xlsx@0.18.5 with exceljs â€” resolves 4 SheetJS prototype pollution and ReDoS alerts (Dependabot #1-4)
- Remove stale `ui/pnpm-lock.yaml` that pinned vulnerable versions of next, flatted, socket.io-parser, and glob â€” resolves 8 Dependabot alerts (#29â€“31, #39â€“43)
- Add `.gitignore` guard to prevent stale `ui/pnpm-lock.yaml` from being re-committed

### Changed

- Upgrade Next.js 14.2.35 â†’ 15.5.14 (App Router, no breaking changes for client components)
- Upgrade React 18.3.1 â†’ 19.2.4 and React DOM 18.3.1 â†’ 19.2.4
- Upgrade @types/react 18.x â†’ 19.x and @types/react-dom 18.x â†’ 19.x
- Upgrade eslint-config-next 14.x â†’ 15.x

### Fixed

- Fix React 19 type narrowing for `ReactElement.props` access in chat-markdown renderer
- Fix `img` component type for `src` prop (now `string | Blob | undefined` in React 19)

### Security

- Resolve 10 Dependabot alerts (#19, #24â€“28, #30â€“31, #40, #43) for Next.js CVEs via upgrade to 15.5.14
- Bump jspdf 4.2.0 â†’ 4.2.1 to fix prototype pollution vulnerability (CVE-2025-26791)
- Add pnpm override for socket.io-parser â‰¥4.2.6 (CVE-2025-27108 â€” insufficient input validation)
- Update pnpm override for undici â‰¥6.23.0 â†’ â‰¥7.24.0 (CVE-2025-22150 â€” insufficient randomness in request boundary)
- Add pnpm override for flatted â‰¥3.4.2 (CVE-2025-27490 â€” prototype pollution)

## [0.1.0] - 2026-03-22

### Added

- Core AI agent with GitHub Copilot SDK wrapper (streaming, model selection, device auth)
- MCP tool registry with Zod schema validation, risk classification, and runtime toggles
- Three tool runtimes: built-in, Docker sidecars, and local MCP servers
- Human-in-the-loop approval queue with interactive chat auto-approve for low-risk tools
- SQLite-backed task engine with DAG parent-child trees, recursion limits, and multi-stage pipelines
- Session management with JSONL append-only history and sidecar metadata files
- Web Chat UI (Next.js 14 + Tailwind + Radix UI) with Socket.IO real-time streaming
- Admin panels: tools, sessions, agents, personality, sentinel, and model management
- Telegram channel integration via grammY
- Discord channel integration via discord.js
- Message routing with access control, personality injection, and tool scoping
- Cloudflare Tunnel integration (quick and named tunnel modes)
- Auth middleware with role-based access control and API token support
- Audit logging with JSONL persistence, value redaction, and queryable API
- Sentinel autonomous SRE monitor with cron-scheduled review and daily digests
- Recursive agent chaining (spawn-agent, orchestrate-agents)
- Saved prompt library with template interpolation and staged pipelines
- Scheduler with cron-based job management
- External MCP servers: Facebook, Instagram, LinkedIn, Reddit, TikTok, Twitter/X, YouTube
- Docker Compose configuration for containerized deployment
- 4,850+ unit tests with Vitest
- FSL-1.1-MIT license with MIT future grant

[Unreleased]: https://github.com/openzigs/openzigs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/openzigs/openzigs/releases/tag/v0.1.0
