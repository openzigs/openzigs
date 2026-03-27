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
 *   POST /enhance-instructions         — enhance style & instructions preamble via LLM
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
import os from "node:os";
import { spawn } from "node:child_process";
import { Router, raw } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logger } from "../logging/logger.js";
import { getDatabase } from "../productivity/database.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { VoiceService } from "../voice/voice-service.js";
import type { RenderOrchestrator } from "../video/render-orchestrator.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { Server as SocketIOServer } from "socket.io";
import { NARRATION_DIRECTIVES } from "../voice/pacing-translator.js";
import { AVAILABLE_LOCAL_VOICES } from "../voice/types.js";
import { getUserSelectedModel } from "../config/user-model.js";
import { BrandKitRepository } from "../video/brand-kit.js";

/** Late-bound Socket.IO reference for emitting activity events. */
let _io: SocketIOServer | null = null;
export function setDirectorIO(io: SocketIOServer): void { _io = io; }

export interface DirectorRouterOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
  renderOrchestrator?: RenderOrchestrator;
  brandVoiceService?: BrandVoiceService;
  toolRegistry?: ToolRegistry;
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
  toolRegistry,
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

  // Mutable runtime config (overlaid on top of file-based config)
  const runtimeConfig = {
    pixabayApiKey: config.assets.pixabayApiKey,
    jamendoClientId: config.assets.jamendoClientId,
    pexelsApiKey: config.assets.pexelsApiKey,
    defaultModel: "", // empty = use system default
  };

  // ── Produce Job Tracker ────────────────────────────────────
  // Matches the gallery's async pattern: POST returns immediately with a job ID,
  // the pipeline runs in the background, and the frontend polls for completion.
  interface ProduceJob {
    id: string;
    status: "running" | "complete" | "failed" | "cancelled";
    /** The full response payload — populated when status === "complete" */
    result?: Record<string, unknown>;
    error?: string;
    startedAt: number;
    completedAt?: number;
    /** Abort controller for cancelling the running pipeline */
    abort?: AbortController;
  }
  const produceJobs = new Map<string, ProduceJob>();

  /** Lazy singleton asset manager (hoisted so config PUT can reset it). */
  let assetManagerInstance: import("../video/assets/asset-manager.js").AssetManager | null = null;

  /** Ensure gallery collection/tag tables exist (idempotent). */
  let galleryTablesReady = false;
  function ensureGalleryTables(db: import("better-sqlite3").Database): void {
    if (galleryTablesReady) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gallery_collection_items (
        collection_id TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        PRIMARY KEY (collection_id, asset_path),
        FOREIGN KEY (collection_id) REFERENCES gallery_collections(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS gallery_tags (
        asset_path TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (asset_path, tag)
      );
    `);
    galleryTablesReady = true;
  }

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
      if (srcPath.includes("..") || srcPath.includes("\0")) {
        res.status(400).json({ error: "Invalid file path" });
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

      const rawNameHeader = String(req.header("x-file-name") || "upload.bin");
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

      const mimeType = String(req.header("x-file-type") || "application/octet-stream");
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

      const rawName = String(req.header("x-file-name") || "asset.bin");
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
      if (backgroundPath.includes("..") || backgroundPath.includes("\0")) {
        res.status(400).json({ error: "Invalid backgroundPath" });
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
   * Returns 202 immediately with a `produceJobId`; the pipeline runs in the
   * background.  Poll `GET /produce/:id` for status and result.
   *
   * Body (highlight/script): { clips: string[], mode: "highlight" | "script", scriptPath?, musicTrackPath?, template?, model?, enableVisionAnalysis? }
   * Body (presentation):     { mode: "presentation", inputFile: string, sourceType?: "text"|"markdown", topic?: string, musicTrackPath?, template?, model?, imageProvider?, imageModel?, slideStyle?, assetsOnlyMode? }
   */
  router.post("/produce", async (req, res) => {
    try {
      const { clips, mode, scriptPath, musicTrackPath, template, model, enableVisionAnalysis, inputFile, sourceType, topic, imageProvider, imageModel, slideStyle, assetsOnlyMode, quizEnabled, visualAssets, brandVoiceId, imageClipDurationSeconds, heroReelOverview, defaultClipDuration, heroReelImages, inspirationContext } = req.body as {
        clips?: string[];
        mode: "highlight" | "script" | "presentation" | "hero-reel";
        scriptPath?: string;
        musicTrackPath?: string;
        template?: string;
        model?: string;
        enableVisionAnalysis?: boolean;
        inputFile?: string;
        sourceType?: "text" | "markdown";
        topic?: string;
        imageProvider?: "cloud" | "local" | "auto";
        imageModel?: "flux" | "flux-schnell" | "flux-dev" | "sdxl-turbo";
        slideStyle?: boolean;
        assetsOnlyMode?: boolean;
        quizEnabled?: boolean;
        brandVoiceId?: string;
        imageClipDurationSeconds?: number;
        heroReelOverview?: string;
        defaultClipDuration?: number;
        heroReelImages?: Array<{ path: string; description: string }>;
        inspirationContext?: string;
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

      if (!mode || !["highlight", "script", "presentation", "hero-reel"].includes(mode)) {
        res.status(400).json({ error: "mode must be 'highlight', 'script', 'presentation', or 'hero-reel'" });
        return;
      }

      // Validate mode-specific required fields before creating the job
      if (mode === "presentation" && !inputFile) {
        res.status(400).json({ error: "'inputFile' is required for presentation mode" });
        return;
      }
      if (inputFile && (inputFile.includes("\0") || inputFile.includes(".."))) {
        res.status(400).json({ error: "Invalid inputFile path" });
        return;
      }
      if (scriptPath && (scriptPath.includes("\0") || scriptPath.includes(".."))) {
        res.status(400).json({ error: "Invalid scriptPath" });
        return;
      }
      if (musicTrackPath && (musicTrackPath.includes("\0") || musicTrackPath.includes(".."))) {
        res.status(400).json({ error: "Invalid musicTrackPath" });
        return;
      }
      if (mode === "hero-reel" && !heroReelOverview?.trim()) {
        res.status(400).json({ error: "'heroReelOverview' is required for hero-reel mode" });
        return;
      }
      if ((mode === "highlight" || mode === "script") && (!clips || !Array.isArray(clips) || clips.length === 0)) {
        res.status(400).json({ error: "clips array is required and must not be empty" });
        return;
      }

      // Create produce job and return 202 immediately — pipeline runs in background.
      // This matches the gallery's async pattern: submit → poll for result.
      const produceJobId = nanoid();
      const produceAbort = new AbortController();
      const job: ProduceJob = { id: produceJobId, status: "running", startedAt: Date.now(), abort: produceAbort };
      produceJobs.set(produceJobId, job);

      // Evict old completed/failed jobs (keep last 20)
      const allJobs = [...produceJobs.values()];
      const finished = allJobs.filter(j => j.status !== "running").sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      while (finished.length > 20) {
        const old = finished.shift()!;
        produceJobs.delete(old.id);
      }

      res.status(202).json({ produceJobId });
      logger.info(`[Director API] Produce job ${produceJobId} accepted (mode=${mode}) — running in background`);

      /** Emit a produce activity event via Socket.IO (if available). */
      const emitActivity = (phase: string, detail?: string, extra?: Record<string, unknown>) => {
        if (!_io) return;
        _io.emit("produce:progress", { id: produceJobId, mode, phase, detail, timestamp: Date.now(), ...extra });
      };

      emitActivity("started", `${mode} pipeline initiated`);

      // ── Background pipeline ────────────────────────────────
      // Everything below runs after the HTTP response has been sent.
      // Errors are captured into the job object, not thrown to Express.
      (async () => {
        /** Throw if the pipeline was cancelled. Call before each major stage. */
        const checkAborted = () => {
          if (produceAbort.signal.aborted) throw new Error("Cancelled by user");
        };

        try {

      // ── Presentation mode: document → storyboard → images → TTS → manifest ──
      if (mode === "presentation") {

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
          rawText = await fs.readFile(inputFile!, "utf-8");
        } catch (readErr) {
          const readMsg = readErr instanceof Error ? readErr.message : String(readErr);
          throw new Error(`Failed to read input file: ${readMsg}`);
        }

        if (sourceType === "markdown" || inputFile!.endsWith(".md")) {
          rawText = rawText.replace(/```[\s\S]*?```/g, "[code block removed]");
        }

        logger.info(`[Director API] Presentation mode: read ${rawText.length} chars from ${inputFile}`);

        // Step B: Generate storyboard via LLM
        checkAborted();
        emitActivity("storyboard", "Generating storyboard from document");
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
        if (imageClipDurationSeconds && imageClipDurationSeconds >= 1 && imageClipDurationSeconds <= 10) {
          storyboardOptions.imageClipDurationSeconds = imageClipDurationSeconds;
        }
        // Inject brand voice (specific ID or active default) if available
        if (brandVoiceService) {
          const voiceBlock = brandVoiceService.getVoicePromptBlockById(brandVoiceId);
          if (voiceBlock) storyboardOptions.brandVoiceBlock = voiceBlock;
        }
        const storyboard = await storyboardEngine.generate(rawText, storyboardOptions);

        logger.info(`[Director API] Storyboard generated: "${storyboard.title}" with ${storyboard.scenes.length} scenes`);
        checkAborted();
        emitActivity("images", `Generating assets for ${storyboard.scenes.length} scenes`);

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

        // Step C.1: Detect F5-TTS voice profile for presentation voiceover
        // When the audio sidecar has F5-TTS active, we synthesize
        // voiceover via the sidecar's /f5tts endpoint with the user's
        // voice profile clips, bypassing VoiceService (which only knows Kokoro).
        interface F5TTSClipRow {
          emotion: string;
          ref_audio_path: string;
          ref_text: string;
        }
        let f5ttsClips: F5TTSClipRow[] = [];
        let sidecarBaseUrl = "";
        let useF5TTSVoice = false;

        if (voiceService) {
          sidecarBaseUrl = voiceService.getSidecarUrl();
          try {
            const healthResp = await fetch(`${sidecarBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            if (healthResp.ok) {
              const health = await healthResp.json() as { active_engine?: string };
              if (health.active_engine === "f5tts") {
                // Load F5-TTS clips from the most recently updated F5-TTS profile
                const db = getDatabase();
                const f5Profile = db.prepare(
                  `SELECT id FROM voice_profiles WHERE engine_type = 'f5tts'
                   ORDER BY updated_at DESC LIMIT 1`,
                ).get() as { id: string } | undefined;
                if (f5Profile) {
                  const clips = db.prepare(
                    `SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips
                     WHERE profile_id = ? ORDER BY sort_order ASC`,
                  ).all(f5Profile.id) as F5TTSClipRow[];
                  if (clips.length > 0) {
                    f5ttsClips = clips;
                    useF5TTSVoice = true;
                    logger.info(`[Director API] F5-TTS voice detected — ${clips.length} clip(s) from profile ${f5Profile.id}`);
                  }
                }
              }
            }
          } catch {
            // Sidecar not reachable; fall back to VoiceService
          }
        }

        // ── Parallel image + voiceover generation ──────────────────────────
        // Images and voiceovers are independent — they typically run on
        // different machines/sidecars. By launching both streams concurrently,
        // total production time drops significantly compared to the old
        // sequential approach (image → audio → next scene).

        type SceneImageResult = { index: number; filePath: string | null; skipped: boolean };
        type SceneVoiceResult = { index: number; voiceoverPath: string | undefined };

        const generateSceneImage = async (scene: typeof storyboard.scenes[0]): Promise<SceneImageResult> => {
          if (isAssetsOnlyMode && scene.index > 0 && scene.index < lastSceneIndex) {
            const assetIndex = (scene.index - 1) % visualAssets!.length;
            const fp = visualAssets![assetIndex].path;
            logger.info(`[Director API] Assets-only: scene ${scene.index + 1}/${storyboard.scenes.length} → ${fp}`);
            return { index: scene.index, filePath: fp, skipped: false };
          }
          logger.info(
            `[Director API] Generating image ${scene.index + 1}/${storyboard.scenes.length}: ` +
            `"${scene.rawImageDescription.substring(0, 60)}..."`,
          );
          try {
            const result = await imageService.generateImage(scene.imagePrompt, {
              provider: resolvedImageProvider,
              localModel: imageModel,
              width: imageWidth,
              height: imageHeight,
              seed: baseSeed + scene.index * 1000,
            });
            return { index: scene.index, filePath: result.filePath, skipped: false };
          } catch (imgErr) {
            const imgMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
            logger.error(`[Director API] Image generation failed for scene ${scene.index}: ${imgMsg}`);
            return { index: scene.index, filePath: null, skipped: true };
          }
        };

        const generateSceneVoiceover = async (scene: typeof storyboard.scenes[0]): Promise<SceneVoiceResult> => {
          if (!scene.voiceover) return { index: scene.index, voiceoverPath: undefined };
          let voiceoverPath: string | undefined;

          if (useF5TTSVoice && f5ttsClips.length > 0 && voiceService) {
            try {
              const f5Result = await voiceService.synthesizeF5TTS(
                scene.voiceover,
                f5ttsClips.map((c) => ({
                  emotion: c.emotion,
                  refAudioPath: c.ref_audio_path,
                  refText: c.ref_text,
                })),
              );
              const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.wav`);
              await fs.writeFile(voPath, f5Result.audio);
              voiceoverPath = voPath;
              logger.info(`[Director API] F5-TTS voiceover for scene ${scene.index}: ${f5Result.audio.length} bytes`);
            } catch (f5Err) {
              const msg = f5Err instanceof Error ? f5Err.message : String(f5Err);
              const cause = f5Err instanceof Error && f5Err.cause ? ` (cause: ${f5Err.cause instanceof Error ? f5Err.cause.message : String(f5Err.cause)})` : "";
              logger.warn(`[Director API] F5-TTS voiceover failed for scene ${scene.index}: ${msg}${cause}`);
            }
          } else if (voiceService) {
            try {
              if (!voiceService.isReady()) {
                logger.info(`[Director API] Initializing Kokoro TTS for scene ${scene.index}`);
                await voiceService.initialize();
              }
              if (voiceService.isReady()) {
                const ttsResult = await voiceService.synthesize(scene.voiceover);
                const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.mp3`);
                await fs.writeFile(voPath, ttsResult.audio);
                voiceoverPath = voPath;
                logger.info(`[Director API] Kokoro voiceover for scene ${scene.index}: ${ttsResult.audio.length} bytes`);
              } else {
                logger.warn(`[Director API] Kokoro TTS not ready for scene ${scene.index} — skipping voiceover`);
              }
            } catch (kokoroErr) {
              const msg = kokoroErr instanceof Error ? kokoroErr.message : String(kokoroErr);
              logger.warn(`[Director API] Kokoro voiceover failed for scene ${scene.index}: ${msg}`);
            }
          } else {
            logger.warn(`[Director API] No TTS engine available for scene ${scene.index} — skipping voiceover`);
          }

          return { index: scene.index, voiceoverPath };
        };

        // Launch image and voiceover generation concurrently.
        // Images: sequential per scene (cloud has QPM limits, local sidecar
        // processes one at a time) but runs IN PARALLEL with voiceover stream.
        // Voiceovers: sequential — F5-TTS is a single-threaded ML model that
        // crashes or drops connections under concurrent load. Serializing
        // ensures each scene gets a clean generation pass.
        checkAborted();
        emitActivity("generating", `Generating images + voiceovers for ${storyboard.scenes.length} scenes in parallel`);

        const imageGenStream = (async (): Promise<SceneImageResult[]> => {
          const results: SceneImageResult[] = [];
          for (const scene of storyboard.scenes) {
            checkAborted();
            if (resolvedImageProvider !== "local" && scene.index > 0) {
              await new Promise(r => setTimeout(r, 15_000));
            }
            results.push(await generateSceneImage(scene));
            emitActivity("images", `Image ${results.length}/${storyboard.scenes.length} generated`);
          }
          return results;
        })();

        const voiceGenStream = (async (): Promise<SceneVoiceResult[]> => {
          // Pre-flight: re-verify sidecar is still alive before burning time on TTS
          if (useF5TTSVoice && voiceService) {
            try {
              const ping = await fetch(`${sidecarBaseUrl}/health`, { signal: AbortSignal.timeout(5000) });
              if (!ping.ok) {
                logger.warn(`[Director API] Audio sidecar health check failed before voiceover generation (${ping.status}) — falling back to Kokoro`);
                useF5TTSVoice = false;
              }
            } catch {
              logger.warn("[Director API] Audio sidecar unreachable before voiceover generation — falling back to Kokoro");
              useF5TTSVoice = false;
            }
          }
          const engine = useF5TTSVoice ? "F5-TTS" : "Kokoro";
          logger.info(`[Director API] Starting voiceover generation (engine=${engine}, scenes=${storyboard.scenes.length})`);
          const results: SceneVoiceResult[] = [];
          for (const scene of storyboard.scenes) {
            checkAborted();
            results.push(await generateSceneVoiceover(scene));
            emitActivity("voices", `Voiceover ${results.length}/${storyboard.scenes.length} generated`);
            logger.info(`[Director API] Voiceover ${results.length}/${storyboard.scenes.length} complete (scene ${scene.index}, path=${results[results.length - 1].voiceoverPath ?? "none"})`);
          }
          return results;
        })();

        const [imageResults, voiceResults] = await Promise.all([imageGenStream, voiceGenStream]);

        const imageMap = new Map(imageResults.map((r) => [r.index, r]));
        const voiceMap = new Map(voiceResults.map((r) => [r.index, r]));
        skippedScenes = imageResults.filter((r) => r.skipped).length;

        logger.info(`[Director API] Parallel generation complete: ${imageResults.length - skippedScenes} images, ${voiceResults.filter(v => v.voiceoverPath).length} voiceovers`);
        checkAborted();
        emitActivity("timeline", "Assembling timeline");

        // ── Phase 2: Assemble timeline using pre-generated results ──────────
        for (const scene of storyboard.scenes) {
          const imgResult = imageMap.get(scene.index);
          if (!imgResult || imgResult.skipped || !imgResult.filePath) continue;

          const sceneImageFilePath = imgResult.filePath;
          const sceneVoiceoverPath = voiceMap.get(scene.index)?.voiceoverPath;

          let sceneDurationSec = scene.durationEstimate;
          if (sceneVoiceoverPath) {
            const measuredDuration = await probeAudioDurationSeconds(sceneVoiceoverPath);
            if (measuredDuration && measuredDuration > 0) {
              sceneDurationSec = Math.max(measuredDuration + 0.35, 2);
            }
          }

          const durationInFrames = Math.max(Math.round(sceneDurationSec * fps), fps);

          // ── Chapter title card ──
          if (scene.chapterTitle) {
            const CHAPTER_CARD_DURATION = 90;

            if (timeline.length > 0) {
              timeline.push({
                type: "transition",
                style: "crossfade",
                duration: 15,
                startAtFrame: currentFrame,
              });
            }

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

          const sceneStartFrame = currentFrame;

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

        job.status = "complete";
        job.completedAt = Date.now();
        job.result = {
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
        };
        // Auto-save as a draft so the result survives navigation
        const db = getDatabase();
        const draftId = nanoid();
        const now = new Date().toISOString();
        const draftTitle = storyboard.title || "Untitled Presentation";
        db.prepare(
          `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        ).run(draftId, draftTitle, JSON.stringify(manifest), null, "presentation", now, now);
        job.result!.draftId = draftId;

        logger.info(`[Director API] Produce job ${produceJobId} complete (presentation, ${elapsedMs}ms) — draft ${draftId}`);
        emitActivity("complete", `Presentation ready (${(elapsedMs / 1000).toFixed(0)}s)`, { draftId, title: draftTitle });
        return;
      }

      // ── Hero Reel mode: overview → storyboard → images → manifest (no TTS) ──
      if (mode === "hero-reel") {
        const startTime = Date.now();

        const path = await import("node:path");
        const os = await import("node:os");
        const { StoryboardEngine } = await import("../video/generators/storyboard-engine.js");
        const { ImageGenService } = await import("../video/generators/image-gen-service.js");

        checkAborted();
        emitActivity("storyboard", "Generating hero reel storyboard");
        const storyboardEngine = new StoryboardEngine(copilot);
        const resolvedModel = model || runtimeConfig.defaultModel || undefined;
        const clipDur = typeof defaultClipDuration === "number" && defaultClipDuration >= 1 && defaultClipDuration <= 10
          ? defaultClipDuration : 2;

        const storyboard = await storyboardEngine.generateHeroReel(heroReelOverview!, {
          model: resolvedModel,
          styleHint: topic,
          imageClipDurationSeconds: clipDur,
          userImages: heroReelImages?.map((img, i) => ({ index: i, description: img.description })),
          inspirationContext,
        });

        logger.info(`[Director API] Hero reel storyboard: "${storyboard.title}" with ${storyboard.scenes.length} scenes`);
        checkAborted();
        emitActivity("images", `Generating images for ${storyboard.scenes.length} scenes`);

        // Generate images
        const imageOutputDir = path.join(os.homedir(), ".openzigs", "director", "images");
        const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
        const imageService = new ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
        await imageService.initialize();

        const resolvedImageProvider = imageProvider ?? "auto";
        const imageWidth = 768;
        const imageHeight = 432;
        const fps = 30;
        const templateId = (template as "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo") ?? "Minimalist";
        const baseSeed = Date.now() % 100_000;

        const timeline: Array<import("../video/manifest/manifest-types.js").ImageSceneEntry | import("../video/manifest/manifest-types.js").TitleCardEntry | import("../video/manifest/manifest-types.js").TransitionEntry | import("../video/manifest/manifest-types.js").OverlayEntry> = [];
        let currentFrame = 0;
        let skippedScenes = 0;

        for (const scene of storyboard.scenes) {
          checkAborted();
          const prompt = scene.imagePrompt || storyboard.styleAnchor;
          let sceneImageFilePath: string | undefined;

          // Use user-provided image if the LLM assigned one
          const userImg = scene.userImageIndex !== undefined && heroReelImages?.[scene.userImageIndex];
          if (userImg) {
            const fs = await import("node:fs/promises");
            try {
              await fs.access(userImg.path);
              // Enhance the user image with Kontext if there's a meaningful prompt
              if (prompt && prompt.trim().length > 0) {
                try {
                  const enhanced = await imageService.kontextEdit(userImg.path, `${storyboard.styleAnchor}. ${prompt}`, {
                    width: imageWidth,
                    height: imageHeight,
                  });
                  sceneImageFilePath = enhanced.filePath;
                  logger.info(`[Director API] Hero reel scene ${scene.index}: user image enhanced via Kontext (${enhanced.generationTimeMs}ms)`);
                } catch (enhanceErr) {
                  logger.warn(`[Director API] Hero reel scene ${scene.index}: Kontext enhance failed, using original image: ${enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr)}`);
                  sceneImageFilePath = userImg.path;
                }
              } else {
                sceneImageFilePath = userImg.path;
              }
            } catch {
              logger.warn(`[Director API] Hero reel scene ${scene.index}: user image not found at ${userImg.path}, falling back to AI generation`);
            }
          }

          // Fall back to AI image generation if no user image was used
          if (!sceneImageFilePath) {
            try {
              const result = await imageService.generateImage(prompt, {
                provider: resolvedImageProvider,
                localModel: imageModel,
                width: imageWidth,
                height: imageHeight,
                seed: baseSeed + scene.index * 1000,
              });
              sceneImageFilePath = result.filePath;
            } catch (imgErr) {
              logger.warn(`[Director API] Hero reel scene ${scene.index} image failed: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`);
              skippedScenes++;
              continue;
            }
          }

          emitActivity("images", `Image ${scene.index + 1}/${storyboard.scenes.length} generated`);

          const durationInFrames = Math.max(Math.round(clipDur * fps), fps);

          if (timeline.length > 0) {
            const transitionDuration = Math.min(10, durationInFrames);
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
            voiceover: undefined,
            voiceoverVolume: 0,
            scriptText: scene.voiceover,
            kenBurns: {
              scaleFrom: 1.0,
              scaleTo: 1.2,
              translateXFrom: 0,
              translateXTo: scene.index % 2 === 0 ? -12 : 12,
              translateYFrom: 0,
              translateYTo: -6,
            },
          });

          currentFrame += durationInFrames;
        }

        const resolvedMusicPath = musicTrackPath?.trim() || undefined;
        const manifest: import("../video/manifest/manifest-types.js").DirectorManifest = {
          projectTitle: storyboard.title,
          templateId,
          composition: { width: 1920, height: 1080, fps },
          audioLayer: {
            music: resolvedMusicPath ? {
              track: resolvedMusicPath,
              volume: 0.15,
              ducking: false,
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
            productionMode: "hero-reel",
            presenterQuizEnabled: false,
            sourceClips: [],
            estimatedRenderTime: currentFrame / fps,
          },
        };

        const elapsedMs = Date.now() - startTime;
        const imageSceneCount = timeline.filter((t) => t.type === "image_scene").length;
        logger.info(
          `[Director API] Hero reel manifest: ${imageSceneCount} scenes, ` +
          `${(currentFrame / fps).toFixed(1)}s total, ${elapsedMs}ms elapsed`,
        );

        job.status = "complete";
        job.completedAt = Date.now();
        job.result = {
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
        };
        // Auto-save as a draft so the result survives navigation
        const db = getDatabase();
        const draftId = nanoid();
        const now = new Date().toISOString();
        const draftTitle = storyboard.title || "Untitled Hero Reel";
        db.prepare(
          `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        ).run(draftId, draftTitle, JSON.stringify(manifest), null, "hero-reel", now, now);
        job.result!.draftId = draftId;

        logger.info(`[Director API] Produce job ${produceJobId} complete (hero-reel, ${elapsedMs}ms) — draft ${draftId}`);
        emitActivity("complete", `Hero reel ready (${(elapsedMs / 1000).toFixed(0)}s)`, { draftId, title: draftTitle });
        return;
      }

      // ── Highlight / Script modes ──────────────────────────────
      emitActivity("ingestion", `${mode} mode — ingesting clips`);

      const startTime = Date.now();
      const progressLog: Array<{ phase: string; message: string; timestamp: number }> = [];

      // Vision analysis is enabled by default
      const useVision = enableVisionAnalysis !== false;

      // Ingest clips (with optional vision analysis)
      const { ingest } = await import("../video/ingestion/index.js");
      const ingestionResult = await ingest({ clips: clips!, mode }, {
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

      job.status = "complete";
      job.completedAt = Date.now();
      job.result = {
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
          totalSourcesProvided: clips!.length,
        },
      };
      // Auto-save as a draft so the result survives navigation
      {
        const db = getDatabase();
        const draftId = nanoid();
        const now = new Date().toISOString();
        const draftTitle = (result.manifest as unknown as Record<string, unknown>).projectTitle as string || `Untitled ${mode}`;
        db.prepare(
          `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        ).run(draftId, draftTitle, JSON.stringify(result.manifest), null, mode, now, now);
        job.result!.draftId = draftId;

        logger.info(`[Director API] Produce job ${produceJobId} complete (${mode}, ${elapsedMs}ms) — draft ${draftId}`);
        emitActivity("complete", `${mode} pipeline finished (${(elapsedMs / 1000).toFixed(0)}s)`, { draftId, title: draftTitle });
      }

        } catch (bgError) {
          // Don't overwrite status if already cancelled by user
          if (job.status === "cancelled") return;
          const msg = bgError instanceof Error ? bgError.message : String(bgError);
          logger.error(`[Director API] Produce job ${produceJobId} failed: ${msg}`);
          job.status = "failed";
          job.error = msg;
          job.completedAt = Date.now();
          emitActivity("failed", msg);
        }
      })();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /produce validation failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
  /**
   * GET /produce/jobs — return all produce jobs (for activity monitoring).
   */
  router.get("/produce/jobs", (_req, res) => {
    const jobs = [...produceJobs.values()].map((j) => ({
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      error: j.error,
      elapsedMs: j.status === "running" ? Date.now() - j.startedAt : (j.completedAt ?? j.startedAt) - j.startedAt,
    }));
    res.json({ jobs });
  });

  /**
   * GET /produce/:id — poll for produce job status.
   * Returns { status: "running" } while in progress, or the full produce result
   * when complete.
   */
  router.get("/produce/:id", (req, res) => {
    const job = produceJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Produce job not found" });
      return;
    }
    if (job.status === "running") {
      const elapsedMs = Date.now() - job.startedAt;
      res.json({ status: "running", elapsedMs });
      return;
    }
    if (job.status === "failed") {
      res.json({ status: "failed", error: job.error });
      return;
    }
    if (job.status === "cancelled") {
      res.json({ status: "cancelled", error: job.error });
      return;
    }
    // Complete — return the full result
    res.json({ status: "complete", ...job.result });
  });

  /**
   * POST /produce/:id/cancel — cancel a running produce pipeline.
   */
  router.post("/produce/:id/cancel", (req, res) => {
    const job = produceJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Produce job not found" });
      return;
    }
    if (job.status !== "running") {
      res.status(409).json({ error: `Job already ${job.status}` });
      return;
    }
    job.abort?.abort();
    job.status = "cancelled";
    job.error = "Cancelled by user";
    job.completedAt = Date.now();
    if (_io) {
      _io.emit("produce:progress", { id: job.id, mode: "produce", phase: "cancelled", detail: "Cancelled by user", timestamp: Date.now() });
    }
    logger.info(`[Director API] Produce job ${job.id} cancelled by user`);
    res.json({ success: true });
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

  // ── Enhance Instructions ──────────────────────────────────

  /**
   * POST /enhance-instructions — use the LLM to enrich a Director style/instructions preamble.
   * Body: { raw_instructions: string, mode?: string }
   * Response: { enhanced_instructions: string, thinking: string }
   */
  router.post("/enhance-instructions", async (req, res) => {
    try {
      const { raw_instructions, mode, model: bodyModel } = req.body as { raw_instructions?: string; mode?: string; model?: string };

      if (!raw_instructions?.trim()) {
        res.status(400).json({ error: "raw_instructions is required" });
        return;
      }

      const productionMode = mode ?? "presentation";
      const conversationId = `enhance-director-instructions-${Date.now()}`;

      const systemMessage = `You are an expert AI video production director and prompt engineer.
Your job is to take a rough style/instructions preamble written by a user and enhance it into a clear, comprehensive set of creative directions used to guide an AI storyboard generator.

These instructions are NOT a visual image prompt — they describe the overall tone, visual style, audience, pacing, and narrative approach for a video presentation.

## Guidelines
- Clarify the target audience and communication goals if vague.
- Add specific visual style direction (color palette, typography feel, illustration style).
- Specify tone descriptors (authoritative, friendly, technical, inspirational, etc.).
- Mention pacing and structure cues (e.g., "open with a hook", "use data slides mid-video", "close with a CTA").
- Keep the voice consistent with what the user wrote — enhance, don't rewrite their intent.
- Be concise: 3-6 sentences is ideal. Do not write more than 8 sentences.

## Production Mode
${productionMode === "presentation" ? "This is a PRESENTATION: AI-generated images with voiceover narration from a source document." : productionMode === "highlight" ? "This is a HIGHLIGHT REEL: user-supplied video clips edited to a script." : "This is a SCRIPT VIDEO: voiceover narration over uploaded video clips."}

Respond ONLY with a bare JSON object — no markdown, no code fences:
{"thinking": "One sentence explaining what you improved", "enhanced_instructions": "The enhanced, detailed instructions string"}`;

      const userMessage = `Enhance these style and instructions for my video project:\n\n"${raw_instructions.trim()}"`;

      const enhanceModel = bodyModel || await getUserSelectedModel();
      let fullResponse = "";
      for await (const chunk of copilot.chat(userMessage, {
        conversationId,
        systemMessage: { mode: "replace", content: systemMessage },
        tools: [],
        availableTools: [],
        ...(enhanceModel ? { model: enhanceModel } : {}),
      })) {
        fullResponse += chunk;
      }
      await copilot.destroySession(conversationId);

      // Parse JSON response — strip any accidental markdown fences
      const jsonStr = fullResponse.replace(/^```(?:json)?\n?/m, "").replace(/```\s*$/m, "").trim();
      let parsed: { thinking?: string; enhanced_instructions?: string };
      try {
        parsed = JSON.parse(jsonStr) as { thinking?: string; enhanced_instructions?: string };
      } catch {
        // Fallback: return the raw text as the enhancement
        parsed = { thinking: "Instructions enhanced.", enhanced_instructions: fullResponse.trim() };
      }

      res.json({
        enhanced_instructions: parsed.enhanced_instructions ?? raw_instructions,
        thinking: parsed.thinking ?? "Instructions enhanced.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Director API] POST /enhance-instructions failed: ${msg}`);
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

      // Path traversal guard: reject traversal sequences and only allow files under home directory
      if (manifestPath.includes("..") || manifestPath.includes("\0") || outputDir.includes("..") || outputDir.includes("\0")) {
        res.status(400).json({ error: "Invalid path" });
        return;
      }
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
      if (srcPath.includes("..") || srcPath.includes("\0")) {
        res.status(400).json({ error: "Invalid file path" });
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
   * GET /drafts/:id/subtitles/:format — export subtitles in SRT or VTT format.
   * Issue #521
   */
  router.get("/drafts/:id/subtitles/:format", async (req, res) => {
    try {
      const { id, format } = req.params;
      if (format !== "srt" && format !== "vtt") {
        res.status(400).json({ error: "Format must be 'srt' or 'vtt'" });
        return;
      }

      const db = getDatabase();
      const row = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`).get(id) as {
        title: string;
        manifest: string;
      } | undefined;

      if (!row) {
        res.status(404).json({ error: `Draft not found: ${id}` });
        return;
      }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        res.status(500).json({ error: "Draft has corrupt manifest JSON" });
        return;
      }

      const { generateSubtitles } = await import("../video/subtitle-export.js");
      const content = generateSubtitles(manifest as import("../video/subtitle-export.js").ManifestForSubtitles, format);

      const safeTitle = row.title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
      const filename = `${safeTitle}.${format}`;
      const contentType = format === "srt" ? "application/x-subrip" : "text/vtt";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(content);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /drafts/:id/subtitles/:format failed: ${msg}`);
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
          const thumbModel = await getUserSelectedModel();
          const textChunks: string[] = [];
          const textStream = copilot.chat(
            `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
            { tools: [], ...(thumbModel ? { model: thumbModel } : {}) },
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
        // Long-running Kontext edit — return 202, run in background, notify via Socket.IO
        const frame = await resolveBaseFrame();
        if (!frame) {
          res.status(400).json({ error: "No scene images found — ensure the draft has generated images" });
          return;
        }

        const thumbnailJobId = nanoid();
        res.status(202).json({ thumbnailJobId, mode: effectiveMode });
        logger.info(`[Director API] Thumbnail job ${thumbnailJobId} accepted (flux-enhance) — running in background`);

        (async () => {
          try {
            const enhancePrompt = prompt ?? style ?? "YouTube thumbnail style, highly saturated, expressive, high contrast, vibrant colors, professional";
            const enhanced = await imageService.kontextEdit(frame.path, enhancePrompt, {
              width: 1280,
              height: 720,
              steps: 20,
              guidance: 2.5,
            });
            logger.info(`[Director API] Thumbnail img2img enhanced: ${enhanced.filePath} (${enhanced.generationTimeMs}ms)`);

            const textLines = Array.isArray(textOverride) && textOverride.length > 0
              ? textOverride.filter((t): t is string => typeof t === "string").slice(0, 3)
              : frame.text;

            const { compositeThumbnail } = await import("../video/thumbnails/thumbnail-compositor.js");
            const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
            const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
            await compositeThumbnail({
              backgroundPath: enhanced.filePath,
              textLines,
              textPlacement: "bottom",
              textColor: "#ffffff",
              outputPath: thumbnailPath,
              clickbaitOverlay: clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
            });

            db.prepare(`UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`)
              .run(thumbnailFilename, new Date().toISOString(), req.params.id);

            if (_io) _io.emit("thumbnail:complete", {
              thumbnailJobId,
              draftId: req.params.id,
              thumbnailUrl: `/api/admin/director/files/${thumbnailFilename}`,
              suggestedText: textLines,
              selectedFrame: { timestamp: frame.timestamp, rationale: `Enhanced with: "${enhancePrompt.slice(0, 80)}"` },
              mode: effectiveMode,
            });
            logger.info(`[Director API] Thumbnail job ${thumbnailJobId} complete`);
          } catch (bgErr) {
            const bgMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
            logger.error(`[Director API] Thumbnail job ${thumbnailJobId} failed: ${bgMsg}`);
            if (_io) _io.emit("thumbnail:failed", { thumbnailJobId, draftId: req.params.id, error: bgMsg });
          }
        })();
        return;

      } else {
        // flux-generate: completely new image — also long-running, same async pattern
        const thumbnailJobId = nanoid();
        res.status(202).json({ thumbnailJobId, mode: effectiveMode });
        logger.info(`[Director API] Thumbnail job ${thumbnailJobId} accepted (flux-generate) — running in background`);

        (async () => {
          try {
            const thumbnailPrompt = prompt
              ?? `YouTube thumbnail for "${manifest.projectTitle}", highly saturated, expressive, high contrast, vibrant colors, dramatic lighting, professional photography, 4K`;

            const genResult = await imageService.generateImage(thumbnailPrompt, {
              width: 1280,
              height: 720,
            });
            let genSuggestedText: string[] = [manifest.projectTitle.toUpperCase()];

            try {
              const thumbModel2 = await getUserSelectedModel();
              const textChunks: string[] = [];
              const textStream = copilot.chat(
                `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
                { tools: [], ...(thumbModel2 ? { model: thumbModel2 } : {}) },
              );
              for await (const chunk of textStream) textChunks.push(chunk);
              let jsonText = textChunks.join("").trim();
              if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
              const parsed = JSON.parse(jsonText) as { suggestedText?: string[] };
              if (Array.isArray(parsed.suggestedText)) {
                genSuggestedText = parsed.suggestedText.filter((t): t is string => typeof t === "string").slice(0, 3);
              }
            } catch {
              logger.warn("[Director API] Thumbnail text suggestion failed, using project title");
            }

            const textLines = Array.isArray(textOverride) && textOverride.length > 0
              ? textOverride.filter((t): t is string => typeof t === "string").slice(0, 3)
              : genSuggestedText;

            const { compositeThumbnail } = await import("../video/thumbnails/thumbnail-compositor.js");
            const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
            const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
            await compositeThumbnail({
              backgroundPath: genResult.filePath,
              textLines,
              textPlacement: "bottom",
              textColor: "#ffffff",
              outputPath: thumbnailPath,
              clickbaitOverlay: clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
            });

            db.prepare(`UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`)
              .run(thumbnailFilename, new Date().toISOString(), req.params.id);

            if (_io) _io.emit("thumbnail:complete", {
              thumbnailJobId,
              draftId: req.params.id,
              thumbnailUrl: `/api/admin/director/files/${thumbnailFilename}`,
              suggestedText: textLines,
              selectedFrame: { timestamp: 0, rationale: `AI-generated from prompt: "${thumbnailPrompt.slice(0, 100)}"` },
              mode: effectiveMode,
            });
            logger.info(`[Director API] Thumbnail job ${thumbnailJobId} complete`);
          } catch (bgErr) {
            const bgMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
            logger.error(`[Director API] Thumbnail job ${thumbnailJobId} failed: ${bgMsg}`);
            if (_io) _io.emit("thumbnail:failed", { thumbnailJobId, draftId: req.params.id, error: bgMsg });
          }
        })();
        return;
      }

      // frame-select mode reaches here — composite and respond synchronously
      const textLines = Array.isArray(textOverride) && textOverride.length > 0
        ? textOverride.filter((t): t is string => typeof t === "string").slice(0, 3)
        : suggestedText;

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
        model?: "flux-schnell" | "flux-dev" | "sdxl-turbo";
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
   * POST /scenes/:sceneIndex/replace-from-gallery — copy a gallery image into the
   * director assets folder and use it as the scene's visual.
   * Body: { draftId, assetId }
   */
  router.post("/scenes/:sceneIndex/replace-from-gallery", async (req, res) => {
    try {
      const sceneIndex = Number.parseInt(req.params.sceneIndex, 10);
      if (!Number.isFinite(sceneIndex) || sceneIndex < 0) {
        res.status(400).json({ error: "Invalid scene index" });
        return;
      }

      const { draftId, assetId } = req.body as { draftId?: string; assetId?: string };
      if (!assetId || typeof assetId !== "string") {
        res.status(400).json({ error: "assetId is required" });
        return;
      }

      const db = getDatabase();
      const asset = db.prepare("SELECT * FROM media_assets WHERE id = ?").get(assetId) as { file_path: string } | undefined;
      if (!asset || !asset.file_path) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      const sourcePath = String(asset.file_path);
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      if (!fsMod.existsSync(sourcePath)) {
        res.status(404).json({ error: "Asset file not found on disk" });
        return;
      }

      // Copy into director images dir
      const imageDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
      fsMod.mkdirSync(imageDir, { recursive: true });
      const ext = pathMod.extname(sourcePath) || ".png";
      const destFilename = `gallery-${Date.now()}${ext}`;
      const destPath = pathMod.join(imageDir, destFilename);
      fsMod.copyFileSync(sourcePath, destPath);

      // Update draft if provided
      if (draftId) {
        const db = getDatabase();
        const row = db.prepare("SELECT manifest FROM director_drafts WHERE id = ?")
          .get(draftId) as { manifest: string } | undefined;

        if (row) {
          try {
            const manifest = JSON.parse(row.manifest);
            if (Array.isArray(manifest.timeline)) {
              const scenes = manifest.timeline.filter(
                (e: { type: string }) => e.type === "image_scene" || e.type === "video_clip",
              );
              if (scenes[sceneIndex]) {
                scenes[sceneIndex].src = destPath;
                const now = new Date().toISOString();
                db.prepare("UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?")
                  .run(JSON.stringify(manifest), now, draftId);
              }
            }
          } catch {
            logger.warn(`[Director API] Failed to update draft ${draftId} scene ${sceneIndex}`);
          }
        }
      }

      res.json({ filePath: destPath });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/replace-from-gallery failed: ${msg}`);
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

      const { draftId, videoDurationSec, currentScript, context, model: bodyModel } = req.body as {
        draftId?: string;
        videoDurationSec?: number;
        currentScript?: string;
        context?: string;
        model?: string;
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

      const rewriteModel = bodyModel || await getUserSelectedModel();
      const stream = copilot.chat(prompt, { tools: [], ...(rewriteModel ? { model: rewriteModel } : {}) });
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

      if (sourceVideo.includes("..") || sourceVideo.includes("\0")) {
        res.status(400).json({ error: "Invalid sourceVideo path" });
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
        imageModel?: "flux" | "flux-schnell" | "flux-dev" | "sdxl-turbo";
        musicTrackPath?: string;
        targetDuration?: number;
        brandVoiceId?: string;
      };

      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required" });
        return;
      }

      if (musicTrackPath && (musicTrackPath.includes("\0") || musicTrackPath.includes(".."))) {
        res.status(400).json({ error: "Invalid musicTrackPath" });
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

      const { manifest, codec, crf, quality, draftId, notifyViaTelegram, telegramChatId } = req.body as {
        manifest: unknown;
        codec?: string;
        crf?: number;
        quality?: "draft" | "standard" | "high" | "lossless";
        draftId?: string;
        notifyViaTelegram?: boolean;
        telegramChatId?: string;
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
        notifyViaTelegram,
        telegramChatId,
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

  // ── Per-scene voiceover re-record ─────────────────────────

  /**
   * POST /scenes/:sceneIndex/re-record — re-synthesize voiceover for a single
   * scene without regenerating the entire presentation.
   *
   * Body: {
   *   draftId: string,
   *   text: string,                     — narration text to synthesize
   *   engine?: "kokoro" | "f5tts",      — voice engine override
   *   f5ttsParams?: { steps?, method?, cfgStrength?, swayCoef?, speed?, seed? },
   *   voice?: string,                   — Kokoro voice ID override
   * }
   *
   * Returns: { sceneIndex, voiceoverPath, durationSec, engine }
   */
  router.post("/scenes/:sceneIndex/re-record", async (req, res) => {
    try {
      const sceneIndex = parseInt(req.params.sceneIndex, 10);
      if (isNaN(sceneIndex) || sceneIndex < 0) {
        res.status(400).json({ error: "Invalid scene index" });
        return;
      }

      const { draftId, text, engine, f5ttsParams, voice } = req.body as {
        draftId?: string;
        text?: string;
        engine?: "kokoro" | "f5tts";
        f5ttsParams?: {
          steps?: number;
          method?: "euler" | "midpoint" | "rk4";
          cfgStrength?: number;
          swayCoef?: number;
          speed?: number;
          seed?: number;
        };
        voice?: string;
      };

      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "text is required" });
        return;
      }

      if (!voiceService) {
        res.status(503).json({ error: "Voice service not available" });
        return;
      }

      if (!voiceService.isReady()) {
        await voiceService.initialize();
      }

      const osMod = await import("node:os");
      const fsMod = await import("node:fs/promises");
      const imageOutputDir = path.join(osMod.homedir(), ".openzigs", "director", "images");
      await fsMod.mkdir(imageOutputDir, { recursive: true });

      let voiceoverPath: string;
      let usedEngine: string;

      const resolvedEngine = engine ?? "auto";

      // Determine which engine to use
      if (resolvedEngine === "f5tts" || resolvedEngine === "auto") {
        // Check if F5-TTS is available
        const sidecarUrl = voiceService.getSidecarUrl();
        let f5Available = false;
        let f5Clips: Array<{ emotion: string; ref_audio_path: string; ref_text: string }> = [];

        try {
          const healthResp = await fetch(`${sidecarUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (healthResp.ok) {
            const health = await healthResp.json() as { active_engine?: string };
            if (health.active_engine === "f5tts") {
              const db = getDatabase();
              const f5Profile = db.prepare(
                `SELECT id FROM voice_profiles WHERE engine_type = 'f5tts'
                 ORDER BY updated_at DESC LIMIT 1`,
              ).get() as { id: string } | undefined;
              if (f5Profile) {
                const clips = db.prepare(
                  `SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips
                   WHERE profile_id = ? ORDER BY sort_order ASC`,
                ).all(f5Profile.id) as Array<{ emotion: string; ref_audio_path: string; ref_text: string }>;
                if (clips.length > 0) {
                  f5Clips = clips;
                  f5Available = true;
                }
              }
            }
          }
        } catch {
          // F5-TTS not reachable
        }

        if (f5Available && f5Clips.length > 0 && (resolvedEngine === "f5tts" || resolvedEngine === "auto")) {
          const f5Result = await voiceService.synthesizeF5TTS(
            text,
            f5Clips.map((c) => ({
              emotion: c.emotion,
              refAudioPath: c.ref_audio_path,
              refText: c.ref_text,
            })),
            f5ttsParams ? {
              steps: f5ttsParams.steps,
              method: f5ttsParams.method,
              cfgStrength: f5ttsParams.cfgStrength,
              swayCoef: f5ttsParams.swayCoef,
              speed: f5ttsParams.speed,
              seed: f5ttsParams.seed,
            } : undefined,
          );
          const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.wav`);
          await fsMod.writeFile(voPath, f5Result.audio);
          voiceoverPath = voPath;
          usedEngine = "f5tts";
        } else if (resolvedEngine === "f5tts") {
          res.status(503).json({ error: "F5-TTS engine not available. Check sidecar health." });
          return;
        } else {
          // Fall back to Kokoro/VoiceService
          const ttsResult = await voiceService.synthesize(text, voice);
          const ext = ttsResult.contentType?.includes("wav") ? "wav" : "mp3";
          const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.${ext}`);
          await fsMod.writeFile(voPath, ttsResult.audio);
          voiceoverPath = voPath;
          usedEngine = voiceService.getProvider();
        }
      } else {
        // Kokoro / VoiceService
        const ttsResult = await voiceService.synthesize(text, voice);
        const ext = ttsResult.contentType?.includes("wav") ? "wav" : "mp3";
        const voPath = path.join(imageOutputDir, `openzigs-vo-${nanoid(8)}.${ext}`);
        await fsMod.writeFile(voPath, ttsResult.audio);
        voiceoverPath = voPath;
        usedEngine = voiceService.getProvider();
      }

      // Measure duration
      const durationSec = await probeAudioDurationSeconds(voiceoverPath) ?? 0;

      // Update the draft manifest if draftId provided
      if (draftId) {
        const db = getDatabase();
        const row = db.prepare(`SELECT manifest FROM director_drafts WHERE id = ?`).get(draftId) as
          | { manifest: string }
          | undefined;

        if (row) {
          try {
            const manifest = JSON.parse(row.manifest);
            if (Array.isArray(manifest.timeline)) {
              const visualTypes = new Set(["image_scene", "video_clip"]);
              let visualIdx = 0;
              for (let i = 0; i < manifest.timeline.length; i++) {
                if (visualTypes.has(manifest.timeline[i].type)) {
                  if (visualIdx === sceneIndex) {
                    manifest.timeline[i].voiceover = voiceoverPath;
                    manifest.timeline[i].scriptText = text;
                    // Update scene duration to match new audio
                    const fps = manifest.composition?.fps ?? 30;
                    if (durationSec > 0) {
                      const newDuration = Math.max(Math.round((durationSec + 0.35) * fps), fps);
                      manifest.timeline[i].duration = newDuration;
                    }
                    break;
                  }
                  visualIdx++;
                }
              }
              const now = new Date().toISOString();
              db.prepare(`UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`)
                .run(JSON.stringify(manifest), now, draftId);
            }
          } catch {
            logger.warn(`[Director API] Failed to update draft ${draftId} scene ${sceneIndex} voiceover`);
          }
        }
      }

      logger.info(`[Director API] Re-recorded scene ${sceneIndex} voiceover: engine=${usedEngine}, dur=${durationSec.toFixed(1)}s`);

      res.json({
        sceneIndex,
        voiceoverPath,
        durationSec,
        engine: usedEngine,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/re-record failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /voice/engines — return available voice engines and their status.
   */
  router.get("/voice/engines", async (_req, res) => {
    try {
      const engines: Array<{ id: string; name: string; available: boolean; active: boolean }> = [];

      if (voiceService) {
        const provider = voiceService.getProvider();
        engines.push({
          id: "kokoro",
          name: "Kokoro (Local TTS)",
          available: voiceService.isReady() && (provider === "local" || provider === "f5tts"),
          active: provider === "local",
        });

        // Check F5-TTS availability
        const sidecarUrl = voiceService.getSidecarUrl();
        let f5Active = false;
        try {
          const healthResp = await fetch(`${sidecarUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (healthResp.ok) {
            const health = await healthResp.json() as { active_engine?: string };
            f5Active = health.active_engine === "f5tts";
          }
        } catch {
          // not reachable
        }

        // Check if F5-TTS has clips configured
        let f5HasClips = false;
        try {
          const db = getDatabase();
          const clipCount = db.prepare(
            `SELECT COUNT(*) as cnt FROM f5tts_clips c
             JOIN voice_profiles p ON c.profile_id = p.id
             WHERE p.engine_type = 'f5tts'`,
          ).get() as { cnt: number } | undefined;
          f5HasClips = (clipCount?.cnt ?? 0) > 0;
        } catch {
          // DB not available
        }

        engines.push({
          id: "f5tts",
          name: "F5-TTS (Voice Cloning)",
          available: f5Active && f5HasClips,
          active: f5Active,
        });

        engines.push({
          id: "google",
          name: "Google Cloud TTS",
          available: provider === "google" && voiceService.isReady(),
          active: provider === "google",
        });
      }

      res.json({ engines });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── AI-analyze F5-TTS parameters ──────────────────────────

  /**
   * POST /voice/analyze-params — use the LLM to recommend optimal F5-TTS
   * parameters based on the complexity/nature of the narration text.
   *
   * Body: { text: string }
   * Returns: { speed, steps, method, cfgStrength, swayCoef, reasoning }
   */
  router.post("/voice/analyze-params", async (req, res) => {
    try {
      const { text, model: bodyModel } = req.body as { text?: string; model?: string };
      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "text is required" });
        return;
      }

      const conversationId = `f5tts-params-${Date.now()}`;
      const systemMessage = `You are an expert audio engineer specializing in text-to-speech synthesis with the F5-TTS voice cloning model.

Your job: analyze narration text and recommend optimal F5-TTS parameters for the highest quality output.

## F5-TTS Parameters
- **speed** (0.5–2.0, default 1.0): Speech rate. Slower values help with complex, technical, or data-heavy text. Faster for casual/conversational text.
- **steps** (4–32, default 8): Inference steps. More steps = higher quality but slower generation. Complex text with technical terms, numbers, or acronyms benefits from more steps.
- **method** ("euler" | "midpoint" | "rk4"): Sampling method. "rk4" is highest quality but slowest. "euler" is fastest but lower quality. "midpoint" is a balanced middle ground.
- **cfgStrength** (0.5–5.0, default 2.0): Classifier-free guidance strength. Higher values make output more closely follow the prompt but can cause artifacts. Lower values are more natural.
- **swayCoef** (-3.0–3.0, default -1.0): Controls expressiveness/intonation variation. Negative values are more monotone/stable; positive values are more expressive/dynamic.

## Analysis Criteria
Consider these factors when recommending parameters:
1. **Technical complexity**: Acronyms, numbers, URLs, code references → slower speed, more steps
2. **Sentence length**: Long sentences → slightly slower speed for clarity
3. **Emotional tone**: Exciting/dramatic → higher swayCoef; calm/professional → lower
4. **Proper nouns/unusual words**: More of these → more steps, slower speed
5. **Punctuation density**: Heavy punctuation (ellipses, dashes, exclamations) → higher cfgStrength

Respond ONLY with a bare JSON object — no markdown, no code fences:
{"speed": number, "steps": number, "method": "euler"|"midpoint"|"rk4", "cfgStrength": number, "swayCoef": number, "reasoning": "One sentence explaining your choices"}`;

      const ttsModel = bodyModel || await getUserSelectedModel();
      let fullResponse = "";
      for await (const chunk of copilot.chat(
        `Analyze this narration text and recommend optimal F5-TTS parameters:\n\n"${text.trim()}"`,
        {
          conversationId,
          systemMessage: { mode: "replace", content: systemMessage },
          tools: [],
          availableTools: [],
          ...(ttsModel ? { model: ttsModel } : {}),
        },
      )) {
        fullResponse += chunk;
      }
      await copilot.destroySession(conversationId);

      // Parse the JSON response
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.status(500).json({ error: "Failed to parse AI response" });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        speed?: number;
        steps?: number;
        method?: string;
        cfgStrength?: number;
        swayCoef?: number;
        reasoning?: string;
      };

      res.json({
        speed: Math.max(0.5, Math.min(2.0, parsed.speed ?? 1.0)),
        steps: Math.max(4, Math.min(32, Math.round(parsed.steps ?? 8))),
        method: ["euler", "midpoint", "rk4"].includes(parsed.method ?? "") ? parsed.method : "rk4",
        cfgStrength: Math.max(0.5, Math.min(5.0, parsed.cfgStrength ?? 2.0)),
        swayCoef: Math.max(-3.0, Math.min(3.0, parsed.swayCoef ?? -1.0)),
        reasoning: parsed.reasoning ?? "",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /voice/analyze-params failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── AI narration directives ───────────────────────────────

  /**
   * POST /voice/add-directives — use the LLM to analyze narration text and
   * insert pacing/emotion directives for more expressive TTS output.
   *
   * Inserts [PAUSE: Xs], *emphasis*, and (Emotion) tags based on semantic
   * analysis of the script content.
   *
   * Body: { text: string, engine?: "kokoro" | "f5tts" }
   * Returns: { enhanced: string, reasoning: string }
   */
  router.post("/voice/add-directives", async (req, res) => {
    try {
      const { text, engine, model: bodyModel } = req.body as { text?: string; engine?: string; model?: string };
      if (!text || typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "text is required" });
        return;
      }

      const isF5 = engine === "f5tts";

      const conversationId = `narration-directives-${Date.now()}`;
      const systemMessage = `You are an expert voice director and narration coach specializing in text-to-speech optimization.

Your job: analyze narration text and insert directives that make TTS output sound more natural, expressive, and engaging — as if a professional voice actor were reading it.

## Available Directives

### Pauses — [PAUSE: Xs]
Insert strategic pauses for dramatic effect, emphasis, or natural breathing.
- [PAUSE: 0.3s] — beat pause (after key statement before revealing result)
- [PAUSE: 0.5s] — short pause (between thoughts, before a key point)
- [PAUSE: 1s] — medium pause (at section transitions, after impactful statements)
- [PAUSE: 1.5s] — long pause (dramatic reveal, major topic shift)
- [PAUSE: 2s] — extended pause (chapter break, dramatic silence)

### Emphasis — *word*
Wrap key words or short phrases in asterisks to indicate vocal emphasis.
Use for: statistics/data, important names, action words, contrasts.
Example: "Revenue grew by *forty percent*" or "This is *critical*."

${isF5 ? `### Emotion Tags — (Emotion)
F5-TTS can switch between reference audio clips tagged by emotion. Use these to control vocal tone:
- (Regular) — normal, conversational tone (default)
- (Excited) — enthusiastic, energetic delivery
- (Serious) — grave, authoritative tone
- (Whisper) — soft, intimate, secretive
- (Warm) — friendly, empathetic, caring
Place the emotion tag BEFORE the text that should use that tone. It stays active until the next emotion tag.` : ""}

## Rules
1. Do NOT rewrite, rephrase, or change ANY words in the source text. Only INSERT directive tags.
2. Be surgical — a few well-placed directives are better than over-tagging every sentence.
3. Aim for 3-8 directives total for a typical paragraph. More for longer text.
4. Pauses work best: before reveals, after questions, at topic transitions.
5. Emphasis works best: on numbers/stats, on contrasting words, on the single most important word in a key sentence.
${isF5 ? "6. Emotion tags should only change 1-3 times in a typical paragraph. Don't oscillate rapidly." : ""}
7. Preserve all existing directives already in the text — do not remove or modify them.
8. The text may contain pronunciation hints (dotted acronyms like N.P.M.) — preserve them exactly.

Respond ONLY with a bare JSON object — no markdown, no code fences:
{"enhanced": "the original text with directives inserted", "reasoning": "Brief explanation of your choices"}`;

      const directiveModel = bodyModel || await getUserSelectedModel();
      let fullResponse = "";
      for await (const chunk of copilot.chat(
        `Add narration directives to this script:\n\n"${text.trim()}"`,
        {
          conversationId,
          systemMessage: { mode: "replace", content: systemMessage },
          tools: [],
          availableTools: [],
          ...(directiveModel ? { model: directiveModel } : {}),
        },
      )) {
        fullResponse += chunk;
      }
      await copilot.destroySession(conversationId);

      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.status(500).json({ error: "Failed to parse AI response" });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        enhanced?: string;
        reasoning?: string;
      };

      if (!parsed.enhanced) {
        res.status(500).json({ error: "AI did not return enhanced text" });
        return;
      }

      res.json({
        enhanced: parsed.enhanced,
        reasoning: parsed.reasoning ?? "",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /voice/add-directives failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── AI-enhance image prompt ───────────────────────────────

  /**
   * POST /scenes/:sceneIndex/enhance-prompt — use the LLM to improve/enhance
   * the image generation prompt for a scene.
   *
   * Body: { prompt: string, context?: string }
   * Returns: { enhanced_prompt: string, thinking: string }
   */
  router.post("/scenes/:sceneIndex/enhance-prompt", async (req, res) => {
    try {
      const { prompt, context, model: bodyModel } = req.body as { prompt?: string; context?: string; model?: string };

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const conversationId = `enhance-scene-prompt-${Date.now()}`;
      const systemMessage = `You are an expert AI prompt engineer specializing in image generation with Flux diffusion models.

Your job: take a rough image prompt and enhance it into a detailed, high-quality generation prompt optimized for Flux models (schnell and dev).

## Guidelines
- Add specific visual details: lighting, composition, camera angle, color palette, mood
- Include style references: "professional photography", "cinematic", "editorial", "illustration style"
- Specify quality tags: "high resolution", "sharp focus", "detailed", "professional"
- Keep the core subject/intent intact — enhance, don't replace
- Aim for 2-4 sentences total. Be specific but concise.
- For scenes in a video presentation, ensure the image style would work well as a visual aid.
${context ? `\nContext about the overall video: ${context}` : ""}

Respond ONLY with a bare JSON object — no markdown, no code fences:
{"thinking": "One sentence explaining what you improved", "enhanced_prompt": "The enhanced prompt string"}`;

      const sceneModel = bodyModel || await getUserSelectedModel();
      let fullResponse = "";
      for await (const chunk of copilot.chat(
        `Enhance this image generation prompt:\n\n"${prompt.trim()}"`,
        {
          conversationId,
          systemMessage: { mode: "replace", content: systemMessage },
          tools: [],
          availableTools: [],
          ...(sceneModel ? { model: sceneModel } : {}),
        },
      )) {
        fullResponse += chunk;
      }
      await copilot.destroySession(conversationId);

      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.status(500).json({ error: "Failed to parse AI response" });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        thinking?: string;
        enhanced_prompt?: string;
      };

      res.json({
        enhanced_prompt: parsed.enhanced_prompt ?? prompt,
        thinking: parsed.thinking ?? "",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/enhance-prompt failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Scene img2img ─────────────────────────────────────────

  /**
   * POST /scenes/:sceneIndex/img2img — enhance/modify an existing scene image
   * via img2img diffusion. Uses the scene's current image as the source.
   *
   * Body: { draftId, prompt, strength?, model?, seed? }
   * Returns: { sceneIndex, imagePath, generationTimeMs }
   */
  router.post("/scenes/:sceneIndex/img2img", async (req, res) => {
    try {
      const sceneIndex = Number.parseInt(req.params.sceneIndex, 10);
      if (!Number.isFinite(sceneIndex) || sceneIndex < 0) {
        res.status(400).json({ error: "Invalid scene index" });
        return;
      }

      const { draftId, prompt, strength, model, seed } = req.body as {
        draftId?: string;
        prompt?: string;
        strength?: number;
        model?: string;
        seed?: number;
      };

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }
      if (!draftId) {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

      // Load draft to get the current image path
      const db = getDatabase();
      const row = db.prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as { manifest: string } | undefined;
      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      const manifestData = JSON.parse(row.manifest);
      if (!Array.isArray(manifestData.timeline)) {
        res.status(400).json({ error: "Draft has no timeline" });
        return;
      }

      const scenes = manifestData.timeline.filter(
        (e: { type: string }) => e.type === "image_scene" || e.type === "video_clip",
      );
      if (!scenes[sceneIndex] || !scenes[sceneIndex].src) {
        res.status(404).json({ error: "Scene or scene image not found" });
        return;
      }

      const currentImagePath = scenes[sceneIndex].src as string;
      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(currentImagePath)) {
        res.status(404).json({ error: `Source image not found: ${currentImagePath}` });
        return;
      }

      const osMod = await import("node:os");
      const imageOutputDir = path.join(osMod.homedir(), ".openzigs", "director", "images");
      const { ImageGenService } = await import("../video/generators/image-gen-service.js");
      const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
      await imageService.initialize();

      const result = await imageService.enhanceImage(currentImagePath, prompt, {
        strength: strength ?? 0.6,
        model,
        seed,
      });

      // Update the draft manifest with the new image
      scenes[sceneIndex].src = result.filePath;
      const now = new Date().toISOString();
      db.prepare(`UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(manifestData), now, draftId);

      res.json({
        sceneIndex,
        imagePath: result.filePath,
        generationTimeMs: result.generationTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /scenes/:sceneIndex/img2img failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /enhance-overview — use the LLM to improve a hero reel overview description.
   *
   * Body: { overview: string }
   * Returns: { enhanced_overview: string }
   */
  router.post("/enhance-overview", async (req, res) => {
    try {
      const { overview, model: bodyModel } = req.body as { overview?: string; model?: string };

      if (!overview || typeof overview !== "string" || overview.trim().length === 0) {
        res.status(400).json({ error: "overview is required" });
        return;
      }

      const conversationId = `enhance-overview-${Date.now()}`;
      const systemMessage = `You are an expert creative director specializing in short-form video content.

Your job: take a rough hero reel overview description and enhance it into a clear, vivid creative brief that will produce a compelling highlight reel.

## Guidelines
- Sharpen the visual style, pacing, and mood (e.g., fast-cut, cinematic, energetic, minimal)
- Clarify the subject matter and key themes to showcase
- Add specific tonal direction (e.g., "dark tech aesthetic", "bold and punchy", "clean corporate")
- Keep the original intent — enhance and expand, never override the user's core idea
- Aim for 2-3 concise sentences. Be specific and actionable.

Respond ONLY with a bare JSON object — no markdown, no code fences:
{"enhanced_overview": "The improved overview string"}`;

      const overviewModel = bodyModel || await getUserSelectedModel();
      let fullResponse = "";
      for await (const chunk of copilot.chat(
        `Enhance this hero reel overview description:\n\n"${overview.trim()}"`,
        {
          conversationId,
          systemMessage: { mode: "replace", content: systemMessage },
          tools: [],
          availableTools: [],
          ...(overviewModel ? { model: overviewModel } : {}),
        },
      )) {
        fullResponse += chunk;
      }
      await copilot.destroySession(conversationId);

      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.status(500).json({ error: "Failed to parse AI response" });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as { enhanced_overview?: string };

      res.json({ enhanced_overview: parsed.enhanced_overview ?? overview });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /enhance-overview failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /hero-reel/process-inspiration — extract text and images from a file
   * to use as inspiration for a hero reel.
   *
   * Body: { filePath: string }
   * Returns: { text: string, images: Array<{ path: string, description: string }> }
   */
  router.post("/hero-reel/process-inspiration", async (req, res) => {
    try {
      const { filePath: inputPath } = req.body as { filePath?: string };

      if (!inputPath || typeof inputPath !== "string" || inputPath.trim().length === 0) {
        res.status(400).json({ error: "filePath is required" });
        return;
      }
      if (inputPath.includes("..") || inputPath.includes("\0")) {
        res.status(400).json({ error: "Invalid file path" });
        return;
      }

      const fs = await import("node:fs/promises");
      const pathMod = await import("node:path");

      // Verify file exists
      try {
        await fs.access(inputPath);
      } catch {
        res.status(404).json({ error: `File not found: ${inputPath}` });
        return;
      }

      const ext = pathMod.extname(inputPath).toLowerCase();
      let extractedText = "";
      const extractedImages: Array<{ path: string; description: string }> = [];

      // Extract text content using the converter registry
      const { createDefaultRegistry } = await import("../knowledge/converters/index.js");
      const registry = await createDefaultRegistry();

      if (registry.canConvert(inputPath)) {
        const result = await registry.convert(inputPath);
        if (result.success) {
          extractedText = result.text;
        } else {
          logger.warn(`[Director API] Inspiration file conversion failed: ${result.error}`);
        }
      } else {
        // For images, just read them directly
        const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"];
        if (imageExts.includes(ext)) {
          extractedImages.push({ path: inputPath, description: pathMod.basename(inputPath) });
          res.json({ text: "", images: extractedImages });
          return;
        }
        res.status(400).json({ error: `Unsupported file type: ${ext}` });
        return;
      }

      // For markdown files, extract referenced images
      if (ext === ".md" || ext === ".markdown") {
        const fileDir = pathMod.dirname(inputPath);
        const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = imgRegex.exec(extractedText)) !== null) {
          const altText = match[1] || "Image";
          const imgRef = match[2];
          // Resolve relative paths
          const imgPath = pathMod.isAbsolute(imgRef)
            ? imgRef
            : pathMod.resolve(fileDir, imgRef);
          try {
            await fs.access(imgPath);
            extractedImages.push({ path: imgPath, description: altText });
          } catch {
            logger.debug(`[Director API] Inspiration image not found: ${imgPath}`);
          }
        }
      }

      // For PDFs, extract embedded images using pdfimages (poppler).
      // Falls back to page rendering via ImageMagick if pdfimages is unavailable.
      if (ext === ".pdf") {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const osMod = await import("node:os");
        const imgDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
        await fs.mkdir(imgDir, { recursive: true });

        let hasPdfImages = false;
        try {
          await execFileAsync("pdfimages", ["-v"]);
          hasPdfImages = true;
        } catch {
          logger.debug("[Director API] pdfimages (poppler) not available");
        }

        if (hasPdfImages) {
          // Extract actual embedded images from the PDF
          const tmpDir = pathMod.join(osMod.tmpdir(), `openzigs-pdfimg-${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });
          try {
            const prefix = pathMod.join(tmpDir, "img");
            // -png renders all images as PNG; -j keeps JPEG images as JPEG
            await execFileAsync("pdfimages", ["-j", inputPath, prefix]);
            const tmpFiles = await fs.readdir(tmpDir);
            const imageFiles = tmpFiles
              .filter((f) => /\.(png|jpg|jpeg|ppm|pbm|tiff)$/i.test(f))
              .sort();

            // Filter out tiny images (icons, bullets, etc.) — keep only substantive ones
            let idx = 0;
            for (const imgFile of imageFiles) {
              const srcPath = pathMod.join(tmpDir, imgFile);
              const stat = await fs.stat(srcPath);
              // Skip images smaller than 5KB (likely icons/decorations)
              if (stat.size < 5120) continue;

              idx++;
              if (idx > 30) break; // Cap at 30 embedded images
              const outExt = pathMod.extname(imgFile).toLowerCase() === ".jpg" ? ".jpg" : ".png";
              const outName = `insp-pdf-embed-${Date.now()}-${idx}${outExt}`;
              const outPath = pathMod.join(imgDir, outName);

              // For PPM/PBM files, convert to PNG via ImageMagick if available
              if (/\.(ppm|pbm)$/i.test(imgFile)) {
                try {
                  await execFileAsync("magick", [srcPath, outPath]);
                } catch {
                  continue; // skip unconvertible formats
                }
              } else {
                await fs.copyFile(srcPath, outPath);
              }

              extractedImages.push({
                path: outPath,
                description: `Embedded image ${idx} from PDF`,
              });
            }
            if (extractedImages.length > 0) {
              logger.info(`[Director API] Extracted ${extractedImages.length} embedded image(s) from PDF via pdfimages`);
            }
          } catch (err) {
            logger.warn(`[Director API] pdfimages extraction failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        }

        // Fallback: if no embedded images found, render pages as screenshots
        if (extractedImages.length === 0) {
          let hasMagick = false;
          try {
            await execFileAsync("magick", ["--version"]);
            hasMagick = true;
          } catch {
            logger.debug("[Director API] ImageMagick not available for PDF page rendering");
          }

          if (hasMagick) {
            let pageCount = 0;
            try {
              const { stdout } = await execFileAsync("magick", ["identify", inputPath]);
              pageCount = stdout.trim().split("\n").length;
            } catch (err) {
              logger.warn(`[Director API] Failed to identify PDF pages: ${err instanceof Error ? err.message : String(err)}`);
            }

            if (pageCount > 0) {
              const maxPages = Math.min(pageCount, 10);
              for (let i = 0; i < maxPages; i++) {
                try {
                  const outName = `insp-pdf-${Date.now()}-page${i + 1}.png`;
                  const outPath = pathMod.join(imgDir, outName);
                  await execFileAsync("magick", [
                    "-density", "200",
                    "-quality", "90",
                    `${inputPath}[${i}]`,
                    "-flatten",
                    "-resize", "1536x1536>",
                    outPath,
                  ]);
                  extractedImages.push({
                    path: outPath,
                    description: `PDF page ${i + 1}`,
                  });
                } catch (err) {
                  logger.warn(`[Director API] PDF page ${i + 1} render failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              if (extractedImages.length > 0) {
                logger.info(`[Director API] Extracted ${extractedImages.length} page image(s) from PDF (fallback)`);
              }
            }
          }
        }
      }

      // For DOCX files, extract embedded images from the word/media/ directory
      if (ext === ".docx") {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const osMod = await import("node:os");
        const imgDir = pathMod.join(osMod.homedir(), ".openzigs", "director", "images");
        await fs.mkdir(imgDir, { recursive: true });

        const tmpDir = pathMod.join(osMod.tmpdir(), `openzigs-docximg-${Date.now()}`);
        await fs.mkdir(tmpDir, { recursive: true });
        try {
          // DOCX is a ZIP archive — extract word/media/* which contains embedded images
          await execFileAsync("unzip", ["-j", "-o", inputPath, "word/media/*", "-d", tmpDir]);
          const tmpFiles = await fs.readdir(tmpDir);
          const imageFiles = tmpFiles
            .filter((f) => /\.(png|jpg|jpeg|gif|bmp|tiff|emf|wmf|svg)$/i.test(f))
            .sort();

          let idx = 0;
          for (const imgFile of imageFiles) {
            const srcPath = pathMod.join(tmpDir, imgFile);
            const stat = await fs.stat(srcPath);
            // Skip tiny images (decorations/bullets) under 5KB
            if (stat.size < 5120) continue;
            // Skip EMF/WMF vector formats that can't be displayed as-is
            if (/\.(emf|wmf)$/i.test(imgFile)) continue;

            idx++;
            if (idx > 30) break;
            const outExt = pathMod.extname(imgFile).toLowerCase();
            const outName = `insp-docx-${Date.now()}-${idx}${outExt}`;
            const outPath = pathMod.join(imgDir, outName);
            await fs.copyFile(srcPath, outPath);

            extractedImages.push({
              path: outPath,
              description: `Embedded image ${idx} from document`,
            });
          }
          if (extractedImages.length > 0) {
            logger.info(`[Director API] Extracted ${extractedImages.length} embedded image(s) from DOCX`);
          }
        } catch (err) {
          // unzip returns exit code 11 if no matching files found — not an error
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("filename not matched")) {
            logger.debug(`[Director API] DOCX image extraction: ${msg}`);
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      // Use AI to generate descriptions for images that only have filenames
      if (extractedImages.length > 0) {
        const conversationId = `describe-inspiration-images-${Date.now()}`;
        try {
          const imageList = extractedImages.map((img, i) => `${i}: "${img.description}"`).join("\n");
          const descModel = await getUserSelectedModel();
          let descResponse = "";
          for await (const chunk of copilot.chat(
            `Given these image references from a document, write a concise visual description (1 sentence) for each that would be useful for a hero reel video. If the alt text is already descriptive, refine it. If it's just a filename, infer from context.\n\nImages:\n${imageList}\n\nDocument context (first 1000 chars):\n${extractedText.slice(0, 1000)}\n\nRespond with a JSON array of strings, one description per image. No markdown fences.`,
            { conversationId, tools: [], availableTools: [], ...(descModel ? { model: descModel } : {}) },
          )) {
            descResponse += chunk;
          }
          await copilot.destroySession(conversationId);

          const jsonMatch = descResponse.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const descriptions = JSON.parse(jsonMatch[0]) as string[];
            for (let i = 0; i < Math.min(descriptions.length, extractedImages.length); i++) {
              if (descriptions[i] && typeof descriptions[i] === "string") {
                extractedImages[i].description = descriptions[i];
              }
            }
          }
        } catch (descErr) {
          logger.warn(`[Director API] Image description generation failed: ${descErr instanceof Error ? descErr.message : String(descErr)}`);
        }
      }

      res.json({
        text: extractedText.slice(0, 8000),
        images: extractedImages.map((img) => ({
          ...img,
          url: `/api/admin/director/files/${pathMod.basename(img.path)}`,
        })),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /hero-reel/process-inspiration failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── YouTube Direct Publishing Pipeline ──────────────────────

  // Lazy-init YouTube publish service
  let _youtubePublishService: import("../video/youtube-publish-service.js").YouTubePublishService | null = null;

  async function getYouTubePublishService() {
    if (!_youtubePublishService) {
      const { YouTubePublishService } = await import("../video/youtube-publish-service.js");
      const { YouTubePublishRepository } = await import("../video/youtube-publish-repository.js");
      const publishRepo = new YouTubePublishRepository(getDatabase());
      _youtubePublishService = new YouTubePublishService({
        toolRegistry: toolRegistry!,
        publishRepo,
        io: _io,
        db: getDatabase(),
      });
    }
    return _youtubePublishService;
  }

  const youtubePublishSchema = z.object({
    draftId: z.string({ required_error: "draftId is required" }).min(1, "draftId is required"),
    filePath: z.string().optional(),
    title: z.string({ required_error: "title is required" }).min(1, "title is required").transform((s) => s.trim()),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    categoryId: z.string().optional(),
    privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
    notifySubscribers: z.boolean().optional(),
    scheduledPublishTime: z.string().optional(),
  });

  /** Allowed base directories for YouTube publish file paths. */
  const YOUTUBE_PUBLISH_ALLOWED_DIRS = [
    path.join(os.homedir(), ".openzigs", "video-output"),
    path.join(os.homedir(), ".openzigs", "renders"),
  ];

  /**
   * POST /youtube/publish — Start a YouTube publish job for a draft.
   * Body: { draftId, filePath?, title, description?, tags?, categoryId?, privacyStatus?, notifySubscribers?, scheduledPublishTime? }
   */
  router.post("/youtube/publish", async (req, res) => {
    try {
      if (!toolRegistry) {
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }

      const parsed = youtubePublishSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
        return;
      }

      const { draftId, filePath, title, description, tags, categoryId, privacyStatus, notifySubscribers, scheduledPublishTime } = parsed.data;

      // Path traversal guard: filePath must resolve to an allowed directory
      if (filePath) {
        const resolved = path.resolve(filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath);
        const allowed = YOUTUBE_PUBLISH_ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
        if (!allowed) {
          res.status(403).json({ error: "File path is outside allowed directories" });
          return;
        }
      }

      const service = await getYouTubePublishService();
      const result = await service.publish({
        draftId,
        filePath,
        title,
        description,
        tags,
        categoryId,
        privacyStatus,
        notifySubscribers,
        scheduledPublishTime,
      });

      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /youtube/publish failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /youtube/publish/:draftId/status — Check publish status for a draft.
   */
  router.get("/youtube/publish/:draftId/status", async (req, res) => {
    try {
      const service = await getYouTubePublishService();
      const status = service.getPublishStatus(req.params.draftId);
      if (!status) {
        res.json({ status: "none" });
        return;
      }
      res.json(status);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /youtube/publish status failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /youtube/publish/:publishId/check — Check if a published video still exists on YouTube.
   * If deleted, updates the publish status to "deleted".
   */
  router.post("/youtube/publish/:publishId/check", async (req, res) => {
    try {
      const service = await getYouTubePublishService();
      const result = await service.checkVideoExists(req.params.publishId);
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /youtube/publish check failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /youtube/publish/:draftId/history — Get all publish attempts for a draft.
   */
  router.get("/youtube/publish/:draftId/history", async (req, res) => {
    try {
      const service = await getYouTubePublishService();
      const history = service.getPublishHistory(req.params.draftId);
      res.json({ publishes: history });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /youtube/publish history failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /youtube/categories — Return YouTube video categories.
   */
  router.get("/youtube/categories", (_req, res) => {
    // Standard YouTube categories — these are stable and rarely change.
    res.json({
      categories: [
        { id: "1", name: "Film & Animation" },
        { id: "2", name: "Autos & Vehicles" },
        { id: "10", name: "Music" },
        { id: "15", name: "Pets & Animals" },
        { id: "17", name: "Sports" },
        { id: "19", name: "Travel & Events" },
        { id: "20", name: "Gaming" },
        { id: "22", name: "People & Blogs" },
        { id: "23", name: "Comedy" },
        { id: "24", name: "Entertainment" },
        { id: "25", name: "News & Politics" },
        { id: "26", name: "Howto & Style" },
        { id: "27", name: "Education" },
        { id: "28", name: "Science & Technology" },
        { id: "29", name: "Nonprofits & Activism" },
      ],
    });
  });

  /**
   * POST /youtube/generate-metadata — LLM SEO metadata generation for YouTube.
   * Body: { draftId }
   * Returns: { title, description, tags, suggestedCategory }
   */
  router.post("/youtube/generate-metadata", async (req, res) => {
    try {
      const { draftId, model: bodyModel } = req.body as { draftId?: string; model?: string };

      if (!draftId || typeof draftId !== "string") {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

      const db = getDatabase();
      const row = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`).get(draftId) as {
        title: string;
        manifest: string;
      } | undefined;

      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        // non-fatal
      }

      // Extract narration text and scene descriptions from the manifest
      const timeline = Array.isArray(manifest.timeline) ? manifest.timeline : [];
      const narrationParts: string[] = [];
      const sceneDescriptions: string[] = [];
      for (const entry of timeline) {
        if (entry.scriptText) narrationParts.push(entry.scriptText);
        if (entry.title) sceneDescriptions.push(entry.title);
      }

      // Generate chapter text for context
      const { generateChapters, formatChaptersForDescription } = await import("../video/youtube-chapters.js");
      const chapters = generateChapters(manifest as import("../video/youtube-chapters.js").ManifestForChapters);
      const chapterText = formatChaptersForDescription(chapters);

      const seoModel = bodyModel || await getUserSelectedModel();
      const prompt = `You are a YouTube SEO expert. Given the following video content, generate optimized YouTube metadata.

VIDEO TITLE: "${row.title}"
PROJECT TITLE: "${manifest.projectTitle ?? row.title}"

NARRATION/SCRIPT:
${narrationParts.join("\n").slice(0, 2000) || "(no narration)"}

SCENE DESCRIPTIONS:
${sceneDescriptions.join(", ").slice(0, 500) || "(no scene descriptions)"}

Generate the following as JSON (and ONLY JSON, no markdown fences):
{
  "title": "Optimized YouTube title (under 100 chars, engaging, with key SEO terms)",
  "description": "SEO-friendly description (200-500 words, include relevant hashtags at the end, natural keyword density). ${chapterText ? "Include these chapter timestamps at the beginning:\\n" + chapterText : ""}",
  "tags": ["array", "of", "relevant", "tags", "up to 20 tags, total under 500 characters"],
  "suggestedCategory": "One of: Film & Animation, Education, Science & Technology, Entertainment, Howto & Style, People & Blogs, Music, Gaming, News & Politics, Comedy"
}`;

      const stream = copilot.chat(prompt, { tools: [], ...(seoModel ? { model: seoModel } : {}) });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const rawResponse = chunks.join("").trim();

      // Parse JSON from the response, handling potential markdown fences
      let parsed: Record<string, unknown>;
      try {
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        res.status(500).json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      // Validate and sanitize the response
      const generatedTitle = typeof parsed.title === "string" ? parsed.title.slice(0, 100) : row.title;
      const generatedDescription = typeof parsed.description === "string" ? parsed.description.slice(0, 5000) : "";
      const generatedTags = Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string").slice(0, 30) : [];
      const suggestedCategory = typeof parsed.suggestedCategory === "string" ? parsed.suggestedCategory : "Education";

      res.json({
        title: generatedTitle,
        description: generatedDescription,
        tags: generatedTags,
        suggestedCategory,
        chapters: chapterText || null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /youtube/generate-metadata failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Brand Kit CRUD (Issue #523) ────────────────────────

  router.get("/brand-kits", (_req, res) => {
    try {
      const repo = new BrandKitRepository(getDatabase());
      res.json({ brandKits: repo.getAll() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /brand-kits failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/brand-kits/:id", (req, res) => {
    try {
      
      const repo = new BrandKitRepository(getDatabase());
      const kit = repo.getById(req.params.id);
      if (!kit) { res.status(404).json({ error: "Brand kit not found" }); return; }
      res.json(kit);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /brand-kits/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/brand-kits", (req, res) => {
    try {
      const { name, primaryColor, secondaryColor, accentColor, fontFamily, logoPath, watermarkPath, introTemplateId, outroTemplateId } = req.body as Record<string, string | null | undefined>;
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      
      const repo = new BrandKitRepository(getDatabase());
      const id = nanoid();
      const kit = repo.create({
        id,
        name: name.trim(),
        primaryColor: (primaryColor as string) || "#000000",
        secondaryColor: (secondaryColor as string) || "#ffffff",
        accentColor: (accentColor as string) || "#0066ff",
        fontFamily: (fontFamily as string) || "Inter",
        logoPath: (logoPath as string) || null,
        watermarkPath: (watermarkPath as string) || null,
        introTemplateId: (introTemplateId as string) || null,
        outroTemplateId: (outroTemplateId as string) || null,
      });
      res.status(201).json(kit);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /brand-kits failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.put("/brand-kits/:id", (req, res) => {
    try {
      const brandKitUpdateSchema = z.object({
        name: z.string().min(1).optional(),
        primaryColor: z.string().optional(),
        secondaryColor: z.string().optional(),
        accentColor: z.string().optional(),
        fontFamily: z.string().optional(),
        logoPath: z.string().nullable().optional(),
        watermarkPath: z.string().nullable().optional(),
        introTemplateId: z.string().nullable().optional(),
        outroTemplateId: z.string().nullable().optional(),
      }).strict();
      const parsed = brandKitUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid fields", details: parsed.error.flatten().fieldErrors });
        return;
      }
      const repo = new BrandKitRepository(getDatabase());
      const updated = repo.update(req.params.id, parsed.data);
      if (!updated) { res.status(404).json({ error: "Brand kit not found" }); return; }
      res.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] PUT /brand-kits/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/brand-kits/:id", (req, res) => {
    try {
      
      const repo = new BrandKitRepository(getDatabase());
      const deleted = repo.delete(req.params.id);
      if (!deleted) { res.status(404).json({ error: "Brand kit not found" }); return; }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] DELETE /brand-kits/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Batch Render Queue (Issue #522) ────────────────────

  router.post("/render/batch", async (req, res) => {
    try {
      const { draftIds } = req.body as { draftIds?: string[] };
      if (!Array.isArray(draftIds) || draftIds.length === 0) {
        res.status(400).json({ error: "draftIds array is required" });
        return;
      }

      const db = getDatabase();
      const results: Array<{ draftId: string; jobId?: string; error?: string }> = [];

      // Process sequentially to avoid overwhelming the render queue
      for (const draftId of draftIds) {
        try {
          const row = db.prepare(`SELECT id, manifest FROM director_drafts WHERE id = ?`).get(draftId) as {
            id: string;
            manifest: string;
          } | undefined;

          if (!row) { results.push({ draftId, error: "Draft not found" }); continue; }

          let manifest: Record<string, unknown>;
          try {
            manifest = JSON.parse(row.manifest);
          } catch {
            results.push({ draftId, error: "Corrupt manifest" }); continue;
          }

          if (!renderOrchestrator) { results.push({ draftId, error: "Render orchestrator not available" }); continue; }

          const jobId = nanoid();
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
             VALUES (?, ?, ?, 'standard', 'queued', ?, ?)`,
          ).run(nanoid(), draftId, jobId, now, now);

          await renderOrchestrator.submit({
            manifest: manifest as never,
          });

          results.push({ draftId, jobId });
        } catch (err) {
          results.push({ draftId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const completed = results.filter((r) => r.jobId).length;
      const failed = results.filter((r) => r.error).length;
      res.json({ total: draftIds.length, queued: completed, failed, results });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /render/batch failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Gallery Collections & Tags (Issue #520) ────────────

  router.get("/gallery/collections", (_req, res) => {
    try {
      const db = getDatabase();
      ensureGalleryTables(db);
      const rows = db.prepare(`SELECT * FROM gallery_collections ORDER BY name ASC`).all() as Array<{
        id: string; name: string; description: string; created_at: string;
      }>;
      res.json({ collections: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at })) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/collections", (req, res) => {
    try {
      const { name, description } = req.body as { name?: string; description?: string };
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" }); return;
      }
      const db = getDatabase();
      ensureGalleryTables(db);
      const id = nanoid();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO gallery_collections (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(id, name.trim(), (description || "").trim(), now);
      res.status(201).json({ id, name: name.trim(), description: (description || "").trim(), createdAt: now });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.put("/gallery/collections/:id", (req, res) => {
    try {
      const { name, description } = req.body as { name?: string; description?: string };
      const db = getDatabase();
      ensureGalleryTables(db);
      const existing = db.prepare(`SELECT id FROM gallery_collections WHERE id = ?`).get(req.params.id);
      if (!existing) { res.status(404).json({ error: "Collection not found" }); return; }
      const sets: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) { sets.push("name = ?"); values.push(name.trim()); }
      if (description !== undefined) { sets.push("description = ?"); values.push(description.trim()); }
      if (sets.length > 0) {
        values.push(req.params.id);
        db.prepare(`UPDATE gallery_collections SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/gallery/collections/:id", (req, res) => {
    try {
      const db = getDatabase();
      ensureGalleryTables(db);
      db.prepare(`DELETE FROM gallery_collection_items WHERE collection_id = ?`).run(req.params.id);
      const result = db.prepare(`DELETE FROM gallery_collections WHERE id = ?`).run(req.params.id);
      if (result.changes === 0) { res.status(404).json({ error: "Collection not found" }); return; }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/collections/:id/items", (req, res) => {
    try {
      const { assetPath } = req.body as { assetPath?: string };
      if (!assetPath) { res.status(400).json({ error: "assetPath is required" }); return; }
      const db = getDatabase();
      ensureGalleryTables(db);
      db.prepare(`INSERT OR IGNORE INTO gallery_collection_items (collection_id, asset_path) VALUES (?, ?)`).run(req.params.id, assetPath);
      res.status(201).json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/gallery/collections/:id/items", (req, res) => {
    try {
      const { assetPath } = req.body as { assetPath?: string };
      if (!assetPath) { res.status(400).json({ error: "assetPath is required" }); return; }
      const db = getDatabase();
      ensureGalleryTables(db);
      db.prepare(`DELETE FROM gallery_collection_items WHERE collection_id = ? AND asset_path = ?`).run(req.params.id, assetPath);
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/gallery/collections/:id/items", (req, res) => {
    try {
      const db = getDatabase();
      ensureGalleryTables(db);
      const rows = db.prepare(`SELECT asset_path FROM gallery_collection_items WHERE collection_id = ?`).all(req.params.id) as Array<{ asset_path: string }>;
      res.json({ items: rows.map((r) => r.asset_path) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/tags", (req, res) => {
    try {
      const { assetPath, tag } = req.body as { assetPath?: string; tag?: string };
      if (!assetPath || !tag) { res.status(400).json({ error: "assetPath and tag are required" }); return; }
      const db = getDatabase();
      ensureGalleryTables(db);
      db.prepare(`INSERT OR IGNORE INTO gallery_tags (asset_path, tag) VALUES (?, ?)`).run(assetPath, tag.trim().toLowerCase());
      res.status(201).json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/gallery/tags", (req, res) => {
    try {
      const { assetPath, tag } = req.body as { assetPath?: string; tag?: string };
      if (!assetPath || !tag) { res.status(400).json({ error: "assetPath and tag are required" }); return; }
      const db = getDatabase();
      ensureGalleryTables(db);
      db.prepare(`DELETE FROM gallery_tags WHERE asset_path = ? AND tag = ?`).run(assetPath, tag.trim().toLowerCase());
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/gallery/tags", (req, res) => {
    try {
      const db = getDatabase();
      ensureGalleryTables(db);
      const assetPath = typeof req.query.assetPath === "string" ? req.query.assetPath : undefined;
      const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
      if (assetPath) {
        const rows = db.prepare(`SELECT tag FROM gallery_tags WHERE asset_path = ?`).all(assetPath) as Array<{ tag: string }>;
        res.json({ tags: rows.map((r) => r.tag) });
      } else if (tag) {
        const rows = db.prepare(`SELECT asset_path FROM gallery_tags WHERE tag = ?`).all(tag.trim().toLowerCase()) as Array<{ asset_path: string }>;
        res.json({ assets: rows.map((r) => r.asset_path) });
      } else {
        const rows = db.prepare(`SELECT tag, COUNT(*) as count FROM gallery_tags GROUP BY tag ORDER BY count DESC, tag ASC`).all() as Array<{ tag: string; count: number }>;
        res.json({ tags: rows });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── YouTube Analytics Proxy with SQLite cache (Issue #518) ───────────────

  // Ensure cache table exists (idempotent)
  {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_analytics_cache (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
  }

  function getAnalyticsCache(key: string): { data: unknown; fetchedAt: Date } | null {
    try {
      const db = getDatabase();
      const row = db
        .prepare(`SELECT data, fetched_at FROM youtube_analytics_cache WHERE key = ?`)
        .get(key) as { data: string; fetched_at: number } | undefined;
      if (!row) return null;
      return { data: JSON.parse(row.data), fetchedAt: new Date(row.fetched_at) };
    } catch {
      return null;
    }
  }

  function setAnalyticsCache(key: string, data: unknown): void {
    try {
      const db = getDatabase();
      db.prepare(
        `INSERT OR REPLACE INTO youtube_analytics_cache (key, data, fetched_at) VALUES (?, ?, ?)`
      ).run(key, JSON.stringify(data), Date.now());
    } catch {
      // Non-fatal — cache write failure shouldn't break the response
    }
  }

  router.get("/youtube/analytics/channel", async (_req, res) => {
    const CACHE_KEY = "channel";
    try {
      if (!toolRegistry) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }
      // Use channel-info tool (returns snippet + statistics) instead of channel-analytics (stats only)
      const tool = toolRegistry.getToolDefinition("youtube-get-channel-info");
      if (!tool) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(503).json({ error: "youtube-get-channel-info tool not registered" });
        return;
      }
      let data: unknown;
      try {
        const result = await tool.handler({});
        if (result.isError) throw new Error(result.text);
        const raw = JSON.parse(result.text);
        // YouTube Data API wraps response in {success, data: {items: [...]}} via MCP wrapper
        const payload = raw?.data ?? raw;
        const items = payload?.items ?? [];
        const ch = items[0];
        if (!ch) throw new Error("No channel found");
        const snippet = ch.snippet ?? {};
        const stats = ch.statistics ?? {};
        data = {
          channelId: ch.id ?? "",
          title: snippet.title ?? "",
          description: snippet.description ?? "",
          subscriberCount: Number(stats.subscriberCount ?? 0),
          viewCount: Number(stats.viewCount ?? 0),
          videoCount: Number(stats.videoCount ?? 0),
          thumbnailUrl: snippet.thumbnails?.default?.url ?? snippet.thumbnails?.medium?.url ?? "",
        };
        setAnalyticsCache(CACHE_KEY, data);
      } catch (liveErr) {
        const msg = liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn(`[Director API] YouTube channel analytics live fetch failed: ${msg} — falling back to cache`);
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(502).json({ error: msg });
        return;
      }
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /youtube/analytics/channel failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/youtube/analytics/videos", async (req, res) => {
    const maxResults = typeof req.query.maxResults === "string" ? req.query.maxResults : undefined;
    const limit = typeof req.query.limit === "string" ? req.query.limit : undefined;
    const max = parseInt(maxResults ?? limit ?? "50", 10) || 50;
    const CACHE_KEY = `videos:${max}`;
    try {
      if (!toolRegistry) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }
      const listTool = toolRegistry.getToolDefinition("youtube-get-channel-videos");
      const detailTool = toolRegistry.getToolDefinition("youtube-get-video-details");
      if (!listTool) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(503).json({ error: "youtube-get-channel-videos tool not registered" });
        return;
      }
      let data: unknown;
      try {
        // Step 1: Get video list from channel
        const listResult = await listTool.handler({ max_results: max });
        if (listResult.isError) throw new Error(listResult.text);
        const listRaw = JSON.parse(listResult.text);
        const listPayload = listRaw?.data ?? listRaw;
        const searchItems = listPayload?.items ?? [];
        // Extract video IDs from search results
        const videoIds: string[] = searchItems
          .map((item: Record<string, unknown>) => {
            const id = item.id as Record<string, unknown> | string | undefined;
            if (typeof id === "string") return id;
            if (id && typeof id === "object") return (id as Record<string, string>).videoId;
            return undefined;
          })
          .filter(Boolean) as string[];

        if (videoIds.length === 0) {
          data = { videos: [] };
        } else if (detailTool) {
          // Step 2: Get detailed stats for each video (batch by calling with comma-separated IDs or one-by-one)
          const videos: Record<string, unknown>[] = [];
          // Call details for each video individually (the Python tool takes a single video_id)
          const detailPromises = videoIds.map(async (vid) => {
            try {
              const r = await detailTool.handler({ video_id: vid });
              if (r.isError) return null;
              const d = JSON.parse(r.text);
              const dp = d?.data ?? d;
              const items = dp?.items ?? [];
              return items[0] ?? null;
            } catch {
              return null;
            }
          });
          const detailResults = await Promise.all(detailPromises);
          for (const item of detailResults) {
            if (!item) continue;
            const snippet = (item as Record<string, unknown>).snippet as Record<string, unknown> | undefined ?? {};
            const stats = (item as Record<string, unknown>).statistics as Record<string, unknown> | undefined ?? {};
            const contentDetails = (item as Record<string, unknown>).contentDetails as Record<string, unknown> | undefined ?? {};
            videos.push({
              videoId: (item as Record<string, string>).id ?? "",
              title: (snippet as Record<string, string>).title ?? "",
              publishedAt: (snippet as Record<string, string>).publishedAt ?? "",
              viewCount: Number((stats as Record<string, string>).viewCount ?? 0),
              likeCount: Number((stats as Record<string, string>).likeCount ?? 0),
              commentCount: Number((stats as Record<string, string>).commentCount ?? 0),
              duration: (contentDetails as Record<string, string>).duration ?? "",
              thumbnailUrl: ((snippet as Record<string, Record<string, Record<string, string>>>).thumbnails?.medium?.url) ?? "",
              likeRatio: Number((stats as Record<string, string>).likeCount ?? 0) > 0
                ? Number((stats as Record<string, string>).likeCount ?? 0) /
                  (Number((stats as Record<string, string>).likeCount ?? 0) + Number((stats as Record<string, string>).dislikeCount ?? 0) || 1)
                : 0,
            });
          }
          data = { videos };
        } else {
          // No detail tool — return basic info from search results
          const videos = searchItems.map((item: Record<string, unknown>) => {
            const snippet = item.snippet as Record<string, unknown> | undefined ?? {};
            const id = item.id as Record<string, unknown> | string | undefined;
            const videoId = typeof id === "string" ? id : (id as Record<string, string>)?.videoId ?? "";
            return {
              videoId,
              title: (snippet as Record<string, string>).title ?? "",
              publishedAt: (snippet as Record<string, string>).publishedAt ?? "",
              viewCount: 0, likeCount: 0, commentCount: 0,
              duration: "", thumbnailUrl: ((snippet as Record<string, Record<string, Record<string, string>>>).thumbnails?.medium?.url) ?? "",
              likeRatio: 0,
            };
          });
          data = { videos };
        }
        setAnalyticsCache(CACHE_KEY, data);
      } catch (liveErr) {
        const msg = liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn(`[Director API] YouTube videos analytics live fetch failed: ${msg} — falling back to cache`);
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({ ...cached.data as object, _cached: true, _cachedAt: cached.fetchedAt.toISOString() });
          return;
        }
        res.status(502).json({ error: msg });
        return;
      }
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /youtube/analytics/videos failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Shorts from Manifest (Issue #519) ──────────────────

  router.post("/shorts/from-manifest", async (req, res) => {
    try {
      const { draftId, maxClips } = req.body as { draftId?: string; maxClips?: number };
      if (!draftId || typeof draftId !== "string") {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

      const db = getDatabase();
      const row = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`).get(draftId) as {
        title: string;
        manifest: string;
      } | undefined;

      if (!row) { res.status(404).json({ error: "Draft not found" }); return; }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt manifest" }); return;
      }

      const timeline = Array.isArray(manifest.timeline) ? manifest.timeline : [];
      if (timeline.length === 0) {
        res.status(400).json({ error: "Manifest has no timeline scenes" }); return;
      }

      // Use LLM to identify most engaging segments
      const sceneDescriptions = timeline.map((s: Record<string, unknown>, i: number) => {
        const text = (s.scriptText as string) || (s.title as string) || `Scene ${i + 1}`;
        const dur = typeof s.duration === "number" ? s.duration : 5000;
        return `[${i}] (${Math.round(dur < 1000 ? dur : dur / 1000)}s) ${text.slice(0, 200)}`;
      }).join("\n");

      const limit = Math.min(maxClips || 3, 5);
      const prompt = `You are a viral content strategist. Analyze these video scenes and select up to ${limit} segments that would make the most engaging YouTube Shorts (max 60 seconds each).

SCENES:
${sceneDescriptions}

For each Short, respond with JSON only (no markdown fences):
[
  {
    "startSceneIndex": 0,
    "endSceneIndex": 2,
    "title": "Hook title for the Short",
    "hookText": "Opening hook text overlay",
    "ctaText": "Call to action text",
    "reason": "Why this segment is engaging"
  }
]`;

      const seoModel = await getUserSelectedModel();
      const stream = copilot.chat(prompt, { tools: [], ...(seoModel ? { model: seoModel } : {}) });
      const chunks: string[] = [];
      for await (const chunk of stream) { chunks.push(chunk); }

      const rawResponse = chunks.join("").trim();
      let suggestions: Array<{
        startSceneIndex: number;
        endSceneIndex: number;
        title: string;
        hookText: string;
        ctaText: string;
        reason: string;
      }>;

      try {
        const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array found");
        suggestions = JSON.parse(jsonMatch[0]);
      } catch {
        res.status(500).json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      // Validate and enrich suggestions
      const enriched = suggestions.slice(0, limit).map((s) => {
        const startIdx = Math.max(0, Math.min(s.startSceneIndex, timeline.length - 1));
        const endIdx = Math.max(startIdx, Math.min(s.endSceneIndex, timeline.length - 1));
        const scenes = timeline.slice(startIdx, endIdx + 1);
        const totalDurationMs = scenes.reduce((acc: number, sc: Record<string, unknown>) => {
          const d = typeof sc.duration === "number" ? sc.duration : 5000;
          return acc + (d < 1000 ? d * 1000 : d);
        }, 0);

        return {
          ...s,
          startSceneIndex: startIdx,
          endSceneIndex: endIdx,
          sceneCount: scenes.length,
          estimatedDurationMs: totalDurationMs,
          cropConfig: { aspectRatio: "9:16", width: 1080, height: 1920 },
        };
      });

      res.json({ suggestions: enriched, totalScenes: timeline.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /shorts/from-manifest failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Shorts Propose & Render (UI-facing routes for Issue #519) ──────

  /**
   * POST /drafts/:draftId/shorts/propose — Analyze a draft's manifest and propose
   * engaging Short segments via LLM.
   * Body: { maxShorts?: number }
   * Response: { proposals: ShortProposal[] }
   */
  router.post("/drafts/:draftId/shorts/propose", async (req, res) => {
    try {
      const { draftId } = req.params;
      const { maxShorts } = req.body as { maxShorts?: number };

      const db = getDatabase();
      const row = db.prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`).get(draftId) as {
        title: string;
        manifest: string;
      } | undefined;

      if (!row) { res.status(404).json({ error: "Draft not found" }); return; }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt manifest" }); return;
      }

      const timeline = Array.isArray(manifest.timeline) ? manifest.timeline : [];
      if (timeline.length === 0) {
        res.status(400).json({ error: "Manifest has no timeline scenes" }); return;
      }

      // Build cumulative start/end times for each scene
      let cumulativeMs = 0;
      const sceneTimes = timeline.map((s: Record<string, unknown>) => {
        const dur = typeof s.duration === "number" ? (s.duration < 1000 ? s.duration * 1000 : s.duration) : 5000;
        const start = cumulativeMs;
        cumulativeMs += dur;
        return { startMs: start, endMs: cumulativeMs, durationMs: dur };
      });

      const sceneDescriptions = timeline.map((s: Record<string, unknown>, i: number) => {
        const text = (s.scriptText as string) || (s.title as string) || `Scene ${i + 1}`;
        return `[${i}] (${Math.round(sceneTimes[i].durationMs / 1000)}s) ${text.slice(0, 200)}`;
      }).join("\n");

      const limit = Math.min(maxShorts || 3, 5);
      const prompt = `You are a viral content strategist. Analyze these video scenes and select up to ${limit} segments that would make the most engaging YouTube Shorts (max 60 seconds each).

SCENES:
${sceneDescriptions}

For each Short, respond with JSON only (no markdown fences):
[
  {
    "startSceneIndex": 0,
    "endSceneIndex": 2,
    "title": "Hook title for the Short",
    "hookText": "Opening hook text overlay",
    "ctaText": "Call to action text",
    "reason": "Why this segment is engaging",
    "score": 85
  }
]`;

      const seoModel = await getUserSelectedModel();
      const stream = copilot.chat(prompt, { tools: [], ...(seoModel ? { model: seoModel } : {}) });
      const chunks: string[] = [];
      for await (const chunk of stream) { chunks.push(chunk); }

      const rawResponse = chunks.join("").trim();
      let suggestions: Array<{
        startSceneIndex: number;
        endSceneIndex: number;
        title: string;
        hookText: string;
        ctaText: string;
        reason: string;
        score?: number;
      }>;

      try {
        const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array found");
        suggestions = JSON.parse(jsonMatch[0]);
      } catch {
        res.status(500).json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      // Map to the shape the UI expects: { startTime, endTime, title, hookText, ctaText, score, reason }
      const proposals = suggestions.slice(0, limit).map((s) => {
        const startIdx = Math.max(0, Math.min(s.startSceneIndex, timeline.length - 1));
        const endIdx = Math.max(startIdx, Math.min(s.endSceneIndex, timeline.length - 1));
        return {
          startTime: sceneTimes[startIdx].startMs / 1000,
          endTime: sceneTimes[endIdx].endMs / 1000,
          title: s.title,
          hookText: s.hookText,
          ctaText: s.ctaText,
          score: typeof s.score === "number" ? s.score : 80,
          reason: s.reason,
        };
      });

      res.json({ proposals });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /drafts/:draftId/shorts/propose failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:draftId/shorts/render — Accept selected Short segments and
   * create new Short drafts + queue them for rendering.
   * Body: { segments: Array<{ startTime, endTime, title, hookText, ctaText, burnSubtitles? }> }
   * Response: { jobIds: string[] }
   */
  router.post("/drafts/:draftId/shorts/render", async (req, res) => {
    try {
      const { draftId } = req.params;
      const segmentSchema = z.object({
        startTime: z.number(),
        endTime: z.number(),
        title: z.string(),
        hookText: z.string().optional().default(""),
        ctaText: z.string().optional().default(""),
        burnSubtitles: z.boolean().optional().default(false),
      });
      const bodySchema = z.object({
        segments: z.array(segmentSchema).min(1, "At least one segment is required"),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
        return;
      }

      const db = getDatabase();
      const parentDraft = db.prepare(`SELECT id, title, manifest FROM director_drafts WHERE id = ?`).get(draftId) as {
        id: string; title: string; manifest: string;
      } | undefined;

      if (!parentDraft) { res.status(404).json({ error: "Parent draft not found" }); return; }

      let parentManifest: Record<string, unknown>;
      try {
        parentManifest = JSON.parse(parentDraft.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt parent manifest" }); return;
      }

      const jobIds: string[] = [];

      for (const seg of parsed.data.segments) {
        const shortDraftId = nanoid();
        const jobId = nanoid();
        const now = new Date().toISOString();

        // Create a Shorts manifest from the segment
        const shortsManifest = {
          ...parentManifest,
          projectTitle: seg.title,
          composition: {
            ...(parentManifest.composition as Record<string, unknown> || {}),
            width: 1080,
            height: 1920,
          },
          shortsMetadata: {
            parentDraftId: draftId,
            startTime: seg.startTime,
            endTime: seg.endTime,
            hookText: seg.hookText,
            ctaText: seg.ctaText,
            burnSubtitles: seg.burnSubtitles,
          },
        };

        db.prepare(
          `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
        ).run(shortDraftId, seg.title, JSON.stringify(shortsManifest), null, "shorts", now, now);

        db.prepare(
          `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
           VALUES (?, ?, ?, 'standard', 'queued', ?, ?)`,
        ).run(nanoid(), shortDraftId, jobId, now, now);

        if (renderOrchestrator) {
          await renderOrchestrator.submit({ manifest: shortsManifest as never });
        }

        jobIds.push(jobId);
      }

      logger.info(`[Director API] Queued ${jobIds.length} Short render(s) from draft ${draftId}`);
      res.json({ jobIds });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] POST /drafts/:draftId/shorts/render failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
