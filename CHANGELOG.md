# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
