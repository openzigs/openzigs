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
 *   POST /enhance                     — enhance a scene image via Flux img2img
 *   POST /thumbnail                   — generate an AI thumbnail
 *   POST /drafts                      — create a new draft
 *   GET  /drafts                      — list all drafts
 *   GET  /drafts/:id                  — get a single draft with manifest
 *   PUT  /drafts/:id                  — update a draft
 *   DELETE /drafts/:id                — delete a draft
 *   POST /scenes/:idx/regenerate      — regenerate a single scene image
 *   POST /shorts                      — convert long-form video to YouTube Short
 *   POST /blog-to-video               — convert blog post URL to draft video
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
import { getDatabase } from "../productivity/database.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { VoiceService } from "../voice/voice-service.js";
import type { RenderOrchestrator } from "../video/render-orchestrator.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import { NARRATION_DIRECTIVES } from "../voice/pacing-translator.js";
import { AVAILABLE_LOCAL_VOICES } from "../voice/types.js";

export interface DirectorRouterOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
  renderOrchestrator?: RenderOrchestrator;
  brandVoiceService?: BrandVoiceService;
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
  brandVoiceService,
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
   * Probe a video file for duration and dimensions using ffprobe.
   */
  async function probeVideoInfo(
    filePath: string,
  ): Promise<{ durationSec: number; width: number; height: number } | null> {
    return await new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
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
        try {
          const data = JSON.parse(stdout);
          const stream = data.streams?.[0];
          const durationSec = Number.parseFloat(data.format?.duration);
          if (!Number.isFinite(durationSec) || durationSec <= 0) {
            resolve(null);
            return;
          }
          resolve({
            durationSec,
            width: stream?.width ?? 0,
            height: stream?.height ?? 0,
          });
        } catch {
          resolve(null);
        }
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
  /**
   * GET /narration/directives — available speech directives & voice presets for autocomplete.
   */
  router.get("/narration/directives", (_req, res) => {
    res.json({
      directives: NARRATION_DIRECTIVES,
      voices: AVAILABLE_LOCAL_VOICES.map(v => {
        // Infer language/gender from the voice id prefix (af=American Female, bm=British Male, etc.)
        const prefix = v.id.slice(0, 2);
        const langMap: Record<string, string> = { a: "en-US", b: "en-GB", j: "ja-JP", z: "zh-CN" };
        const genderMap: Record<string, string> = { f: "female", m: "male" };
        return {
          id: v.id,
          label: `${v.id} — ${v.description}`,
          language: langMap[prefix[0]] ?? "en",
          gender: genderMap[prefix[1]] ?? "unknown",
          style: v.description,
        };
      }),
    });
  });

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

      // For video uploads, probe for duration and dimensions
      let videoInfo: { durationSec: number; width: number; height: number } | null = null;
      if (kind === "video") {
        videoInfo = await probeVideoInfo(filePath);
      }

      res.json({ success: true, kind, filePath, fileName: uniqueName, size: body.length, videoInfo });
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
        pathMod.join(osMod.homedir(), ".openzigs", "director", "images"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "blog"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "thumbnails"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "shorts"),
      ];

      let found: string | null = null;
      for (const dir of searchDirs) {
        const candidate = pathMod.join(dir, fileName);
        if (fsMod.existsSync(candidate)) {
          found = candidate;
          break;
        }
      }

      // Search render job subdirectories (~/.openzigs/renders/<jobId>/)
      if (!found) {
        const rendersBase = pathMod.join(osMod.homedir(), ".openzigs", "renders");
        if (fsMod.existsSync(rendersBase)) {
          const jobDirs = fsMod.readdirSync(rendersBase, { withFileTypes: true });
          for (const d of jobDirs) {
            if (!d.isDirectory()) continue;
            const candidate = pathMod.join(rendersBase, d.name, fileName);
            if (fsMod.existsSync(candidate)) {
              found = candidate;
              break;
            }
          }
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
      const { clips, mode, scriptPath, musicTrackPath, template, model, enableVisionAnalysis, inputFile, sourceType, topic, imageProvider, imageModel, slideStyle, assetsOnlyMode, quizEnabled, visualAssets, brandVoiceId } = req.body as {
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
        brandVoiceId?: string;
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
        // Inject brand voice (specific ID or active default) if available
        if (brandVoiceService) {
          const voiceBlock = brandVoiceService.getVoicePromptBlockById(brandVoiceId);
          if (voiceBlock) storyboardOptions.brandVoiceBlock = voiceBlock;
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
        const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
        const imageService = new ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
        await imageService.initialize();

        const resolvedImageProvider = imageProvider ?? "auto";
        logger.info(`[Director API] Image provider: ${resolvedImageProvider}${imageModel ? `, model: ${imageModel}` : ""}`);

        // Assets-only mode: middle scenes use uploaded assets; only intro (index 0) and
        // outro (last scene) are AI-generated.
        const isAssetsOnlyMode = !!assetsOnlyMode && !!visualAssets && visualAssets.length > 0;
        const lastSceneIndex = storyboard.scenes.length - 1;

        // Fixed 16:9 video frame resolution — do not query sidecar (its native training
        // resolution overrides this with e.g. 1024x1024 for Flux, costing 3-5x more time).
        const imageWidth = 768;
        const imageHeight = 432;
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
            // Preserve the original narration text so Presenter Mode can build transcripts.
            scriptText: typeof scene.voiceover === "string" ? scene.voiceover : undefined,
            kenBurns: {
              scaleFrom: 1.0,
              scaleTo: 1.15,
              translateXFrom: 0,
              translateXTo: scene.index % 2 === 0 ? -10 : 10,
              translateYFrom: 0,
              translateYTo: -5,
            },
            textOverlays: scene.textOverlays,
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

  // ── Image Enhancement (img2img) ─────────────────────────────

  /**
   * POST /enhance — enhance a scene image via Flux img2img.
   * Body: { imagePath, prompt, strength?, model?, seed? }
   * Response: { enhancedImagePath, generationTimeMs }
   */
  router.post("/enhance", async (req, res) => {
    try {
      const { imagePath, prompt, strength, model, seed } = req.body as {
        imagePath?: string;
        prompt?: string;
        strength?: number;
        model?: string;
        seed?: number;
      };

      if (!imagePath || typeof imagePath !== "string") {
        res.status(400).json({ error: "imagePath is required" });
        return;
      }
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const fsMod = await import("node:fs");
      const osMod = await import("node:os");
      const pathMod = await import("node:path");

      // Path traversal guard: only allow files under home directory or configured outputDir
      const normalizedImagePath = pathMod.resolve(imagePath);
      const homeDir = osMod.homedir();
      const allowedRoots = [homeDir, pathMod.resolve(config.outputDir)];
      if (!allowedRoots.some((root) => normalizedImagePath.startsWith(root + pathMod.sep) || normalizedImagePath === root)) {
        res.status(403).json({ error: "Access denied: imagePath is outside allowed directories" });
        return;
      }

      if (!fsMod.existsSync(normalizedImagePath)) {
        res.status(404).json({ error: `Image not found: ${imagePath}` });
        return;
      }
      const imageOutputDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
      const imageGenUserConfig = await (await import("../video/generators/image-gen-service.js")).ImageGenService.loadUserImageGenConfig();
      const imageService = new (await import("../video/generators/image-gen-service.js")).ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
      await imageService.initialize();

      const result = await imageService.enhanceImage(normalizedImagePath, prompt, {
        strength,
        model,
        seed,
      });

      res.json({
        enhancedImagePath: result.filePath,
        generationTimeMs: result.generationTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /enhance failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Thumbnail Generation ───────────────────────────────────

  /**
   * POST /thumbnail — generate an AI-powered YouTube thumbnail for a manifest.
   * Body: { manifestPath: string, outputDir: string, style?: string, textOverride?: string[] }
   */
  router.post("/thumbnail", async (req, res) => {
    try {
      const { manifestPath, outputDir, style, textOverride } = req.body as {
        manifestPath?: string;
        outputDir?: string;
        style?: string;
        textOverride?: string[];
      };

      if (!manifestPath || typeof manifestPath !== "string") {
        res.status(400).json({ error: "manifestPath is required" });
        return;
      }
      if (!outputDir || typeof outputDir !== "string") {
        res.status(400).json({ error: "outputDir is required" });
        return;
      }

      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      // Path traversal guard: only allow files under home directory or configured outputDir
      const normalizedManifestPath = pathMod.resolve(manifestPath);
      const normalizedOutputDir = pathMod.resolve(outputDir);
      const homeDir = osMod.homedir();
      const allowedRoots = [homeDir, pathMod.resolve(config.outputDir)];
      if (!allowedRoots.some((root) => normalizedManifestPath.startsWith(root + pathMod.sep) || normalizedManifestPath === root)) {
        res.status(403).json({ error: "Access denied: manifestPath is outside allowed directories" });
        return;
      }
      if (!allowedRoots.some((root) => normalizedOutputDir.startsWith(root + pathMod.sep) || normalizedOutputDir === root)) {
        res.status(403).json({ error: "Access denied: outputDir is outside allowed directories" });
        return;
      }

      if (!fsMod.existsSync(normalizedManifestPath)) {
        res.status(404).json({ error: `Manifest not found: ${manifestPath}` });
        return;
      }

      const manifestRaw = JSON.parse(fsMod.readFileSync(normalizedManifestPath, "utf-8"));
      const { DirectorManifestSchema } = await import("../video/manifest/manifest-schema.js");
      const manifest = DirectorManifestSchema.parse(manifestRaw);

      // LLM frame selection
      const { extractKeyframesFromManifest, selectThumbnailFrame } = await import("../video/thumbnails/frame-selector.js");
      const keyframes = extractKeyframesFromManifest(manifest, outputDir);

      if (keyframes.length === 0) {
        res.status(400).json({ error: "No scene images found in output directory" });
        return;
      }

      const frameResult = await selectThumbnailFrame(keyframes, manifest, copilot);

      // Apply text override if provided
      const textLines = Array.isArray(textOverride) && textOverride.length > 0
        ? textOverride.filter((t): t is string => typeof t === "string").slice(0, 3)
        : frameResult.suggestedText;

      // Stylize the selected frame via Flux img2img
      let stylizedPath = frameResult.framePath;
      try {
        const imageOutputDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
        const imageGenMod = await import("../video/generators/image-gen-service.js");
        const imageGenUserConfig = await imageGenMod.ImageGenService.loadUserImageGenConfig();
        const imageService = new imageGenMod.ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
        await imageService.initialize();

        const stylePrompt = style ?? "YouTube thumbnail style, highly saturated, expressive, high contrast, vibrant colors, professional";
        const enhanced = await imageService.enhanceImage(frameResult.framePath, stylePrompt, {
          width: 1280,
          height: 720,
          steps: 20,
          strength: 0.6,
        });
        stylizedPath = enhanced.filePath;
      } catch (enhanceErr) {
        logger.warn(`[Director API] Thumbnail img2img enhancement failed, using raw frame: ${enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr)}`);
      }

      // Composite text overlay
      const { compositeThumbnail } = await import("../video/thumbnails/thumbnail-compositor.js");
      const thumbnailPath = pathMod.join(outputDir, "thumbnail.jpg");
      await compositeThumbnail({
        backgroundPath: stylizedPath,
        textLines,
        textPlacement: frameResult.textPlacement,
        textColor: frameResult.textColor,
        outputPath: thumbnailPath,
      });

      res.json({
        thumbnailPath,
        suggestedText: frameResult.suggestedText,
        selectedFrame: {
          path: frameResult.framePath,
          timestamp: frameResult.timestamp,
          rationale: frameResult.rationale,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /thumbnail failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Draft Persistence (CRUD) ─────────────────────────────

  /**
   * POST /assets/ingest — ingest a user-uploaded video through the ingestion pipeline.
   * Body: { filePath: string, enableVision?: boolean, model?: string }
   *
   * Runs: ffprobe → audio extraction → keyframe analysis → (optional) vision → transcript.
   * Returns: ClipAnalysis with keyframes, transcript, and descriptions.
   */
  router.post("/assets/ingest", async (req, res) => {
    try {
      const { filePath: srcPath, enableVision, model: visionModel } = req.body as {
        filePath?: string;
        enableVision?: boolean;
        model?: string;
      };

      if (!srcPath || typeof srcPath !== "string") {
        res.status(400).json({ error: "filePath is required" });
        return;
      }

      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(srcPath)) {
        res.status(404).json({ error: `File not found: ${srcPath}` });
        return;
      }

      const { ingest } = await import("../video/ingestion/index.js");
      const resolvedModel = visionModel || runtimeConfig.defaultModel || undefined;
      const useVision = enableVision !== false;

      const progressLog: Array<{ phase: string; message: string }> = [];
      const result = await ingest(
        { clips: [srcPath], mode: "highlight" },
        {
          copilot: useVision ? copilot : undefined,
          visionAnalysis: useVision
            ? { maxKeyframes: 10, delayMs: 1000, model: resolvedModel }
            : undefined,
          onProgress: (event) => {
            progressLog.push({ phase: event.phase, message: event.message });
            logger.info(`[Director API] Ingest: ${event.phase}: ${event.message}`);
          },
        },
      );

      const clip = result.clips[0];
      if (!clip) {
        res.status(500).json({ error: "Ingestion produced no clip analysis" });
        return;
      }

      logger.info(
        `[Director API] Asset ingested: ${srcPath} — ${clip.keyframes.length} keyframes, ${clip.transcript.length} transcript segments`,
      );

      res.json({
        analysis: {
          sourcePath: clip.sourcePath,
          duration: clip.duration,
          resolution: clip.resolution,
          fps: clip.fps,
          keyframes: clip.keyframes.map((kf) => ({
            timestamp: kf.timestamp,
            framePath: kf.framePath,
            sceneScore: kf.sceneScore,
            description: kf.description,
          })),
          transcriptSegments: clip.transcript.length,
          transcript: clip.transcript.slice(0, 50),
        },
        progressLog,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /assets/ingest failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Draft Persistence (CRUD) ─────────────────────────────

  /**
   * POST /drafts — create a new draft from a manifest.
   * Body: { title, manifest, productionMode, thumbnail? }
   */
  router.post("/drafts", (req, res) => {
    try {
      const { title, manifest, productionMode, thumbnail } = req.body as {
        title?: string;
        manifest?: unknown;
        productionMode?: string;
        thumbnail?: string;
      };

      if (!manifest || typeof manifest !== "object") {
        res.status(400).json({ error: "manifest object is required" });
        return;
      }
      if (!productionMode || typeof productionMode !== "string") {
        res.status(400).json({ error: "productionMode is required" });
        return;
      }

      const db = getDatabase();
      const id = nanoid();
      const now = new Date().toISOString();
      const manifestJson = JSON.stringify(manifest);
      const resolvedTitle = (title && typeof title === "string" && title.trim()) || "Untitled Draft";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(id, resolvedTitle, manifestJson, thumbnail ?? null, productionMode, now, now);

      logger.info(`[Director API] Draft created: ${id} "${resolvedTitle}"`);
      res.json({ id, title: resolvedTitle, status: "draft", createdAt: now, updatedAt: now });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /drafts failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /drafts — list all drafts.
   */
  router.get("/drafts", (_req, res) => {
    try {
      const db = getDatabase();
      const rows = db.prepare(
        `SELECT id, title, thumbnail, production_mode, created_at, updated_at, status
         FROM director_drafts ORDER BY updated_at DESC`,
      ).all() as Array<{
        id: string;
        title: string;
        thumbnail: string | null;
        production_mode: string;
        created_at: string;
        updated_at: string;
        status: string;
      }>;

      res.json({
        drafts: rows.map((r) => ({
          id: r.id,
          title: r.title,
          thumbnail: r.thumbnail,
          productionMode: r.production_mode,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          status: r.status,
        })),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /drafts failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /drafts/:id — get a single draft with full manifest.
   */
  router.get("/drafts/:id", (req, res) => {
    try {
      const db = getDatabase();
      const row = db.prepare(
        `SELECT id, title, manifest, thumbnail, production_mode, created_at, updated_at, status
         FROM director_drafts WHERE id = ?`,
      ).get(req.params.id) as {
        id: string;
        title: string;
        manifest: string;
        thumbnail: string | null;
        production_mode: string;
        created_at: string;
        updated_at: string;
        status: string;
      } | undefined;

      if (!row) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }

      let manifest: unknown;
      try {
        manifest = JSON.parse(row.manifest);
      } catch (err) {
        manifest = null;
        logger.warn(`[Director API] Draft ${row.id} has corrupt manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
      }

      res.json({
        id: row.id,
        title: row.title,
        manifest,
        thumbnail: row.thumbnail,
        productionMode: row.production_mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /drafts/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * PUT /drafts/:id — update a draft's manifest and/or title.
   * Body: { title?, manifest?, status?, thumbnail? }
   */
  router.put("/drafts/:id", (req, res) => {
    try {
      const { title, manifest, status, thumbnail } = req.body as {
        title?: string;
        manifest?: unknown;
        status?: string;
        thumbnail?: string;
      };

      const db = getDatabase();

      const existing = db.prepare(`SELECT id FROM director_drafts WHERE id = ?`)
        .get(req.params.id) as { id: string } | undefined;

      if (!existing) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (title !== undefined) {
        updates.push("title = ?");
        values.push(title);
      }
      if (manifest !== undefined) {
        updates.push("manifest = ?");
        values.push(JSON.stringify(manifest));
      }
      if (status !== undefined) {
        updates.push("status = ?");
        values.push(status);
      }
      if (thumbnail !== undefined) {
        updates.push("thumbnail = ?");
        values.push(thumbnail);
      }

      if (updates.length === 0) {
        res.json({ success: true, message: "Nothing to update" });
        return;
      }

      const now = new Date().toISOString();
      updates.push("updated_at = ?");
      values.push(now);
      values.push(req.params.id);

      db.prepare(`UPDATE director_drafts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      logger.info(`[Director API] Draft updated: ${req.params.id}`);
      res.json({ success: true, updatedAt: now });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] PUT /drafts/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /drafts/:id — delete a draft.
   */
  router.delete("/drafts/:id", (req, res) => {
    try {
      const db = getDatabase();
      const result = db.prepare(`DELETE FROM director_drafts WHERE id = ?`).run(req.params.id);
      if (result.changes === 0) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }
      logger.info(`[Director API] Draft deleted: ${req.params.id}`);
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] DELETE /drafts/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:id/versions — snapshot the current manifest with a label.
   * Body: { label?: string }
   */
  router.post("/drafts/:id/versions", async (req, res) => {
    try {
      const { randomUUID } = await import("node:crypto");
      const db = getDatabase();
      const draft = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(req.params.id) as { title: string; manifest: string } | undefined;
      if (!draft) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }
      const { label } = req.body as { label?: string };
      const id = randomUUID();
      const now = new Date().toISOString();
      const resolvedLabel = (label?.trim()) || `v – ${new Date(now).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })}`;
      db.prepare(
        `INSERT INTO director_draft_versions (id, draft_id, label, manifest, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, req.params.id, resolvedLabel, draft.manifest, now);
      logger.info(`[Director API] Draft version created: ${id} for draft ${req.params.id}`);
      res.status(201).json({ id, label: resolvedLabel, createdAt: now });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /drafts/:id/versions failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /drafts/:id/versions — list saved versions for a draft.
   */
  router.get("/drafts/:id/versions", (req, res) => {
    try {
      const db = getDatabase();
      const rows = db.prepare(
        `SELECT id, label, created_at FROM director_draft_versions
         WHERE draft_id = ? ORDER BY created_at DESC`,
      ).all(req.params.id) as Array<{ id: string; label: string; created_at: string }>;
      res.json({ versions: rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at })) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:id/versions/:versionId/restore — overwrite the draft manifest from a saved version.
   */
  router.post("/drafts/:id/versions/:versionId/restore", (req, res) => {
    try {
      const db = getDatabase();
      const ver = db.prepare(
        `SELECT manifest FROM director_draft_versions WHERE id = ? AND draft_id = ?`,
      ).get(req.params.versionId, req.params.id) as { manifest: string } | undefined;
      if (!ver) {
        res.status(404).json({ error: "Version not found" });
        return;
      }
      db.prepare(`UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`)
        .run(ver.manifest, new Date().toISOString(), req.params.id);
      logger.info(`[Director API] Draft ${req.params.id} restored from version ${req.params.versionId}`);
      res.json({ success: true, manifest: JSON.parse(ver.manifest) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /drafts/:id/renders — list render history for a draft.
   */
  router.get("/drafts/:id/renders", (req, res) => {
    try {
      const db = getDatabase();
      const rows = db.prepare(
        `SELECT id, job_id, quality, status, output_path, error, created_at, updated_at
         FROM director_renders WHERE draft_id = ? ORDER BY created_at DESC`,
      ).all(req.params.id) as Array<{
        id: string;
        job_id: string;
        quality: string;
        status: string;
        output_path: string | null;
        error: string | null;
        created_at: string;
        updated_at: string;
      }>;

      // Enrich with live job status from the render orchestrator
      const renders = rows.map((r) => {
        const job = renderOrchestrator?.getJob(r.job_id);
        return {
          id: r.id,
          jobId: r.job_id,
          quality: r.quality,
          status: job?.status ?? r.status,
          progress: job?.progress ?? (r.status === "complete" ? 100 : 0),
          outputPath: job?.outputPath ?? r.output_path,
          error: job?.error ?? r.error,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      });

      res.json({ renders });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /drafts/:id/renders failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:id/thumbnail — generate a clickbait thumbnail from a draft's manifest.
   * Body: {
   *   style?: string,
   *   textOverride?: string[],
   *   mode?: "frame-select" | "flux-enhance" | "flux-generate",
   *   prompt?: string,
   *   clickbaitOverlay?: "none" | "arrows" | "circles" | "emoji" | "badge",
   *   baseFrameUrl?: string  — for flux-enhance, reuse a previously selected frame
   * }
   *
   * Modes:
   *   frame-select    — LLM picks the best keyframe, returns raw (no img2img). Fast.
   *   flux-enhance    — img2img on the selected frame with user prompt (e.g. "add a person next to the car").
   *   flux-generate   — completely new image from text prompt.
   *
   * Response: { thumbnailUrl, suggestedText, selectedFrame, mode, rawFrameUrl? }
   */
  router.post("/drafts/:id/thumbnail", async (req, res) => {
    try {
      const osMod = await import("node:os");
      const pathMod = await import("node:path");
      const fsMod = await import("node:fs");

      const db = getDatabase();
      const draft = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(req.params.id) as { title: string; manifest: string } | undefined;
      if (!draft) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }

      const { DirectorManifestSchema } = await import("../video/manifest/manifest-schema.js");
      const manifest = DirectorManifestSchema.parse(JSON.parse(draft.manifest));

      const imageDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
      const outputDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "thumbnails");
      if (!fsMod.existsSync(outputDir)) {
        fsMod.mkdirSync(outputDir, { recursive: true });
      }

      const { style, textOverride, mode, prompt, clickbaitOverlay, baseFrameUrl } = req.body as {
        style?: string;
        textOverride?: string[];
        mode?: "frame-select" | "flux-enhance" | "flux-generate";
        prompt?: string;
        clickbaitOverlay?: "none" | "arrows" | "circles" | "emoji" | "badge";
        baseFrameUrl?: string;
      };

      const imageGenMod = await import("../video/generators/image-gen-service.js");
      const imageGenUserConfig = await imageGenMod.ImageGenService.loadUserImageGenConfig();
      const imageService = new imageGenMod.ImageGenService({ outputDir: imageDir, ...imageGenUserConfig });
      await imageService.initialize();

      // -- Helper: select the best keyframe from the manifest --
      const pickBestFrame = async () => {
        const { extractKeyframesFromManifest, selectThumbnailFrame } = await import("../video/thumbnails/frame-selector.js");
        const keyframes = extractKeyframesFromManifest(manifest, imageDir);
        if (keyframes.length === 0) return null;
        return selectThumbnailFrame(keyframes, manifest, copilot);
      };

      // -- Helper: resolve a base frame path from URL or fresh selection --
      const resolveBaseFrame = async (): Promise<{ path: string; timestamp: number; rationale: string; text: string[] } | null> => {
        // If the client sent back a previously selected frame URL, resolve it
        if (baseFrameUrl) {
          const filename = baseFrameUrl.split("/").pop() ?? "";
          // Check thumbnails directory first, then images directory
          let resolved = pathMod.join(outputDir, filename);
          if (!fsMod.existsSync(resolved)) {
            resolved = pathMod.join(imageDir, filename);
          }
          if (fsMod.existsSync(resolved)) {
            return { path: resolved, timestamp: 0, rationale: "Using previously selected frame", text: [manifest.projectTitle.toUpperCase()] };
          }
        }
        // Fall back to fresh LLM selection
        const frameResult = await pickBestFrame();
        if (!frameResult) return null;
        return { path: frameResult.framePath, timestamp: frameResult.timestamp, rationale: frameResult.rationale, text: frameResult.suggestedText };
      };

      let backgroundPath: string;
      let rawFrameUrl: string | undefined;
      let frameInfo: { timestamp: number; rationale: string } = { timestamp: 0, rationale: "" };
      let suggestedText: string[];
      const effectiveMode = mode ?? "frame-select";

      if (effectiveMode === "frame-select") {
        // Step 1 flow: just pick the best frame, no enhancement. Return fast.
        const frame = await resolveBaseFrame();
        if (!frame) {
          res.status(400).json({ error: "No scene images found — ensure the draft has generated images" });
          return;
        }
        // Copy frame to thumbnails dir so it's serveable
        const rawFilename = `raw_${req.params.id}_${Date.now()}.jpg`;
        const rawPath = pathMod.join(outputDir, rawFilename);
        fsMod.copyFileSync(frame.path, rawPath);
        rawFrameUrl = `/api/admin/director/files/${rawFilename}`;

        backgroundPath = frame.path;
        frameInfo = { timestamp: frame.timestamp, rationale: frame.rationale };
        suggestedText = frame.text;

        // Ask LLM for clickbait text suggestions
        try {
          const textChunks: string[] = [];
          const textStream = copilot.chat(
            `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
            { tools: [] },
          );
          for await (const chunk of textStream) textChunks.push(chunk);
          let jsonText = textChunks.join("").trim();
          if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
          const parsed = JSON.parse(jsonText) as { suggestedText?: string[] };
          if (Array.isArray(parsed.suggestedText)) {
            suggestedText = parsed.suggestedText.filter((t): t is string => typeof t === "string").slice(0, 3);
          }
        } catch {
          logger.warn("[Director API] Thumbnail text suggestion failed, using project title");
        }

      } else if (effectiveMode === "flux-enhance") {
        // User wants to modify the selected frame with a prompt via img2img
        const frame = await resolveBaseFrame();
        if (!frame) {
          res.status(400).json({ error: "No scene images found — ensure the draft has generated images" });
          return;
        }
        frameInfo = { timestamp: frame.timestamp, rationale: frame.rationale };
        suggestedText = frame.text;

        const enhancePrompt = prompt ?? style ?? "YouTube thumbnail style, highly saturated, expressive, high contrast, vibrant colors, professional";
        const enhanced = await imageService.kontextEdit(frame.path, enhancePrompt, {
          width: 1280,
          height: 720,
          steps: 20,
          guidance: 2.5,
        });
        backgroundPath = enhanced.filePath;
        frameInfo.rationale = `Enhanced with: "${enhancePrompt.slice(0, 80)}"`;
        logger.info(`[Director API] Thumbnail img2img enhanced: ${enhanced.filePath} (${enhanced.generationTimeMs}ms)`);

      } else {
        // flux-generate: completely new image from text prompt
        const thumbnailPrompt = prompt
          ?? `YouTube thumbnail for "${manifest.projectTitle}", highly saturated, expressive, high contrast, vibrant colors, dramatic lighting, professional photography, 4K`;

        const genResult = await imageService.generateImage(thumbnailPrompt, {
          width: 1280,
          height: 720,
        });
        backgroundPath = genResult.filePath;
        frameInfo = { timestamp: 0, rationale: `AI-generated from prompt: "${thumbnailPrompt.slice(0, 100)}"` };
        suggestedText = [manifest.projectTitle.toUpperCase()];

        // Ask LLM for clickbait text suggestions
        try {
          const textChunks: string[] = [];
          const textStream = copilot.chat(
            `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
            { tools: [] },
          );
          for await (const chunk of textStream) textChunks.push(chunk);
          let jsonText = textChunks.join("").trim();
          if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
          const parsed = JSON.parse(jsonText) as { suggestedText?: string[] };
          if (Array.isArray(parsed.suggestedText)) {
            suggestedText = parsed.suggestedText.filter((t): t is string => typeof t === "string").slice(0, 3);
          }
        } catch {
          logger.warn("[Director API] Thumbnail text suggestion failed, using project title");
        }
      }

      const textLines = Array.isArray(textOverride) && textOverride.length > 0
        ? textOverride.filter((t): t is string => typeof t === "string").slice(0, 3)
        : suggestedText;

      // Composite text overlay with optional clickbait decorations
      const { compositeThumbnail } = await import("../video/thumbnails/thumbnail-compositor.js");
      const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
      const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
      await compositeThumbnail({
        backgroundPath,
        textLines,
        textPlacement: "bottom",
        textColor: "#ffffff",
        outputPath: thumbnailPath,
        clickbaitOverlay: clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
      });

      // Update draft thumbnail reference
      db.prepare(`UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`)
        .run(thumbnailFilename, new Date().toISOString(), req.params.id);

      res.json({
        thumbnailUrl: `/api/admin/director/files/${thumbnailFilename}`,
        suggestedText,
        selectedFrame: {
          timestamp: frameInfo.timestamp,
          rationale: frameInfo.rationale,
        },
        mode: effectiveMode,
        rawFrameUrl,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /drafts/:id/thumbnail failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /renders — list all drafts with their latest completed render (if any).
   * Queries director_drafts as the base so all presentations appear.
   */
  router.get("/renders", async (_req, res) => {
    try {
      const db = getDatabase();
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      const rendersDir = pathMod.join(osMod.homedir(), ".openzigs", "renders");

      // Fetch all drafts.
      const drafts = db
        .prepare(
          `SELECT id, title, production_mode, updated_at FROM director_drafts ORDER BY updated_at DESC LIMIT 100`,
        )
        .all() as Array<{ id: string; title: string; production_mode: string; updated_at: string }>;

      // Fetch the latest render row per draft using a proper SQLite GROUP BY pattern.
      const renderRows = db
        .prepare(
          `SELECT r.draft_id, r.job_id, r.quality, r.status, r.output_path, r.created_at
           FROM director_renders r
           INNER JOIN (
             SELECT draft_id, MAX(created_at) AS max_created_at
             FROM director_renders
             GROUP BY draft_id
           ) latest ON r.draft_id = latest.draft_id AND r.created_at = latest.max_created_at`,
        )
        .all() as Array<{
        draft_id: string;
        job_id: string;
        quality: string;
        status: string;
        output_path: string | null;
        created_at: string;
      }>;

      const renderByDraft = new Map<string, (typeof renderRows)[0]>();
      for (const r of renderRows) renderByDraft.set(r.draft_id, r);

      const renders = drafts.map((d) => {
        const r = renderByDraft.get(d.id);
        const liveJob = r ? renderOrchestrator?.getJob(r.job_id) : undefined;

        // Resolve output path: live job → DB row → filesystem probe for historical renders.
        let resolvedPath: string | null = liveJob?.outputPath ?? r?.output_path ?? null;
        if (!resolvedPath && r?.job_id) {
          // Historical renders (pre-persistence hook) may have the file on disk but
          // null in the DB. Scan the job's output directory for any .mp4 file.
          const jobDir = pathMod.join(rendersDir, r.job_id);
          if (fsMod.existsSync(jobDir)) {
            const files = fsMod.readdirSync(jobDir).filter((f) => f.endsWith(".mp4"));
            if (files.length > 0) {
              resolvedPath = pathMod.join(jobDir, files[0]);
              // Back-fill the DB so future requests are instant.
              db.prepare(
                `UPDATE director_renders SET output_path = ?, status = 'complete', updated_at = ? WHERE job_id = ?`,
              ).run(resolvedPath, new Date().toISOString(), r.job_id);
            }
          }
        }

        const resolvedStatus = liveJob?.status ?? (resolvedPath ? "complete" : (r?.status ?? null));
        return {
          draftId: d.id,
          draftTitle: d.title,
          productionMode: d.production_mode,
          quality: r?.quality ?? null,
          status: resolvedStatus,
          outputPath: resolvedPath,
          downloadUrl: resolvedPath && r?.job_id ? `/api/admin/director/renders/${r.job_id}/download` : null,
          updatedAt: d.updated_at,
        };
      });

      res.json({ renders });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /renders failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /renders/:jobId/download — stream a completed render file as an attachment.
   */
  router.get("/renders/:jobId/download", async (req, res) => {
    try {
      const fsMod = await import("node:fs");

      const db = getDatabase();
      const row = db.prepare(
        `SELECT r.output_path, d.title
         FROM director_renders r
         JOIN director_drafts d ON d.id = r.draft_id
         WHERE r.job_id = ?`,
      ).get(req.params.jobId) as { output_path: string | null; title: string } | undefined;

      // Also check live job state in case DB hasn't been flushed yet
      const liveJob = renderOrchestrator?.getJob(req.params.jobId);
      const outputPath = liveJob?.outputPath ?? row?.output_path ?? null;

      if (!outputPath) {
        res.status(404).json({ error: "Render not found or not yet complete" });
        return;
      }

      if (!fsMod.existsSync(outputPath)) {
        res.status(404).json({ error: "Render file not found on disk" });
        return;
      }

      const safeTitle = (row?.title ?? "render")
        .replace(/[^a-zA-Z0-9_\- ]/g, "")
        .trim()
        .replace(/\s+/g, "_") || "render";
      const fileName = `${safeTitle}_${req.params.jobId.slice(0, 8)}.mp4`;

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      fsMod.createReadStream(outputPath).pipe(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /renders/:jobId/download failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /scenes/:sceneIndex/regenerate — regenerate a single scene image.
   * Body: { draftId, prompt, provider?, model?, seed? }
   */
  router.post("/scenes/:sceneIndex/regenerate", async (req, res) => {
    try {
      const sceneIndex = Number.parseInt(req.params.sceneIndex, 10);
      if (!Number.isFinite(sceneIndex) || sceneIndex < 0) {
        res.status(400).json({ error: "Invalid scene index" });
        return;
      }

      const { draftId, prompt, provider, model: imageModel, seed } = req.body as {
        draftId?: string;
        prompt?: string;
        provider?: "auto" | "local" | "cloud";
        model?: "flux" | "sdxl-turbo";
        seed?: number;
      };

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const osMod = await import("node:os");
      const pathMod = await import("node:path");
      const imageOutputDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
      const { ImageGenService } = await import("../video/generators/image-gen-service.js");
      const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
      await imageService.initialize();

      const result = await imageService.generateImage(prompt, {
        provider: provider ?? "auto",
        localModel: imageModel,
        seed,
      });

      // If a draftId is provided, update the corresponding scene in the draft manifest
      if (draftId) {
        const db = getDatabase();
        const row = db.prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
          .get(draftId) as { manifest: string } | undefined;

        if (row) {
          try {
            const manifest = JSON.parse(row.manifest);
            if (Array.isArray(manifest.timeline)) {
              const scenes = manifest.timeline.filter(
                (e: { type: string }) => e.type === "image_scene" || e.type === "video_clip",
              );
              if (scenes[sceneIndex]) {
                scenes[sceneIndex].src = result.filePath;
                const now = new Date().toISOString();
                db.prepare(`UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`)
                  .run(JSON.stringify(manifest), now, draftId);
              }
            }
          } catch {
            // Non-fatal: scene image was generated, draft update failed
            logger.warn(`[Director API] Failed to update draft ${draftId} scene ${sceneIndex}`);
          }
        }
      }

      res.json({
        sceneIndex,
        imagePath: result.filePath,
        generationTimeMs: result.generationTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/regenerate failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /scenes/:sceneIndex/rewrite-script — use LLM to rewrite narration after
   * a scene's visual asset has been replaced (e.g. image → video swap).
   *
   * Body: { draftId, videoDurationSec?, currentScript?, context? }
   * Returns: { sceneIndex, newScript }
   */
  router.post("/scenes/:sceneIndex/rewrite-script", async (req, res) => {
    try {
      const sceneIndex = Number.parseInt(req.params.sceneIndex, 10);
      if (!Number.isFinite(sceneIndex) || sceneIndex < 0) {
        res.status(400).json({ error: "Invalid scene index" });
        return;
      }

      const { draftId, videoDurationSec, currentScript, context } = req.body as {
        draftId?: string;
        videoDurationSec?: number;
        currentScript?: string;
        context?: string;
      };

      if (!draftId) {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

      // Load the full manifest to get surrounding context
      const db = getDatabase();
      const row = db.prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as { manifest: string } | undefined;

      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      const manifest = JSON.parse(row.manifest);
      const scenes = (manifest.timeline ?? []).filter(
        (e: { type: string }) => e.type === "image_scene" || e.type === "video_clip",
      );

      if (sceneIndex >= scenes.length) {
        res.status(400).json({ error: `Scene index ${sceneIndex} out of range (${scenes.length} scenes)` });
        return;
      }

      const scene = scenes[sceneIndex];
      const prevScene = sceneIndex > 0 ? scenes[sceneIndex - 1] : null;
      const nextScene = sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : null;

      const durationHint = videoDurationSec
        ? `The replacement video is ${videoDurationSec.toFixed(1)} seconds long.`
        : "";

      const prompt = `You are rewriting the narration script for scene ${sceneIndex + 1} of a video project.
The visual asset for this scene was just replaced${videoDurationSec ? " with a video clip" : ""}.
${durationHint}

CURRENT SCRIPT for this scene:
"${currentScript ?? scene.scriptText ?? "(none)"}"

${prevScene?.scriptText ? `PREVIOUS SCENE script (for continuity): "${prevScene.scriptText}"` : ""}
${nextScene?.scriptText ? `NEXT SCENE script (for continuity): "${nextScene.scriptText}"` : ""}
${context ? `ADDITIONAL CONTEXT: ${context}` : ""}

PROJECT TITLE: ${manifest.projectTitle ?? "Untitled"}

Rewrite the narration for this scene to smoothly accommodate the new visual.
${videoDurationSec ? `Aim for narration that fills approximately ${videoDurationSec.toFixed(1)} seconds (~${Math.round(videoDurationSec * 2.5)} words at natural pace).` : ""}
Keep the same tone and style as the surrounding scenes.
Return ONLY the new narration text, no explanations or formatting.`;

      const stream = copilot.chat(prompt, { tools: [] });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const newScript = chunks.join("").trim().replace(/^["']|["']$/g, "");

      // Update the draft manifest with the new script
      scene.scriptText = newScript;
      const now = new Date().toISOString();
      db.prepare(`UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(manifest), now, draftId);

      logger.info(`[Director API] Rewrote script for scene ${sceneIndex} in draft ${draftId}`);
      res.json({ sceneIndex, newScript });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/rewrite-script failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Shorts Pipeline ─────────────────────────────────────────

  /**
   * POST /shorts — convert a long-form video into a 30–60s YouTube Short.
   * Body: { sourceVideo: string, style?: string, targetDuration?: number, voiceProfile?: string }
   * Response: { draftId: string, manifest, viralClip, scriptText, processingTimeMs }
   */
  router.post("/shorts", async (req, res) => {
    try {
      const { sourceVideo, style, targetDuration, voiceProfile } = req.body as {
        sourceVideo?: string;
        style?: "react" | "summarize" | "highlight";
        targetDuration?: number;
        voiceProfile?: string;
      };

      if (!sourceVideo || typeof sourceVideo !== "string") {
        res.status(400).json({ error: "sourceVideo is required" });
        return;
      }

      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(sourceVideo)) {
        res.status(404).json({ error: `Source video not found: ${sourceVideo}` });
        return;
      }

      if (!voiceService) {
        res.status(503).json({ error: "VoiceService is not available — Shorts pipeline requires TTS" });
        return;
      }

      const { createShort } = await import("../video/shorts/shorts-pipeline.js");
      const result = await createShort(
        {
          sourceVideo,
          style: style ?? "highlight",
          targetDuration: targetDuration ?? 45,
          voiceProfile,
          model: runtimeConfig.defaultModel || undefined,
        },
        copilot,
        voiceService,
      );

      // Auto-save as a draft
      const db = getDatabase();
      const draftId = nanoid();
      const now = new Date().toISOString();
      const title = result.manifest.projectTitle || "Untitled Short";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(draftId, title, JSON.stringify(result.manifest), null, "shorts", now, now);

      logger.info(`[Director API] Short created as draft ${draftId}: "${title}"`);

      res.json({
        draftId,
        manifest: result.manifest,
        viralClip: result.viralClip,
        scriptText: result.scriptText,
        processingTimeMs: result.processingTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /shorts failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Blog-to-Video Pipeline ─────────────────────────────────

  /**
   * POST /blog-to-video — convert a blog post URL into a draft video manifest.
   * Body: { url: string, template?, styleHint?, imageProvider?, imageModel?, musicTrackPath?, targetDuration? }
   * Response: { draftId, manifest, blog, storyboard, processingTimeMs }
   */
  router.post("/blog-to-video", async (req, res) => {
    try {
      const { url, template, styleHint, imageProvider, imageModel, musicTrackPath, targetDuration, brandVoiceId } = req.body as {
        url?: string;
        template?: "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo";
        styleHint?: string;
        imageProvider?: "cloud" | "local" | "auto";
        imageModel?: "flux" | "sdxl-turbo";
        musicTrackPath?: string;
        targetDuration?: number;
        brandVoiceId?: string;
      };

      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required" });
        return;
      }

      // Basic URL validation
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          res.status(400).json({ error: "Only http/https URLs are allowed" });
          return;
        }
      } catch {
        res.status(400).json({ error: "Invalid URL" });
        return;
      }

      const { blogToVideo } = await import("../video/blog/blog-to-video-pipeline.js");
      const result = await blogToVideo(
        {
          url,
          template,
          styleHint,
          imageProvider,
          imageModel,
          musicTrackPath,
          model: runtimeConfig.defaultModel || undefined,
          targetDuration,
          brandVoiceBlock: brandVoiceService?.getVoicePromptBlockById(brandVoiceId) || undefined,
        },
        copilot,
        voiceService,
      );

      // Auto-save as a draft
      const db = getDatabase();
      const draftId = nanoid();
      const now = new Date().toISOString();
      const title = result.manifest.projectTitle || "Untitled Blog Video";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(draftId, title, JSON.stringify(result.manifest), null, "blog-to-video", now, now);

      logger.info(`[Director API] Blog-to-video saved as draft ${draftId}: "${title}"`);

      res.json({
        draftId,
        manifest: result.manifest,
        blog: result.blog,
        storyboard: result.storyboard,
        processingTimeMs: result.processingTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /blog-to-video failed: ${msg}`);
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

      const { manifest, codec, crf, quality, draftId } = req.body as {
        manifest: unknown;
        codec?: string;
        crf?: number;
        quality?: "draft" | "standard" | "high" | "lossless";
        draftId?: string;
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
        const jobMeta = job as typeof job & { codec?: string; crf?: number; quality?: string; draftId?: string };
        jobMeta.codec = codec ?? "h264";
        jobMeta.crf = resolvedCrf ?? 23;
        jobMeta.quality = quality ?? "standard";
        jobMeta.draftId = draftId;
      }

      // Record render in history if linked to a draft
      if (draftId) {
        const db = getDatabase();
        const now = new Date().toISOString();
        const renderId = nanoid();
        db.prepare(
          `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(renderId, draftId, jobId, quality ?? "standard", now, now);
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
