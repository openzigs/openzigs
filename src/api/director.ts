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

import path from "node:path";
import { spawn } from "node:child_process";
import { Router, raw } from "express";
import { nanoid } from "nanoid";
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

  async function probeAudioDurationSeconds(filePath: string): Promise<number | null> {
    return await new Promise<number | null>((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ]);

      let stdout = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      proc.on("error", () => {
        resolve(null);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          resolve(null);
          return;
        }
        resolve(duration);
      });
    });
  }

  /**
   * Split text into sentence-level chunks for higher-quality GPT-SoVITS synthesis.
   * Short text (≤1 sentence) is returned as-is; longer text is split at sentence
   * boundaries so each chunk stays under ~200 characters. This avoids the quality
   * degradation GPT-SoVITS exhibits on long passages.
   */
  function splitIntoSentences(text: string): string[] {
    // Split on sentence-ending punctuation while keeping the delimiter attached
    const raw = text.match(/[^.!?]+[.!?]+[\s]*/g);
    if (!raw || raw.length <= 1) return [text.trim()];
    // Merge very short fragments (<30 chars) with the previous sentence
    const merged: string[] = [];
    for (const seg of raw) {
      const trimmed = seg.trim();
      if (!trimmed) continue;
      if (merged.length > 0 && trimmed.length < 30) {
        merged[merged.length - 1] += " " + trimmed;
      } else {
        merged.push(trimmed);
      }
    }
    return merged.length > 0 ? merged : [text.trim()];
  }

  /**
   * Concatenate multiple WAV files into one using ffmpeg's concat demuxer.
   * Returns the path to the combined output file.
   */
  async function concatWavFiles(wavPaths: string[], outputDir: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const listPath = path.join(outputDir, `concat-list-${nanoid(6)}.txt`);
    const outPath = path.join(outputDir, `openzigs-vo-concat-${nanoid(8)}.wav`);
    // Build ffmpeg concat file list
    const lines = wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listPath, lines.join("\n"), "utf-8");
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0",
        "-i", listPath,
        "-c:a", "pcm_s16le",
        outPath,
      ]);
      proc.on("error", reject);
      proc.on("close", async (code) => {
        // Clean up list file
        await fs.unlink(listPath).catch(() => {});
        if (code !== 0) reject(new Error(`ffmpeg concat exited with ${code}`));
        else resolve(outPath);
      });
    });
  }

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

      // Path traversal guard: only allow files under home directory or outputDir
      const homeDir = osMod.homedir();
      const allowedRoots = [homeDir, pathMod.resolve(config.outputDir)];
      const normalizedResolved = pathMod.resolve(resolved);
      if (!allowedRoots.some((root) => normalizedResolved.startsWith(root + pathMod.sep) || normalizedResolved === root)) {
        res.status(403).json({ error: "Access denied: file path is outside allowed directories" });
        return;
      }

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
          id: `upload-${nanoid()}`,
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

  // ── Visual Injection (Issue #270 / SI-2) ──────────────────────────────────

  /**
   * POST /files/upload-asset?kind=image|video — upload a visual asset for overlay.
   *
   * Headers:
   *   x-file-name: <filename> (URL-encoded)
   * Body: raw binary bytes
   *
   * Stores the asset in ~/.openzigs/director/uploads/visual/ and returns the path.
   */
  router.post("/files/upload-asset", raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
    try {
      const kind = String(req.query.kind ?? "image");
      if (kind !== "image" && kind !== "video") {
        res.status(400).json({ error: "kind must be 'image' or 'video'" });
        return;
      }

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "request body must contain file bytes" });
        return;
      }

      const fs = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      const rawName = req.header("x-file-name") ?? "asset.bin";
      let decodedName: string;
      try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
      const safeName = pathMod.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const fileName = safeName || "asset.bin";
      const uniqueName = `${Date.now()}-${fileName}`;

      const targetDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "uploads", "visual");
      await fs.mkdir(targetDir, { recursive: true });
      const filePath = pathMod.join(targetDir, uniqueName);
      await fs.writeFile(filePath, body);

      logger.info(`[Director API] Uploaded ${kind} overlay asset: ${filePath} (${body.length} bytes)`);
      res.json({ success: true, kind, filePath, fileName: uniqueName, size: body.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /files/upload-asset failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /assets/placement — use the LLM to determine optimal overlay timestamps
   * for a given set of visual assets given a narration script.
   *
   * Body: {
   *   script: string,                         — narration text
   *   assets: Array<{ id, path, description }>, — visual assets to place
   *   videoDurationSec: number,               — total video duration
   *   model?: string                          — LLM model override
   * }
   *
   * Returns: Array<AssetPlacement> — timestamp-annotated placement instructions
   */
  router.post("/assets/placement", async (req, res) => {
    try {
      const { script, assets, videoDurationSec, model } = req.body as {
        script?: string;
        assets?: Array<{ id: string; path: string; description?: string }>;
        videoDurationSec?: number;
        model?: string;
      };

      if (!script || typeof script !== "string" || script.trim().length === 0) {
        res.status(400).json({ error: "script is required" });
        return;
      }
      if (!assets || !Array.isArray(assets) || assets.length === 0) {
        res.status(400).json({ error: "assets array is required and must not be empty" });
        return;
      }
      if (typeof videoDurationSec !== "number" || videoDurationSec <= 0) {
        res.status(400).json({ error: "videoDurationSec must be a positive number" });
        return;
      }
      if (assets.length > 20) {
        res.status(400).json({ error: "Maximum 20 assets per placement request" });
        return;
      }

      const assetList = assets
        .map((a, i) => `  ${i + 1}. ID: ${a.id} | Description: ${a.description ?? path.basename(a.path)}`)
        .join("\n");

      const placementPrompt = `You are a video editor's assistant. Given the narration script and list of visual assets below, determine the optimal timestamps at which each asset should appear as an overlay in the video.

VIDEO DURATION: ${videoDurationSec} seconds

NARRATION SCRIPT:
${script.slice(0, 3000)}

VISUAL ASSETS:
${assetList}

For each asset, provide:
- startTimeSec: when it should appear (seconds from start)
- endTimeSec: when it should disappear (must be ≤ ${videoDurationSec})
- position: one of: top-left, top-center, top-right, center, bottom-left, bottom-center, bottom-right
- scale: 0.1–1.0 (as fraction of video width)

Respond with ONLY a valid JSON array. No explanation. Example:
[{"id":"asset1","startTimeSec":2,"endTimeSec":8,"position":"top-right","scale":0.25}]`;

      const resolvedModel = model || runtimeConfig.defaultModel || undefined;
      const stream = copilot.chat(placementPrompt, {
        tools: [],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const responseText = chunks.join("");
      let placements: unknown[];
      try {
        // Strip any markdown code fences from the LLM response
        const rawJson = responseText.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
        const parsed: unknown = JSON.parse(rawJson);
        if (!Array.isArray(parsed)) throw new Error("expected array");
        placements = parsed;
      } catch {
        logger.warn("[Director API] LLM placement response was not valid JSON — returning raw");
        res.json({ raw: responseText, placements: [] });
        return;
      }

      logger.info(`[Director API] Generated ${placements.length} asset placements via LLM`);
      res.json({ placements });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/placement failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /assets/overlay — composite visual assets onto a background video.
   *
   * Body: {
   *   backgroundPath: string,    — absolute path to the source video
   *   outputPath: string,        — absolute path for the output video
   *   placements: AssetPlacement[]
   * }
   */
  router.post("/assets/overlay", async (req, res) => {
    try {
      const { backgroundPath, outputPath: requestedOutput, placements } = req.body as {
        backgroundPath?: string;
        outputPath?: string;
        placements?: unknown[];
      };

      if (!backgroundPath || typeof backgroundPath !== "string") {
        res.status(400).json({ error: "backgroundPath is required" });
        return;
      }
      if (!placements || !Array.isArray(placements) || placements.length === 0) {
        res.status(400).json({ error: "placements array is required and must not be empty" });
        return;
      }

      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      // Default output path if not specified
      const outputPath = requestedOutput
        || pathMod.join(osMod.homedir(), ".openzigs", "director", "uploads", "overlay", `${Date.now()}-overlay.mp4`);

      const { overlayAssets } = await import("../video/asset-overlay.js");
      const result = await overlayAssets({
        backgroundPath,
        placements: placements as import("../video/asset-overlay.js").AssetPlacement[],
        outputPath,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/overlay failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /files/:id — serve a previously uploaded file by filename basename.
   * Only serves files from the known upload directories.
   */
  router.get("/files/:fileName", async (req, res) => {
    try {
      const osMod = await import("node:os");
      const pathMod = await import("node:path");
      const fsMod = await import("node:fs");

      const fileName = pathMod.basename(req.params.fileName); // strip traversal
      const searchDirs = [
        pathMod.join(osMod.homedir(), ".openzigs", "director", "uploads", "visual"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "uploads", "videos"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "uploads", "overlay"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "ref-audio"),
      ];

      let found: string | null = null;
      for (const dir of searchDirs) {
        const candidate = pathMod.join(dir, fileName);
        if (fsMod.existsSync(candidate)) {
          found = candidate;
          break;
        }
      }

      if (!found) {
        res.status(404).json({ error: `File not found: ${fileName}` });
        return;
      }

      res.sendFile(found);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
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
   * Body (highlight/script): { clips: string[], mode: "highlight" | "script", scriptPath?, musicTrackPath?, template?, model?, enableVisionAnalysis? }
   * Body (presentation):     { mode: "presentation", inputFile: string, sourceType?: "text"|"markdown", topic?: string, musicTrackPath?, template?, model?, imageProvider?, imageModel?, slideStyle?, assetsOnlyMode? }
   *
   * When enableVisionAnalysis is true (default), keyframe images are sent to a
   * vision model for rich scene descriptions. This significantly improves editing
   * quality but adds 1-5 minutes depending on the number of keyframes.
   */
  router.post("/produce", async (req, res) => {
    try {
      const { clips, mode, scriptPath, musicTrackPath, template, model, enableVisionAnalysis, inputFile, sourceType, topic, imageProvider, imageModel, slideStyle, assetsOnlyMode, quizEnabled, visualAssets } = req.body as {
        clips?: string[];
        mode: "highlight" | "script" | "presentation";
        scriptPath?: string;
        musicTrackPath?: string;
        template?: string;
        model?: string;
        enableVisionAnalysis?: boolean;
        inputFile?: string;
        sourceType?: "text" | "markdown";
        topic?: string;
        imageProvider?: "cloud" | "local" | "auto";
        imageModel?: "flux" | "sdxl-turbo";
        slideStyle?: boolean;
        assetsOnlyMode?: boolean;
        quizEnabled?: boolean;
        visualAssets?: Array<{
          path: string;
          description: string;
          type: "image" | "video";
          placement?: {
            startTimeSec: number;
            endTimeSec: number;
            position: string;
            scale: number;
          } | null;
        }>;
      };

      if (!mode || !["highlight", "script", "presentation"].includes(mode)) {
        res.status(400).json({ error: "mode must be 'highlight', 'script', or 'presentation'" });
        return;
      }

      // ── Presentation mode: document → storyboard → images → TTS → manifest ──
      if (mode === "presentation") {
        if (!inputFile) {
          res.status(400).json({ error: "'inputFile' is required for presentation mode" });
          return;
        }

        const startTime = Date.now();

        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const os = await import("node:os");
        const { StoryboardEngine } = await import("../video/generators/storyboard-engine.js");
        const { ImageGenService } = await import("../video/generators/image-gen-service.js");
        const { nanoid } = await import("nanoid");

        // Step A: Ingest the text document
        let rawText: string;
        try {
          rawText = await fs.readFile(inputFile, "utf-8");
        } catch (readErr) {
          const readMsg = readErr instanceof Error ? readErr.message : String(readErr);
          res.status(400).json({ error: `Failed to read input file: ${readMsg}` });
          return;
        }

        if (sourceType === "markdown" || inputFile.endsWith(".md")) {
          rawText = rawText.replace(/```[\s\S]*?```/g, "[code block removed]");
        }

        logger.info(`[Director API] Presentation mode: read ${rawText.length} chars from ${inputFile}`);

        // Step B: Generate storyboard via LLM
        const storyboardEngine = new StoryboardEngine(copilot);
        const storyboardOptions: import("../video/generators/storyboard-engine.js").StoryboardOptions = {};
        if (topic) {
          storyboardOptions.styleHint = topic;
        }
        const resolvedModel = model || runtimeConfig.defaultModel || undefined;
        if (resolvedModel) {
          storyboardOptions.model = resolvedModel;
        }
        // Pass visual asset descriptions so the LLM can weave them into narration
        if (visualAssets && visualAssets.length > 0) {
          storyboardOptions.visualAssets = visualAssets
            .filter((a: { description?: string }) => a.description?.trim())
            .map((a: { description: string; type?: string }) => ({
              description: a.description,
              type: (a.type === "video" ? "video" : "image") as "image" | "video",
            }));
        }
        if (slideStyle) {
          storyboardOptions.slideStyle = true;
        }
        if (assetsOnlyMode && visualAssets && visualAssets.length > 0) {
          storyboardOptions.assetsOnlyMode = true;
        }
        const storyboard = await storyboardEngine.generate(rawText, storyboardOptions);

        logger.info(`[Director API] Storyboard generated: "${storyboard.title}" with ${storyboard.scenes.length} scenes`);

        // Step C: Generate images for each scene
        // Generate at ~model-native resolution (NOT output resolution).
        // Diffusion models (SDXL Turbo, Flux, etc.) are trained on specific
        // resolutions; requesting 1920x1080 produces degenerate outputs where
        // the model can't differentiate prompts. The Remotion KenBurns component
        // uses object-fit:cover to scale any source image to fill the frame.
        //
        // Images are stored in ~/.openzigs/director/images/ (persistent) rather
        // than /tmp/ — macOS aggressively purges /tmp/ which caused images to
        // vanish between the produce and render steps.
        const imageOutputDir = path.join(os.homedir(), ".openzigs", "director", "images");
        const imageService = new ImageGenService({ outputDir: imageOutputDir });
        await imageService.initialize();

        const resolvedImageProvider = imageProvider ?? "auto";
        logger.info(`[Director API] Image provider: ${resolvedImageProvider}${imageModel ? `, model: ${imageModel}` : ""}`);

        // Assets-only mode: middle scenes use uploaded assets; only intro (index 0) and
        // outro (last scene) are AI-generated.
        const isAssetsOnlyMode = !!assetsOnlyMode && !!visualAssets && visualAssets.length > 0;
        const lastSceneIndex = storyboard.scenes.length - 1;

        // Query sidecar for recommended resolution (falls back to 1024x576)
        let imageWidth = 1024;
        let imageHeight = 576;
        try {
          const sidecarHealth = await imageService.getRecommendedResolution();
          if (sidecarHealth) {
            imageWidth = sidecarHealth.width;
            imageHeight = sidecarHealth.height;
          }
        } catch {
          // Use defaults if sidecar health check fails
        }
        logger.info(`[Director API] Image generation resolution: ${imageWidth}x${imageHeight}`);

        const fps = 30;
        const templateId = (template as "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo") ?? "Minimalist";

        const timeline: Array<import("../video/manifest/manifest-types.js").ImageSceneEntry | import("../video/manifest/manifest-types.js").TitleCardEntry | import("../video/manifest/manifest-types.js").TransitionEntry | import("../video/manifest/manifest-types.js").OverlayEntry> = [];
        const sceneTiming: Array<{ index: number; startTimeSec: number; endTimeSec: number; voiceover: string }> = [];
        let currentFrame = 0;
        let skippedScenes = 0;
        // Base seed for per-scene variation — ensures each scene produces a
        // visually distinct image even when style anchors are shared.
        const baseSeed = Date.now() % 100_000;

        // Step C.1: Detect GPT-SoVITS voice profile for presentation voiceover
        // When the audio sidecar has Engine B (GPT-SoVITS) active, we synthesize
        // voiceover directly via the sidecar's /tts endpoint with the user's
        // voice profile parameters, bypassing VoiceService (which only knows Kokoro).
        interface SovitsProfileParams {
          ref_audio_path: string;
          ref_text: string;
          language: string;
          top_p: number;
          temperature: number;
          text_split_method: string;
          speed_factor: number;
          repetition_penalty: number;
          top_k: number;
          sample_steps: number;
        }
        let sovitsProfile: SovitsProfileParams | null = null;
        let sidecarBaseUrl = "";
        let useSovitsVoice = false;

        if (voiceService) {
          sidecarBaseUrl = voiceService.getSidecarUrl();
          try {
            const healthResp = await fetch(`${sidecarBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            if (healthResp.ok) {
              const health = await healthResp.json() as { active_engine?: string };
              if (health.active_engine === "sovits") {
                // Load the first available voice profile from the DB
                const { getDatabase } = await import("../productivity/database.js");
                const db = getDatabase();
                const profile = db.prepare(
                  `SELECT ref_audio_path, ref_text, language, top_p, temperature,
                          text_split_method, speed_factor, repetition_penalty, top_k, sample_steps
                   FROM voice_profiles ORDER BY updated_at DESC LIMIT 1`,
                ).get() as SovitsProfileParams | undefined;
                if (profile && profile.ref_audio_path) {
                  sovitsProfile = profile;
                  useSovitsVoice = true;
                  logger.info(`[Director API] GPT-SoVITS voice detected — using profile ref: ${profile.ref_audio_path}`);
                }
              }
            }
          } catch {
            // Sidecar not reachable; fall back to VoiceService
          }
        }

        for (const scene of storyboard.scenes) {
          // ── Step C.2a: Resolve the image path for this scene ──────────────────
          // Assets-only mode: middle scenes use uploaded visual assets directly;
          // only the intro (index 0) and outro (last) scenes are AI-generated.
          // Normal mode: every scene is AI-generated.
          let sceneImageFilePath: string;

          if (isAssetsOnlyMode && scene.index > 0 && scene.index < lastSceneIndex) {
            const assetIndex = (scene.index - 1) % visualAssets!.length;
            sceneImageFilePath = visualAssets![assetIndex].path;
            logger.info(
              `[Director API] Assets-only: scene ${scene.index + 1}/${storyboard.scenes.length} → ${sceneImageFilePath}`,
            );
          } else {
            // Throttle cloud image requests to stay within Vertex AI QPM limits.
            if (resolvedImageProvider !== "local" && scene.index > 0) {
              await new Promise(r => setTimeout(r, 15_000));
            }

            logger.info(
              `[Director API] Generating image ${scene.index + 1}/${storyboard.scenes.length}: ` +
              `"${scene.rawImageDescription.substring(0, 60)}..."`,
            );

            let imageResult: import("../video/generators/image-gen-service.js").ImageGenResult;
            try {
              imageResult = await imageService.generateImage(scene.imagePrompt, {
                provider: resolvedImageProvider,
                localModel: imageModel,
                width: imageWidth,
                height: imageHeight,
                seed: baseSeed + scene.index * 1000,
              });
            } catch (imgErr) {
              const imgMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
              logger.error(`[Director API] Image generation failed for scene ${scene.index}: ${imgMsg}`);
              skippedScenes++;
              continue;
            }
            sceneImageFilePath = imageResult.filePath;
          }

          // ── Step C.2b: Generate per-scene voiceover ───────────────────────────
          let sceneVoiceoverPath: string | undefined;
          if (useSovitsVoice && sovitsProfile && scene.voiceover) {
            // Synthesize with GPT-SoVITS via sentence-level chunking for
            // higher quality. Long text degrades SoVITS output; splitting
            // into sentences and stitching produces cleaner pronunciation.
            try {
              const sentences = splitIntoSentences(scene.voiceover);
              const chunkPaths: string[] = [];

              for (const sentence of sentences) {
                const ttsResp = await fetch(`${sidecarBaseUrl}/tts`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text: sentence,
                    ref_audio_path: sovitsProfile.ref_audio_path,
                    ref_text: sovitsProfile.ref_text,
                    ref_language: sovitsProfile.language,
                    top_p: sovitsProfile.top_p,
                    temperature: sovitsProfile.temperature,
                    text_split_method: sovitsProfile.text_split_method,
                    speed_factor: sovitsProfile.speed_factor,
                    repetition_penalty: sovitsProfile.repetition_penalty,
                    top_k: sovitsProfile.top_k,
                    sample_steps: sovitsProfile.sample_steps,
                    fragment_interval: 0.25,
                    parallel_infer: true,
                    split_bucket: true,
                    seed: -1,
                  }),
                  signal: AbortSignal.timeout(120_000),
                });
                if (ttsResp.ok) {
                  const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
                  const chunkPath = path.join(imageOutputDir, `openzigs-vo-chunk-${nanoid(8)}.wav`);
                  await fs.writeFile(chunkPath, audioBuffer);
                  chunkPaths.push(chunkPath);
                } else {
                  const errText = await ttsResp.text().catch(() => "");
                  logger.warn(`[Director API] SoVITS chunk failed (${ttsResp.status}): ${errText.substring(0, 200)}`);
                }
              }

              if (chunkPaths.length > 0) {
                if (chunkPaths.length === 1) {
                  sceneVoiceoverPath = chunkPaths[0];
                } else {
                  // Stitch sentence chunks into a single WAV
                  sceneVoiceoverPath = await concatWavFiles(chunkPaths, imageOutputDir);
                  // Clean up individual chunks
                  for (const cp of chunkPaths) {
                    await fs.unlink(cp).catch(() => {});
                  }
                }
                logger.info(`[Director API] SoVITS voiceover for scene ${scene.index}: ${sentences.length} sentence(s) stitched`);
              }
            } catch (sovitsErr) {
              const msg = sovitsErr instanceof Error ? sovitsErr.message : String(sovitsErr);
              logger.warn(`[Director API] SoVITS voiceover failed for scene ${scene.index}: ${msg}`);
            }
          } else if (voiceService && scene.voiceover) {
            // Fall back to VoiceService (Kokoro or Google Cloud TTS)
            try {
              if (!voiceService.isReady()) {
                await voiceService.initialize();
              }
              if (voiceService.isReady()) {
                const ttsResult = await voiceService.synthesize(scene.voiceover);
                const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.mp3`);
                await fs.writeFile(voPath, ttsResult.audio);
                sceneVoiceoverPath = voPath;
              }
            } catch {
              // TTS failure is non-fatal for scene processing
            }
          }

          let sceneDurationSec = scene.durationEstimate;
          if (sceneVoiceoverPath) {
            const measuredDuration = await probeAudioDurationSeconds(sceneVoiceoverPath);
            if (measuredDuration && measuredDuration > 0) {
              // Add a small tail to avoid abrupt cutoffs at sentence ends.
              sceneDurationSec = Math.max(measuredDuration + 0.35, 2);
            }
          }

          const durationInFrames = Math.max(Math.round(sceneDurationSec * fps), fps);
          // ── Chapter title card: inject before the scene's image when a new chapter starts ──
          if (scene.chapterTitle) {
            const CHAPTER_CARD_DURATION = 90; // 3 seconds at 30fps

            // Crossfade into the chapter title card (if not the very first timeline entry)
            if (timeline.length > 0) {
              timeline.push({
                type: "transition",
                style: "crossfade",
                duration: 15,
                startAtFrame: currentFrame,
              });
            }

            // Try to generate a background image for the separator card.
            // A thematic abstract image makes the chapter break visually compelling.
            // Non-fatal: falls back to a solid colour if generation fails.
            let separatorBackground: string | undefined;
            try {
              const separatorPrompt =
                `${storyboard.styleAnchor}. Abstract background for chapter separator card, ` +
                `no text, atmospheric, thematic, high quality, cinematic`;
              const separatorResult = await imageService.generateImage(separatorPrompt, {
                provider: resolvedImageProvider,
                localModel: imageModel,
                width: imageWidth,
                height: imageHeight,
                seed: baseSeed + scene.index * 1000 + 500,
              });
              separatorBackground = separatorResult.filePath;
            } catch {
              // Fallback: solid dark background (rendered by TitleCard component)
            }

            timeline.push({
              type: "title_card",
              title: scene.chapterTitle,
              background: separatorBackground,
              startAtFrame: currentFrame,
              duration: CHAPTER_CARD_DURATION,
              animation: "fade",
            });
            currentFrame += CHAPTER_CARD_DURATION;
          }

          // sceneStartFrame marks where the image_scene begins (after any title card)
          const sceneStartFrame = currentFrame;

          // Add crossfade transition between scenes (not before the first)
          if (timeline.length > 0) {
            const transitionDuration = Math.min(15, durationInFrames);
            timeline.push({
              type: "transition",
              style: "crossfade",
              duration: transitionDuration,
              startAtFrame: currentFrame,
            });
          }

          timeline.push({
            type: "image_scene",
            src: sceneImageFilePath,
            startAtFrame: currentFrame,
            duration: durationInFrames,
            voiceover: sceneVoiceoverPath,
            voiceoverVolume: 1.0,
            kenBurns: {
              scaleFrom: 1.0,
              scaleTo: 1.15,
              translateXFrom: 0,
              translateXTo: scene.index % 2 === 0 ? -10 : 10,
              translateYFrom: 0,
              translateYTo: -5,
            },
          });

          currentFrame += durationInFrames;
          sceneTiming.push({
            index: scene.index,
            startTimeSec: sceneStartFrame / fps,
            endTimeSec: currentFrame / fps,
            voiceover: scene.voiceover,
          });
        }

        // Step D: Construct the DirectorManifest
        const resolvedMusicPath = musicTrackPath?.trim() || undefined;
        const manifest: import("../video/manifest/manifest-types.js").DirectorManifest = {
          projectTitle: storyboard.title,
          templateId,
          composition: { width: 1920, height: 1080, fps },
          audioLayer: {
            music: resolvedMusicPath ? {
              track: resolvedMusicPath,
              volume: 0.08,
              ducking: true,
              fadeInFrames: 30,
              fadeOutFrames: 30,
              loop: true,
            } : null,
            voiceover: null,
          },
          timeline,
          metadata: {
            generatedAt: new Date().toISOString(),
            llmModel: resolvedModel ?? "copilot",
            llmTokensUsed: storyboard.tokensUsed,
            productionMode: "presentation",
            presenterQuizEnabled: !!quizEnabled,
            sourceClips: [],
            estimatedRenderTime: currentFrame / fps,
          },
        };

        // Step E: Recompute visual asset placements from final narration + measured scene timing,
        // then inject overlays into the timeline.
        if (visualAssets && visualAssets.length > 0) {
          const totalDurationSec = currentFrame / fps;
          let computedPlacements: Array<{
            id: string;
            startTimeSec: number;
            endTimeSec: number;
            position: string;
            scale: number;
          }> = [];

          try {
            const sceneTimelineText = sceneTiming
              .map((scene) => {
                const voice = scene.voiceover.replace(/\s+/g, " ").trim();
                return `- scene ${scene.index + 1}: ${scene.startTimeSec.toFixed(2)}s → ${scene.endTimeSec.toFixed(2)}s | ${voice}`;
              })
              .join("\n");
            const assetListText = visualAssets
              .map((asset, index) => {
                const description = (asset.description || path.basename(asset.path)).replace(/\s+/g, " ").trim();
                return `- id:${index} type:${asset.type} description:${description}`;
              })
              .join("\n");

            const placementPrompt = `You are placing visual overlays for a narrated video.

FINAL VIDEO DURATION: ${totalDurationSec.toFixed(2)} seconds

SCENE TIMELINE (already aligned to actual TTS audio durations):
${sceneTimelineText}

VISUAL ASSETS:
${assetListText}

Place each asset at the most semantically relevant moment in the narration.
For each asset, return:
- id (asset id)
- startTimeSec (seconds from 0)
- endTimeSec (must be > startTimeSec and <= ${totalDurationSec.toFixed(2)})
- position (top-left|top-center|top-right|center|bottom-left|bottom-center|bottom-right)
- scale (0.1 to 1.0)

Respond with ONLY a valid JSON array. No markdown, no explanation.`;

            const placementStream = copilot.chat(placementPrompt, {
              tools: [],
              ...(resolvedModel ? { model: resolvedModel } : {}),
            });
            const placementChunks: string[] = [];
            for await (const chunk of placementStream) {
              placementChunks.push(chunk);
            }

            const rawPlacementText = placementChunks.join("");
            const rawPlacementJson = rawPlacementText.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
            const parsed = JSON.parse(rawPlacementJson) as unknown;
            if (Array.isArray(parsed)) {
              computedPlacements = parsed
                .map((entry) => {
                  if (!entry || typeof entry !== "object") return null;
                  const raw = entry as Record<string, unknown>;
                  const id = String(raw.id ?? "");
                  const startTimeSec = Number(raw.startTimeSec);
                  const endTimeSec = Number(raw.endTimeSec);
                  const position = String(raw.position ?? "bottom-right");
                  const scale = Number(raw.scale);
                  if (!id || !Number.isFinite(startTimeSec) || !Number.isFinite(endTimeSec) || endTimeSec <= startTimeSec) {
                    return null;
                  }
                  return {
                    id,
                    startTimeSec,
                    endTimeSec,
                    position,
                    scale: Number.isFinite(scale) ? scale : 0.3,
                  };
                })
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            }
          } catch (placementErr) {
            const msg = placementErr instanceof Error ? placementErr.message : String(placementErr);
            logger.warn(`[Director API] Speech-aligned placement generation failed: ${msg}`);
          }

          if (computedPlacements.length === 0) {
            const sceneWindows = sceneTiming.length > 0
              ? sceneTiming
              : [{ index: 0, startTimeSec: 0, endTimeSec: Math.max(totalDurationSec, 3), voiceover: "" }];
            const fallbackWindowSec = 4;

            computedPlacements = visualAssets.map((asset, index) => {
              const scene = sceneWindows[Math.min(index, sceneWindows.length - 1)]!;
              const spanSec = Math.max(scene.endTimeSec - scene.startTimeSec, 1);
              const desiredDuration = Math.min(fallbackWindowSec, spanSec);
              const startTimeSec = scene.startTimeSec;
              const endTimeSec = Math.min(scene.endTimeSec, startTimeSec + desiredDuration);

              return {
                id: String(index),
                startTimeSec,
                endTimeSec,
                position: asset.placement?.position ?? "bottom-right",
                scale: asset.placement?.scale ?? 0.3,
              };
            });

            logger.info(`[Director API] Using deterministic fallback placement for ${computedPlacements.length} visual asset(s)`);
          }

          const placementById = new Map(computedPlacements.map((placement) => [placement.id, placement]));
          const validPositions = new Set(["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"]);
          const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

          let overlaysInjected = 0;
          for (const [index, asset] of visualAssets.entries()) {
            const computed = placementById.get(String(index));
            const fallback = asset.placement ?? undefined;
            const selectedPlacement = computed ?? fallback;
            if (!selectedPlacement) continue;

            const startSec = clamp(selectedPlacement.startTimeSec, 0, Math.max(0, totalDurationSec - 0.5));
            const endSec = clamp(selectedPlacement.endTimeSec, startSec + 0.5, totalDurationSec);
            const normalizedPosition = validPositions.has(selectedPlacement.position)
              ? selectedPlacement.position
              : "bottom-right";
            const normalizedScale = clamp(Number.isFinite(selectedPlacement.scale) ? selectedPlacement.scale : 0.3, 0.1, 1.0);

            const startFrame = Math.round(startSec * fps);
            const endFrame = Math.round(endSec * fps);
            const durationFrames = Math.max(endFrame - startFrame, fps); // minimum 1 second
            timeline.push({
              type: "overlay",
              component: "ImageOverlay",
              props: {
                src: asset.path,
                position: normalizedPosition,
                scale: normalizedScale,
                isVideo: asset.type === "video",
              },
              startAtFrame: startFrame,
              duration: durationFrames,
            } as import("../video/manifest/manifest-types.js").OverlayEntry);
            overlaysInjected++;
          }
          if (overlaysInjected > 0) {
            logger.info(`[Director API] Injected ${overlaysInjected} speech-aligned visual asset overlay(s) into timeline`);
          }
        }

        const elapsedMs = Date.now() - startTime;

        const imageSceneCount = timeline.filter((t) => t.type === "image_scene").length;
        logger.info(
          `[Director API] Presentation manifest: ${storyboard.scenes.length} scenes ` +
          `(${imageSceneCount} with images, ${skippedScenes} skipped), ` +
          `${timeline.filter((t) => t.type === "transition").length} transitions, ` +
          `${(currentFrame / fps).toFixed(1)}s total, ${elapsedMs}ms elapsed`,
        );

        if (skippedScenes > 0) {
          logger.warn(
            `[Director API] ${skippedScenes}/${storyboard.scenes.length} scenes skipped due to image generation failures. ` +
            `Check that the image sidecar is running (http://127.0.0.1:5005/health) or configure GCP_PROJECT_ID for cloud images.`,
          );
        }

        if (imageSceneCount === 0) {
          logger.error(`[Director API] No images were generated — the presentation will be blank. Check image generation provider availability.`);
        }

        res.json({
          manifest,
          tokensUsed: storyboard.tokensUsed,
          clipsProcessed: 0,
          totalDuration: currentFrame / fps,
          processingTimeMs: elapsedMs,
          skippedScenes,
          imageProvider: resolvedImageProvider,
          imageModel: imageModel ?? "default",
          storyboard: {
            title: storyboard.title,
            styleAnchor: storyboard.styleAnchor,
            analysis: storyboard.analysis,
            sceneCount: storyboard.scenes.length,
          },
        });
        return;
      }

      // ── Highlight / Script modes ──────────────────────────────
      if (!clips || !Array.isArray(clips) || clips.length === 0) {
        res.status(400).json({ error: "clips array is required and must not be empty" });
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
        const jobMeta = job as typeof job & { codec?: string; crf?: number; quality?: string };
        jobMeta.codec = codec ?? "h264";
        jobMeta.crf = resolvedCrf ?? 23;
        jobMeta.quality = quality ?? "standard";
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
