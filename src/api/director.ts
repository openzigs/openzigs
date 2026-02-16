/**
 * Director Mode — REST API Router
 * Dedicated endpoints for the Director Mode wizard UI.
 *
 * Routes:
 *   GET  /templates                   — list available templates
 *   GET  /templates/:id               — get a single template
 *   POST /assets/search               — search assets across sources
 *   POST /assets/download             — download remote asset to local cache
 *   POST /assets/upload               — upload local file to asset library
 *   POST /files/upload                — upload browser-selected local file bytes
 *   GET  /assets/local                — list local library
 *   DELETE /assets/:id                — remove cached asset
 *   POST /produce                     — trigger video production (ingestion → LLM → manifest)
 *   POST /render                      — submit manifest to render queue
 *   GET  /jobs                        — list render jobs
 *   GET  /jobs/:id                    — get render job status
 *   POST /jobs/:id/abort              — abort a render job
 */

import { Router, raw } from "express";
import { logger } from "../logging/logger.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { VoiceService } from "../voice/voice-service.js";
import type { RenderOrchestrator } from "../video/render-orchestrator.js";

export interface DirectorRouterOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
  renderOrchestrator?: RenderOrchestrator;
  config: {
    enabled: boolean;
    outputDir: string;
    defaultTemplate: string;
    assets: {
      localLibraryPath: string;
      downloadCachePath: string;
      pixabayApiKey: string;
      jamendoClientId: string;
      pexelsApiKey: string;
    };
  };
}

export const createDirectorRouter = ({
  copilot,
  voiceService,
  renderOrchestrator,
  config,
}: DirectorRouterOptions): Router => {
  const router = Router();

  // Mutable runtime config (overlaid on top of file-based config)
  const runtimeConfig = {
    pixabayApiKey: config.assets.pixabayApiKey,
    jamendoClientId: config.assets.jamendoClientId,
    pexelsApiKey: config.assets.pexelsApiKey,
    defaultModel: "", // empty = use system default
  };

  /** Lazy singleton asset manager (hoisted so config PUT can reset it). */
  let assetManagerInstance: import("../video/assets/asset-manager.js").AssetManager | null = null;

  // ── Config ─────────────────────────────────────────────────

  /**
   * GET /config — return Director Mode configuration (safe subset).
   */
  router.get("/config", (_req, res) => {
    res.json({
      enabled: config.enabled,
      outputDir: config.outputDir,
      defaultTemplate: config.defaultTemplate,
      defaultModel: runtimeConfig.defaultModel,
      pixabayApiKey: runtimeConfig.pixabayApiKey ? "••••" + runtimeConfig.pixabayApiKey.slice(-4) : "",
      jamendoClientId: runtimeConfig.jamendoClientId ? "••••" + runtimeConfig.jamendoClientId.slice(-4) : "",
      pexelsApiKey: runtimeConfig.pexelsApiKey ? "••••" + runtimeConfig.pexelsApiKey.slice(-4) : "",
      pixabayConfigured: !!runtimeConfig.pixabayApiKey && !runtimeConfig.pixabayApiKey.startsWith("${"),
      jamendoConfigured: !!runtimeConfig.jamendoClientId && !runtimeConfig.jamendoClientId.startsWith("${"),
      pexelsConfigured: !!runtimeConfig.pexelsApiKey && !runtimeConfig.pexelsApiKey.startsWith("${"),
    });
  });

  /**
   * PUT /config — update Director Mode configuration.
   * Body: { pixabayApiKey?, jamendoClientId?, pexelsApiKey?, defaultModel? }
   */
  router.put("/config", (req, res) => {
    const { pixabayApiKey, jamendoClientId, pexelsApiKey, defaultModel } = req.body as {
      pixabayApiKey?: string;
      jamendoClientId?: string;
      pexelsApiKey?: string;
      defaultModel?: string;
    };

    if (pixabayApiKey !== undefined) {
      runtimeConfig.pixabayApiKey = pixabayApiKey;
      config.assets.pixabayApiKey = pixabayApiKey;
      // Reset asset manager so it picks up the new key
      assetManagerInstance = null;
    }
    if (jamendoClientId !== undefined) {
      runtimeConfig.jamendoClientId = jamendoClientId;
      config.assets.jamendoClientId = jamendoClientId;
      assetManagerInstance = null;
    }
    if (pexelsApiKey !== undefined) {
      runtimeConfig.pexelsApiKey = pexelsApiKey;
      config.assets.pexelsApiKey = pexelsApiKey;
      assetManagerInstance = null;
    }
    if (defaultModel !== undefined) {
      runtimeConfig.defaultModel = defaultModel;
    }

    logger.info("[Director API] Config updated");
    res.json({ success: true });
  });

  // ── Templates ──────────────────────────────────────────────

  /**
   * GET /templates — list all available video templates.
   */
  router.get("/templates", async (_req, res) => {
    try {
      const { createTemplateRegistry } = await import("../video/templates/template-registry.js");
      const registry = createTemplateRegistry();
      const templates = registry.getAll().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        aspectRatio: t.aspectRatio,
        defaultComposition: t.defaultComposition,
        defaultTransition: t.defaultTransition,
        defaultTransitionDuration: t.defaultTransitionDuration,
        captionsEnabled: t.captionsEnabled,
        defaultCaptionStyle: t.defaultCaptionStyle,
        tags: t.tags,
        titleCardBackground: t.titleCardBackground,
        fontFamily: t.fontFamily,
      }));
      res.json({ templates, defaultTemplate: config.defaultTemplate });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /templates failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /templates/:id — get a single template by ID.
   */
  router.get("/templates/:id", async (req, res) => {
    try {
      const { createTemplateRegistry } = await import("../video/templates/template-registry.js");
      const registry = createTemplateRegistry();
      const template = registry.get(req.params.id as import("../video/manifest/manifest-types.js").TemplateId);
      if (!template) {
        res.status(404).json({ error: `Template not found: ${req.params.id}` });
        return;
      }
      res.json(template);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Assets ─────────────────────────────────────────────────

  async function getAssetManager() {
    if (!assetManagerInstance) {
      const { AssetManager } = await import("../video/assets/asset-manager.js");
      assetManagerInstance = new AssetManager({
        localLibraryPath: config.assets.localLibraryPath,
        downloadCachePath: config.assets.downloadCachePath,
        pixabay: {
          enabled: !!runtimeConfig.pixabayApiKey && !runtimeConfig.pixabayApiKey.startsWith("${"),
          apiKey: runtimeConfig.pixabayApiKey,
        },
        jamendo: {
          enabled: !!runtimeConfig.jamendoClientId && !runtimeConfig.jamendoClientId.startsWith("${"),
          clientId: runtimeConfig.jamendoClientId,
        },
        pexels: {
          enabled: !!runtimeConfig.pexelsApiKey && !runtimeConfig.pexelsApiKey.startsWith("${"),
          apiKey: runtimeConfig.pexelsApiKey,
        },
      });
      await assetManagerInstance.initialize();
    }
    return assetManagerInstance;
  }

  /**
   * POST /assets/search — search for music & sound effects.
   * Body: { query, source?, type?, minDuration?, maxDuration?, page?, perPage? }
   */
  router.post("/assets/search", async (req, res) => {
    try {
      const { query, source, type, minDuration, maxDuration, page, perPage } = req.body as {
        query: string;
        source?: "local" | "pixabay" | "jamendo" | "pexels" | "all";
        type?: "music" | "sfx" | "image" | "video";
        minDuration?: number;
        maxDuration?: number;
        page?: number;
        perPage?: number;
      };

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const manager = await getAssetManager();
      const result = await manager.search({
        query,
        source: source ?? "all",
        type,
        minDuration,
        maxDuration,
        page: page ?? 1,
        perPage: perPage ?? 20,
      });

      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/search failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /assets/download — download a remote asset to local cache.
   * Body: { id, name, source, previewUrl, attribution? }
   */
  router.post("/assets/download", async (req, res) => {
    try {
      const { id, name, source, previewUrl, attribution } = req.body as {
        id: string;
        name: string;
        source: "pixabay" | "jamendo" | "pexels";
        previewUrl: string;
        attribution?: string;
      };

      if (!previewUrl || !source) {
        res.status(400).json({ error: "previewUrl and source are required" });
        return;
      }

      const manager = await getAssetManager();
      const assetType = source === "pexels" ? "image" as const : "music" as const;
      const result = await manager.download({
        id: id ?? name,
        name,
        source,
        previewUrl,
        attribution,
        type: assetType,
        filePath: "",
        duration: 0,
        tags: [],
        license: source === "pixabay" ? "Pixabay License" : source === "pexels" ? "Pexels License" : "Creative Commons",
      });

      res.json({ success: true, filePath: result.filePath, asset: result.asset });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/download failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /assets/local — list all local library assets.
   */
  router.get("/assets/local", async (_req, res) => {
    try {
      const manager = await getAssetManager();
      const assets = manager.getLocalAssets();
      res.json({ assets, total: assets.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /assets/upload — upload a local file to the asset library.
   * Body: { filePath, name?, type? }
   *
   * For security, this copies a file from a local absolute path
   * into the managed asset library (no multipart — files are already local).
   */
  router.post("/assets/upload", async (req, res) => {
    try {
      const { filePath: srcPath, name, type } = req.body as {
        filePath: string;
        name?: string;
        type?: "music" | "sfx" | "voiceover";
      };

      if (!srcPath || typeof srcPath !== "string") {
        res.status(400).json({ error: "filePath is required" });
        return;
      }

      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      // Resolve tilde
      const resolved = srcPath.startsWith("~")
        ? pathMod.join(osMod.homedir(), srcPath.slice(1))
        : pathMod.resolve(srcPath);

      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: `File not found: ${resolved}` });
        return;
      }

      // Copy to local library
      const fileName = name ?? pathMod.basename(resolved);
      const destDir = config.assets.localLibraryPath;
      await fs.promises.mkdir(destDir, { recursive: true });

      const destPath = pathMod.join(destDir, fileName);
      await fs.promises.copyFile(resolved, destPath);

      logger.info(`[Director API] Uploaded asset: ${fileName} → ${destPath}`);
      res.json({
        success: true,
        filePath: destPath,
        asset: {
          id: `upload-${Date.now()}`,
          name: fileName,
          source: "upload" as const,
          type: type ?? "music",
          filePath: destPath,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/upload failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /files/upload?kind=video|audio|script — upload raw file bytes.
   *
   * Headers:
   *   x-file-name: original filename (URL-encoded)
   *   x-file-type: mime type (optional)
   * Body:
   *   raw binary bytes
   */
  router.post("/files/upload", raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
    try {
      const kind = String(req.query.kind ?? "video");
      if (kind !== "video" && kind !== "audio" && kind !== "script") {
        res.status(400).json({ error: "kind must be one of: video, audio, script" });
        return;
      }

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "request body must contain file bytes" });
        return;
      }

      const fs = await import("node:fs/promises");
      const pathMod = await import("node:path");

      const rawNameHeader = req.header("x-file-name") ?? "upload.bin";
      const decodedName = (() => {
        try {
          return decodeURIComponent(rawNameHeader);
        } catch {
          return rawNameHeader;
        }
      })();

      const safeName = pathMod.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const fileName = safeName.length > 0 ? safeName : "upload.bin";
      const targetDir = kind === "audio"
        ? config.assets.localLibraryPath
        : pathMod.join(config.outputDir, "uploads", kind === "video" ? "videos" : "scripts");

      await fs.mkdir(targetDir, { recursive: true });

      const uniqueName = `${Date.now()}-${fileName}`;
      const filePath = pathMod.join(targetDir, uniqueName);
      await fs.writeFile(filePath, body);

      const mimeType = req.header("x-file-type") || "application/octet-stream";
      logger.info(`[Director API] Uploaded ${kind} file: ${filePath} (${body.length} bytes)`);

      res.json({
        success: true,
        kind,
        filePath,
        fileName: uniqueName,
        size: body.length,
        mimeType,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /files/upload failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /assets/:id — remove a cached asset.
   */
  router.delete("/assets/:id", async (req, res) => {
    try {
      const manager = await getAssetManager();
      const removed = await manager.remove(req.params.id);
      res.json({ success: removed });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Production (Ingestion → LLM → Manifest) ───────────────

  /**
   * POST /produce — trigger the single-shot production pipeline.
   * Body: { clips: string[], mode: "highlight" | "script", scriptPath?, musicTrackPath?, template?, model?, enableVisionAnalysis? }
   *
   * When enableVisionAnalysis is true (default), keyframe images are sent to a
   * vision model for rich scene descriptions. This significantly improves editing
   * quality but adds 1-5 minutes depending on the number of keyframes.
   */
  router.post("/produce", async (req, res) => {
    try {
      const { clips, mode, scriptPath, musicTrackPath, template, model, enableVisionAnalysis } = req.body as {
        clips: string[];
        mode: "highlight" | "script";
        scriptPath?: string;
        musicTrackPath?: string;
        template?: string;
        model?: string;
        enableVisionAnalysis?: boolean;
      };

      if (!clips || !Array.isArray(clips) || clips.length === 0) {
        res.status(400).json({ error: "clips array is required and must not be empty" });
        return;
      }
      if (!mode || (mode !== "highlight" && mode !== "script")) {
        res.status(400).json({ error: "mode must be 'highlight' or 'script'" });
        return;
      }

      const startTime = Date.now();
      const progressLog: Array<{ phase: string; message: string; timestamp: number }> = [];

      // Vision analysis is enabled by default
      const useVision = enableVisionAnalysis !== false;

      // Ingest clips (with optional vision analysis)
      const { ingest } = await import("../video/ingestion/index.js");
      const ingestionResult = await ingest({ clips, mode }, {
        copilot: useVision ? copilot : undefined,
        visionAnalysis: useVision ? {
          maxKeyframes: 30,
          delayMs: 2000,
          model: model || runtimeConfig.defaultModel || undefined,
        } : undefined,
        onProgress: (event) => {
          progressLog.push({
            phase: event.phase,
            message: event.message,
            timestamp: Date.now() - startTime,
          });
          logger.info(`[Director API] ${event.phase}: ${event.message}`);
        },
      });

      // Produce manifest
      const { ProducerService } = await import("../video/producer/producer-service.js");
      const producer = new ProducerService(copilot, voiceService);
      const resolvedMusicPath = musicTrackPath?.trim() || undefined;
      const result = await producer.produce({
        mode,
        contextPayload: ingestionResult.contextPayload,
        scriptPath,
        musicTrackPath: resolvedMusicPath,
        preferredTemplate: template,
        model: model || runtimeConfig.defaultModel || undefined,
        sourceClips: clips,
      });

      const elapsedMs = Date.now() - startTime;

      // Count effects and transitions for diagnostics
      const videoClipsInManifest = result.manifest.timeline.filter((e) => e.type === "video_clip");
      const transitionsInManifest = result.manifest.timeline.filter((e) => e.type === "transition");
      const clipsWithEffects = videoClipsInManifest.filter(
        (e) => e.type === "video_clip" && "effects" in e && Array.isArray(e.effects) && e.effects.length > 0,
      );
      const uniqueSources = new Set(
        videoClipsInManifest.map((e) => e.type === "video_clip" ? e.source : ""),
      );

      logger.info(
        `[Director API] Manifest stats: ${videoClipsInManifest.length} video clips from ${uniqueSources.size} source(s), ` +
        `${transitionsInManifest.length} transitions, ${clipsWithEffects.length} clips with effects`,
      );

      res.json({
        manifest: result.manifest,
        tokensUsed: result.tokensUsed,
        clipsProcessed: ingestionResult.clips.length,
        totalDuration: ingestionResult.clips.reduce((sum, c) => sum + c.duration, 0),
        visionAnalysisEnabled: useVision,
        processingTimeMs: elapsedMs,
        progressLog,
        diagnostics: {
          videoClipCount: videoClipsInManifest.length,
          transitionCount: transitionsInManifest.length,
          clipsWithEffects: clipsWithEffects.length,
          uniqueSourcesUsed: uniqueSources.size,
          totalSourcesProvided: clips.length,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /produce failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Render Jobs ────────────────────────────────────────────

  /**
   * POST /render — submit a manifest for rendering.
   * Body: { manifest: DirectorManifest, codec?, crf?, quality? }
   *
   * Quality presets:
   *   "draft"   — crf 32, fast encode
   *   "standard" — crf 23, balanced
   *   "high"    — crf 18, high quality
   *   "lossless" — crf 0, maximum quality
   */
  router.post("/render", async (req, res) => {
    try {
      if (!renderOrchestrator) {
        res.status(503).json({ error: "Render orchestrator is not available" });
        return;
      }

      const { manifest, codec, crf, quality } = req.body as {
        manifest: unknown;
        codec?: string;
        crf?: number;
        quality?: "draft" | "standard" | "high" | "lossless";
      };
      if (!manifest || typeof manifest !== "object") {
        res.status(400).json({ error: "manifest object is required" });
        return;
      }

      // Quality preset → crf mapping
      const qualityPresets: Record<string, number> = {
        draft: 32,
        standard: 23,
        high: 18,
        lossless: 0,
      };

      const resolvedCrf = crf ?? (quality ? qualityPresets[quality] : undefined);

      const jobId = await renderOrchestrator.submit({
        manifest: manifest as import("../video/manifest/manifest-types.js").DirectorManifest,
      });

      // Store quality metadata on the job for logging/display
      const job = renderOrchestrator.getJob(jobId);
      if (job) {
        (job as unknown as Record<string, unknown>).codec = codec ?? "h264";
        (job as unknown as Record<string, unknown>).crf = resolvedCrf ?? 23;
        (job as unknown as Record<string, unknown>).quality = quality ?? "standard";
      }

      res.json({ jobId, status: "queued", codec: codec ?? "h264", crf: resolvedCrf ?? 23 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /render failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /jobs — list all render jobs.
   */
  router.get("/jobs", (_req, res) => {
    if (!renderOrchestrator) {
      res.json({ jobs: [] });
      return;
    }
    const jobs = renderOrchestrator.listJobs().map((j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      projectTitle: j.manifest.projectTitle,
      templateId: j.manifest.templateId,
      outputPath: j.outputPath,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      durationSec: j.durationSec,
      fileSizeBytes: j.fileSizeBytes,
    }));
    res.json({ jobs });
  });

  /**
   * GET /jobs/:id — get render job details.
   */
  router.get("/jobs/:id", (req, res) => {
    if (!renderOrchestrator) {
      res.status(404).json({ error: "Render orchestrator not available" });
      return;
    }
    const job = renderOrchestrator.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${req.params.id}` });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      projectTitle: job.manifest.projectTitle,
      templateId: job.manifest.templateId,
      outputPath: job.outputPath,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      durationSec: job.durationSec,
      fileSizeBytes: job.fileSizeBytes,
    });
  });

  /**
   * POST /jobs/:id/abort — abort a render job.
   */
  router.post("/jobs/:id/abort", (req, res) => {
    if (!renderOrchestrator) {
      res.status(503).json({ error: "Render orchestrator not available" });
      return;
    }
    const aborted = renderOrchestrator.abort(req.params.id);
    res.json({ success: aborted });
  });

  return router;
};
