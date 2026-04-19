# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **LatentSync Lip Sync Sidecar** (#797):
  - **Lip Sync Sidecar Servers** (#798): FastAPI servers for MPS (port 5008, FP32) and CUDA (port 5010, FP16) with `/generate`, `/health`, `/unload-model`, `/model-status` endpoints
  - **Setup Scripts** (#799): `setup-lipsync-node.sh` for macOS MPS, `setup-cuda-sidecars.sh` and `start-cuda-sidecars.sh` for Windows/WSL CUDA
  - **Dispatch Routing** (#800): QueueMaster lip sync job dispatch with health-check polling, sidecar reconnection, and graceful degradation
  - **Memory Coordination** (#801): Sequential LTX ↔ LatentSync execution via `memoryTransitionActive` mutex, `ensureSidecarMemory()`, and `unloadWithRetry()` for M2 Pro shared-memory environments
  - **Talking Head Pipeline** (#802): Three-stage pipeline (TTS → Video → Lip Sync) with in-memory state machine, automatic output forwarding, and graceful degradation when sidecar is unavailable
  - **Gallery Studio Talking Head Mode** (#803): New "Talking Head" mode with speech text input, voice selector, video prompt, lip sync settings panel (model version, inference steps, guidance scale, DeepCache), and sidecar health indicator
  - **Configuration** (#804): `lipSync` config section with `enabled`, `networkNodeUrl`, `networkNodeToken`, `defaultModel`, `inferenceSteps`, `guidanceScale`, `enableDeepCache`, `maxDurationSec`, `modelIdleTimeoutSec`, `memoryLimitGB`
  - **cuda-ctl Commands** (#805): `cuda-ctl.sh lipsync {setup|start|stop|status|logs}` for managing the CUDA lip sync sidecar
  - **Documentation** (#806): Architecture and User Guide updated with LatentSync sidecar design, Talking Head pipeline, setup instructions, troubleshooting, and security notice

### Fixed

- LTX worker: garbled/snow video output caused by `LTX_USE_PREQUANT=1` in `.env` forcing broken AITRADER pre-quantized 4-bit weights instead of runtime quantization from the clean BF16 base model (`mlx-community/LTX-2-distilled-bf16`). The CharafChnioune fork auto-detects AITRADER repos and applies runtime quantization — `LTX_USE_PREQUANT` must not be set.
- LTX worker: added `sidecars/worker/.env.example` with documented env vars and a prominent warning against setting `LTX_USE_PREQUANT=1`.
- F5-TTS sidecar (`sidecars/audio/server_cuda.py`): replaced direct `os.path.realpath` on user-supplied `ref_audio_path` with the same split/`os.listdir` lookup pattern used by the lip sync sidecar, breaking taint flow into shell/path operations and resolving CodeQL alerts #327 (command-line-injection, critical) and #328/#330 (path-injection, high).
- Test suite: refreshed `VALID_VIDEO_DURATIONS`, `isValidVideoDuration`, and talking-head-pipeline `maxDurationSec` cap tests to match the extended `[4..32]` valid duration list and 32 s ceiling.
- Audio API tests: added missing `node:fs/promises` `readFile` mock that was causing `/audio/f5tts/profiles/:id/test` tests to return 502.
- UI lint: replaced unnecessary `\/` escapes in `ui/app/characters/page.tsx` regex character classes with `[/\\]`.

### Added

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
- Gallery Studio: pipeline selector dropdown — choose between Distilled, Dev, 2-Stage, and 2-Stage HQ pipelines (#783)
- Gallery Studio: audio generation toggle with ~30% time warning (#784)
- Gallery Studio: VAE tiling mode selector — Auto, None, Default, Aggressive, Conservative (#785)
- Gallery Studio: AI Enhance Prompt toggle wired to `enhance_prompt` payload field (#786)
- Gallery Studio: model selector dropdown populated from LTX model catalog with memory info (#787)
- Gallery Studio: preset picker with load/save — Quick Draft, Standard, High Quality built-ins plus custom presets (#788)
- Gallery Studio: duration selector (4s / 8s / 12s / 16s) replacing fixed 4s — shows segment count (#794)
- Multi-segment video generation: jobs with duration > 4s decompose into chained 4s segment sub-jobs (#790)
- Multi-segment video: segment chaining via `/last-frame` endpoint — each segment uses previous segment's last frame as init image (#791)
- Multi-segment video: ffmpeg concat stitching with 0.5s crossfade transitions between segments (#792)
- Multi-segment video: aggregate progress reporting with segment indicator ("Segment 2/4") (#793)
- Multi-segment video: audio post-processing runs on final stitched video only, not per-segment (#795)
- Worker sidecar: `POST /last-frame` endpoint — extracts last frame of a video as base64 PNG via ffmpeg (#789)
- LTX Video Engine v2: audio-video joint generation toggle (`audio` param) for synchronized sound (#760)
- LTX Video Engine v2: 2-stage pipeline support — `dev-two-stage` and `dev-two-stage-hq` pipeline types (#759)
- LTX Video Engine v2: model catalog with memory requirements and `GET /models` endpoint on sidecar (#761)
- LTX Video Engine v2: Gemma prompt enhancement via `enhance_prompt` parameter (#758)
- LTX Video Engine v2: configurable VAE tiling — `auto`, `none`, `default`, `aggressive`, `conservative` (#763)
- LTX Video Engine v2: image-to-video `image_strength` parameter (0.0–1.0) for conditioning control (#758)
- LTX Video Engine v2: `model_repo` override field for selecting different LTX model checkpoints (#758)
- **Airtable MCP Integration** — Full Airtable API client with per-base rate limiting and read/write MCP tools (#738, #743, #745, #746)
  - `AirtableClient` with automatic exponential backoff, non-retryable error detection, and `RateLimiter` (≤5 req/sec per base)
  - Read tools: `airtable-list-bases`, `airtable-list-tables`, `airtable-read-records`, `airtable-list-views`, `airtable-get-fields`
  - Write tools: `airtable-create-records`, `airtable-update-records`, `airtable-delete-records` (batch ≤10, typecast support)
  - Formula validation utility with cheatsheet for NL query translation (#744)
- **Google Sheets MCP Integration** — Sheets API v4 client with OAuth2 token refresh and read/write MCP tools (#738, #741, #747, #742)
  - `SheetsClient` with `SheetsRateLimiter` (≤60 req/min sliding window), A1 notation validation, and automatic OAuth2 token refresh
  - Read tools: `sheets-list-spreadsheets`, `sheets-read-range`, `sheets-get-metadata`
  - Write tools: `sheets-write-range`, `sheets-append-rows`, `sheets-create-spreadsheet`, `sheets-create-sheet`, `sheets-format-cells`
  - Column helper utilities (`columnToLetter`, `letterToColumn`) and formula cheatsheet (#744)
- **Data Output Helper** — shared utility for writing structured row data to Airtable/Sheets from any tool (#748)
  - `site-to-dataset` and `lead-extract` tools now accept optional `outputTo` parameter for direct Airtable/Sheets export
  - Graceful degradation: if export fails, text results are still returned
- **Integrations Admin Panel** — UI for configuring Airtable & Google Sheets credentials (#740)
  - `POST /api/admin/integrations/save` — save credentials to Secret Vault
  - `POST /api/admin/integrations/test` — test connectivity
  - `GET /api/admin/integrations/status` — check configuration status
  - `SecretVaultService.getByLabel()` helper for credential lookup by label

- **Firecrawl Search** — `search()` method on `FirecrawlClient` calling `/v2/search` (DuckDuckGo fallback, no API key needed) with SSRF filtering on returned URLs (#753)
  - `firecrawl-search` standalone MCP tool for explicit Firecrawl web search
  - `web-search` tool now falls back to Firecrawl search when Brave API key is unavailable and Firecrawl sidecar is running
- **Firecrawl Webhook Callbacks** — async crawl and batch scrape jobs now use webhook callbacks instead of polling when available (#751)
  - `POST /api/webhooks/firecrawl` endpoint with HMAC-SHA256 signature validation
  - Automatic fallback to polling when webhooks fail or are disabled
  - `firecrawl.useWebhooks` config option (default: `true`)
  - Rate limiting on webhook endpoint (100 req/min)
  - Graceful shutdown: pending webhook promises rejected on server stop

- **SCORM 1.2 Export** — export any presentation as a SCORM 1.2-compliant package for upload to any LMS (Moodle, Canvas, Blackboard, SCORM Cloud) (#688)
  - `generateManifest()` — generates valid `imsmanifest.xml` with ADL SCORM 1.2 schema, mastery score = 80 (#704)
  - `renderScormHtml()` — self-contained SCO HTML with embedded SCORM API adapter, chapter navigation, and quiz engine (#703)
  - `buildScormPackage()` — orchestrates manifest + HTML + ZIP bundling via `archiver`, returns `Buffer` (#702)
  - `POST /api/presentations/:id/scorm` — streams a zip attachment; validates admin access (#705)
  - Quiz score → SCORM mapping: `cmi.core.score.raw/min/max` and `lesson_status` (`passed` ≥80%, `failed` <80%, `completed` for no-quiz) (#705)
  - "Export SCORM" button in presenter player UI with loading spinner (#701)

- **VectorStore Abstraction Layer** — pluggable vector store backend for the RAG knowledge base (#691)
  - `VectorStore` interface in `src/knowledge/vector-store/types.ts` enabling LanceDB, Qdrant, Chroma, and other providers (#718)
  - `LanceDBVectorStore` adapter in `src/knowledge/vector-store/lancedb-vector-store.ts` — thin wrapper over `LanceDBStore` satisfying the interface (#715)
  - `createVectorStore(config)` factory in `src/knowledge/vector-store/factory.ts` — config-driven provider selection (#716)
  - `knowledge.vectorStore.provider` config key in `config/default.json` (default: `"lancedb"`) and Zod schema (#717)
  - `KnowledgeIngestionService` accepts optional `vectorStore?: VectorStore` via DI constructor (#716)
  - VectorStore interface + `LanceDBVectorStore` exported from `src/knowledge/index.ts` (#719)
  - ARCHITECTURE.md updated to document the abstraction layer (#720)

- **Firecrawl Self-Hosted Integration** — on-demand Docker sidecar for deep website crawling (#723)
  - `docker-compose.firecrawl.yml` with API, Playwright, and Redis services (#724)
  - `FirecrawlClient` class with SSRF protection, per-domain rate limiting (1 req/sec), auto-start/stop sidecar lifecycle, and injectable fetch for testing (#724)
  - `seo-site-audit` tool — full-site SEO audit via deep crawling: meta tags, headings, thin content, images, schema, internal linking (#725)
  - `deepCrawl` mode for `seo-gap-analysis` — Firecrawl-powered multi-page competitor content extraction (#726)
  - `ingest-website` tool — crawl a website and ingest all pages into the knowledge base with vector embeddings (#727)
  - `extractAnnotationsViaFirecrawl()` — Firecrawl Strategy 0 for Pinterest SEO annotation extraction on JS-rendered pages (#728)
  - `competitive-monitor` tool — SQLite-backed competitor tracking with add/remove/snapshot/report/list actions (#729)
  - Firecrawl Dashboard UI — dialog with Site Audit, Ingest, and Monitor actions (#730)
  - `web-extract` tool — LLM-powered structured data extraction from any web page with JSON schema or natural language prompt (#731)
  - `lead-extract` tool — automated contact and company extraction via site mapping and batch scraping (#731)
  - `price-monitor` tool — track prices with historical SQLite snapshots and change detection (#731)
  - `site-to-dataset` tool — crawl websites and produce structured datasets in markdown, JSONL, or CSV (#731)
  - Full Firecrawl action support: scroll, write, press, executeJavascript, PDF, scrape (#731)
  - Batch scrape (`batchScrape`) and enhanced map with search filtering (#731)
  - Crawl Dashboard expanded with Extract, Leads, Prices, and Dataset action panels (#731)
  - Firecrawl config section in `config/default.json` (`firecrawl.enabled`, `firecrawl.url`, `firecrawl.idleTimeoutMs`)

- **Visual Workflow Builder** (`/workflows`) — full-screen drag-and-drop canvas for composing multi-stage LLM pipelines (#687)
  - React Flow canvas with custom node types: Prompt Stage, Parallel Group, Post-Action, Condition (coming soon) (#706, #708)
  - Draggable node palette sidebar and node config panel for editing node properties (#707, #710)
  - Bidirectional graph serializer (`graphToStages`/`stagesToGraph`) with cycle detection and topological sort (#709)
  - Save/load workflows to the prompt library with `graph_layout` column for persisting visual layout (#711)
  - Workflow execution via task API with real-time Socket.IO status overlay on nodes (#712)
  - JSON import/export for workflow templates (#713)
  - "Workflows" link added to the Automation nav group (#714)
- **Social Analytics Dashboard** — enhanced analytics tab with rich charts and export (#689)
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
- Tray tooltip shows uptime and memory when backend is running (e.g., "OpenZigs — running (2h 15m, 120MB)") (#607)

### Changed

- `BackendManager.checkHealth()` now stores enriched health JSON (status, uptime, memoryMB) from the backend (#607)

### Changed

- Sentinel autonomous monitor is now **enabled by default** — new installations start with Sentinel active; set `sentinel.enabled: false` in config to disable (#217)

### Added

- RAG Knowledge Base health check integrated into Sentinel periodic checks — monitors DB accessibility, ingestion status, and queue depth (#218)
- New alert types: `rag-db-unreachable` (critical), `rag-ingestion-down` (warning), `rag-queue-depth` (warning) (#218)
- `ragQueueDepthThreshold` config option (default: 100) to control when Sentinel alerts on RAG ingestion backlog (#218)
- Knowledge Base Health section in Sentinel status markdown digest (#218)
- `isRunning` getter and `restart()` method on `KnowledgeIngestionService` (#218)

### Security

- Bumped `serialize-javascript` override from >=7.0.3 to >=7.0.5 (prototype pollution, moderate)
- Bumped `picomatch` override from >=2.3.2 to >=4.0.4 (ReDoS, moderate)
- Added `brace-expansion` override >=5.0.5 (ReDoS, moderate)
- Added scoped `express>path-to-regexp` override pinned to 0.1.13 (ReDoS in express@4, high)
- Added scoped `router>path-to-regexp` override >=8.4.0 (ReDoS via MCP SDK express@5 → router, high)
- Bumped `electron` from ^34.2.0 to ^35.7.5 (multiple Chromium CVEs, high)

### Changed

- Upgraded `@modelcontextprotocol/sdk` from v1.27.1 to v1.28.0 (latest v1 release) (#333)

### Added

- Windows named pipe Docker socket detection (`//./pipe/docker_engine`) for Docker Desktop on Windows (#598)
- Hard link → `fs.copyFileSync` fallback in Remotion media staging for cross-device/Windows compatibility (#597)
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
  - Session mode execution path in `TemplateService` — composes all agent goals into a single `CopilotWrapper.chat()` call with `enableSubagents: true` (#672)
  - `enableInSessionSubagents` flag on `ChatContext` for `spawn-agent` session mode awareness (#674)
  - Orchestration Mode radio selector in `TemplateExecuteModal` (Task/Session with descriptions) (#676)
  - Orchestration Mode selector on Scheduler prompt/pipeline job form (#675)
  - USER_GUIDE.md documentation for session orchestration mode (#671)
  - ARCHITECTURE.md documentation for session mode data flow and integration (#673)

### Fixed

- SEO extraction: JSON-LD `@graph` wrapper (Yoast/WordPress pattern) is now parsed — previously only root `@type` was detected (#665)
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
- In-session SDK subagent orchestration mode for `orchestrate-agents` tool — `mode: "session"` delegates to Copilot SDK subagents in a single chat call (~2 API calls vs ~5 for task mode) (#657)
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
- Fix picomatch ReDoS and method injection via `pnpm.overrides` — picomatch ≥ 2.3.2 (CVE-2026-33671, CVE-2026-33672, #635)
- Fix `@github/copilot` shell expansion vulnerability — update override to ≥ 0.0.423 and bump `@github/copilot-sdk` to 0.1.32 (CVE-2026-29783, #636)
- Patch `vscode-jsonrpc` to add ESM `exports` field (fixes test suite breakage from SDK update)

### Added

- Cross-platform Windows compatibility (Phase 1) (#590)
  - Docker socket resolution now supports Windows named pipes (`//./pipe/docker_engine`) (#596)
  - Platform capability detection module (`src/config/platform.ts`) — detects OS, arch, Docker, sidecar support, Chrome path (#599)
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

- Remotion media resolver already had hard-link → copy fallback; confirmed no changes needed (#597)

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
- Replace vulnerable xlsx@0.18.5 with exceljs — resolves 4 SheetJS prototype pollution and ReDoS alerts (Dependabot #1-4)
- Remove stale `ui/pnpm-lock.yaml` that pinned vulnerable versions of next, flatted, socket.io-parser, and glob — resolves 8 Dependabot alerts (#29–31, #39–43)
- Add `.gitignore` guard to prevent stale `ui/pnpm-lock.yaml` from being re-committed

### Changed

- Upgrade Next.js 14.2.35 → 15.5.14 (App Router, no breaking changes for client components)
- Upgrade React 18.3.1 → 19.2.4 and React DOM 18.3.1 → 19.2.4
- Upgrade @types/react 18.x → 19.x and @types/react-dom 18.x → 19.x
- Upgrade eslint-config-next 14.x → 15.x

### Fixed

- Fix React 19 type narrowing for `ReactElement.props` access in chat-markdown renderer
- Fix `img` component type for `src` prop (now `string | Blob | undefined` in React 19)

### Security

- Resolve 10 Dependabot alerts (#19, #24–28, #30–31, #40, #43) for Next.js CVEs via upgrade to 15.5.14
- Bump jspdf 4.2.0 → 4.2.1 to fix prototype pollution vulnerability (CVE-2025-26791)
- Add pnpm override for socket.io-parser ≥4.2.6 (CVE-2025-27108 — insufficient input validation)
- Update pnpm override for undici ≥6.23.0 → ≥7.24.0 (CVE-2025-22150 — insufficient randomness in request boundary)
- Add pnpm override for flatted ≥3.4.2 (CVE-2025-27490 — prototype pollution)

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
