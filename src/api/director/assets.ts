/**
 * Director — Assets / Files / Gallery / Brand-Kit Routes
 *
 * Extracted from `src/api/director.ts` as the first slice of the #1113 split
 * (sub-issue #1165). All handlers are moved VERBATIM — only mechanical
 * transforms have been applied:
 *   - closure references to `runtimeConfig`, `getAssetManager`,
 *     `probeVideoInfo`, `ensureGalleryTables`, `copilot`, `config` are
 *     prefixed with `ctx.`
 *   - module-imported helpers (`nanoid`, `logger`, `getDatabase`,
 *     `BrandKitRepository`, `z`, `path`, `raw`) are re-imported here
 *
 * No route paths, request schemas, response shapes, status codes, validation
 * order, or error messages have changed. The route-equivalence snapshot test
 * in `src/api/director.routes.test.ts` is the regression gate.
 *
 * Routes registered (26):
 *   Assets (10):  POST /assets/search, POST /assets/download,
 *                 GET /assets/local, POST /assets/upload,
 *                 POST /files/upload, POST /files/upload-asset,
 *                 POST /assets/placement, POST /assets/overlay,
 *                 GET /files/:fileName, DELETE /assets/:id
 *   Ingest (1):   POST /assets/ingest
 *   Brand-kits (5): GET, GET /:id, POST, PUT /:id, DELETE /:id
 *   Gallery (10): GET/POST/PUT/DELETE /gallery/collections[/...],
 *                 GET/POST/DELETE /gallery/collections/:id/items,
 *                 GET/POST/DELETE /gallery/tags
 */

import path from "node:path";
import { Router, raw } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logger } from "../../logging/logger.js";
import { getDatabase } from "../../productivity/database.js";
import { BrandKitRepository } from "../../video/brand-kit.js";
import type { DirectorContext } from "./context.js";

export function registerAssetRoutes(
  router: Router,
  ctx: DirectorContext,
): void {
  // ── Assets ─────────────────────────────────────────────────

  /**
   * POST /assets/search — search for music & sound effects.
   * Body: { query, source?, type?, minDuration?, maxDuration?, page?, perPage? }
   */
  router.post("/assets/search", async (req, res) => {
    try {
      const { query, source, type, minDuration, maxDuration, page, perPage } =
        req.body as {
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

      const manager = await ctx.getAssetManager();
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

      const manager = await ctx.getAssetManager();
      const assetType =
        source === "pexels" ? ("image" as const) : ("music" as const);
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
        license:
          source === "pixabay"
            ? "Pixabay License"
            : source === "pexels"
              ? "Pexels License"
              : "Creative Commons",
      });

      res.json({
        success: true,
        filePath: result.filePath,
        asset: result.asset,
      });
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
      const manager = await ctx.getAssetManager();
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
      const {
        filePath: srcPath,
        name,
        type,
      } = req.body as {
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
      const allowedRoots = [homeDir, pathMod.resolve(ctx.config.outputDir)];
      const normalizedResolved = pathMod.resolve(resolved);
      if (
        !allowedRoots.some(
          (root) =>
            normalizedResolved.startsWith(root + pathMod.sep) ||
            normalizedResolved === root,
        )
      ) {
        res.status(403).json({
          error: "Access denied: file path is outside allowed directories",
        });
        return;
      }

      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: `File not found: ${resolved}` });
        return;
      }

      // Copy to local library
      const fileName = name ?? pathMod.basename(resolved);
      const destDir = ctx.config.assets.localLibraryPath;
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
  router.post(
    "/files/upload",
    raw({ type: "*/*", limit: "2gb" }),
    async (req, res) => {
      try {
        const rawKind = req.query.kind;
        const kind = typeof rawKind === "string" ? rawKind : "video";
        if (kind !== "video" && kind !== "audio" && kind !== "script") {
          res
            .status(400)
            .json({ error: "kind must be one of: video, audio, script" });
          return;
        }

        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res
            .status(400)
            .json({ error: "request body must contain file bytes" });
          return;
        }
        // Re-bind as a typed local after guard to clarify to static analyzers
        // that this is a validated Buffer, not raw user input.
        const body = Buffer.from(rawBody);

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

        const safeName = pathMod
          .basename(decodedName)
          .replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = safeName.length > 0 ? safeName : "upload.bin";
        const targetDir =
          kind === "audio"
            ? ctx.config.assets.localLibraryPath
            : pathMod.join(
                ctx.config.outputDir,
                "uploads",
                kind === "video" ? "videos" : "scripts",
              );

        await fs.mkdir(targetDir, { recursive: true });

        const uniqueName = `${Date.now()}-${fileName}`;
        const filePath = pathMod.join(targetDir, uniqueName);
        await fs.writeFile(filePath, body);

        const mimeType = String(
          req.header("x-file-type") || "application/octet-stream",
        );
        logger.info(
          `[Director API] Uploaded ${kind} file: ${filePath} (${body.byteLength} bytes)`,
        );

        res.json({
          success: true,
          kind,
          filePath,
          fileName: uniqueName,
          size: body.byteLength,
          mimeType,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Director API] POST /files/upload failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    },
  );

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
  router.post(
    "/files/upload-asset",
    raw({ type: "*/*", limit: "500mb" }),
    async (req, res) => {
      try {
        const rawKind = req.query.kind;
        const kind = typeof rawKind === "string" ? rawKind : "image";
        if (kind !== "image" && kind !== "video") {
          res.status(400).json({ error: "kind must be 'image' or 'video'" });
          return;
        }

        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res
            .status(400)
            .json({ error: "request body must contain file bytes" });
          return;
        }
        // Re-bind as a typed local after guard to clarify to static analyzers
        // that this is a validated Buffer, not raw user input.
        const body = Buffer.from(rawBody);

        const fs = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const osMod = await import("node:os");

        const rawName = String(req.header("x-file-name") || "asset.bin");
        let decodedName: string;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          decodedName = rawName;
        }
        const safeName = pathMod
          .basename(decodedName)
          .replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = safeName || "asset.bin";
        const uniqueName = `${Date.now()}-${fileName}`;

        const targetDir = pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "uploads",
          "visual",
        );
        await fs.mkdir(targetDir, { recursive: true });
        const filePath = pathMod.join(targetDir, uniqueName);
        await fs.writeFile(filePath, body);

        logger.info(
          `[Director API] Uploaded ${kind} overlay asset: ${filePath} (${body.byteLength} bytes)`,
        );

        // For video uploads, probe for duration and dimensions
        let videoInfo: {
          durationSec: number;
          width: number;
          height: number;
        } | null = null;
        if (kind === "video") {
          videoInfo = await ctx.probeVideoInfo(filePath);
        }

        res.json({
          success: true,
          kind,
          filePath,
          fileName: uniqueName,
          size: body.byteLength,
          videoInfo,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Director API] POST /files/upload-asset failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    },
  );

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
        res
          .status(400)
          .json({ error: "assets array is required and must not be empty" });
        return;
      }
      if (typeof videoDurationSec !== "number" || videoDurationSec <= 0) {
        res
          .status(400)
          .json({ error: "videoDurationSec must be a positive number" });
        return;
      }
      if (assets.length > 20) {
        res
          .status(400)
          .json({ error: "Maximum 20 assets per placement request" });
        return;
      }

      const assetList = assets
        .map(
          (a, i) =>
            `  ${i + 1}. ID: ${a.id} | Description: ${a.description ?? path.basename(a.path)}`,
        )
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

      const resolvedModel =
        model || ctx.runtimeConfig.defaultModel || undefined;
      const stream = ctx.copilot.chat(placementPrompt, {
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
        const rawJson = responseText
          .replace(/```(?:json)?\s*/gi, "")
          .replace(/```\s*/g, "")
          .trim();
        const parsed: unknown = JSON.parse(rawJson);
        if (!Array.isArray(parsed)) throw new Error("expected array");
        placements = parsed;
      } catch {
        logger.warn(
          "[Director API] LLM placement response was not valid JSON — returning raw",
        );
        res.json({ raw: responseText, placements: [] });
        return;
      }

      logger.info(
        `[Director API] Generated ${placements.length} asset placements via LLM`,
      );
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
      const {
        backgroundPath,
        outputPath: requestedOutput,
        placements,
      } = req.body as {
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
      if (
        !placements ||
        !Array.isArray(placements) ||
        placements.length === 0
      ) {
        res.status(400).json({
          error: "placements array is required and must not be empty",
        });
        return;
      }

      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      // Default output path if not specified
      const outputPath =
        requestedOutput ||
        pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "uploads",
          "overlay",
          `${Date.now()}-overlay.mp4`,
        );

      const { overlayAssets } = await import("../../video/asset-overlay.js");
      const result = await overlayAssets({
        backgroundPath,
        placements:
          placements as import("../../video/asset-overlay.js").AssetPlacement[],
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
        pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "uploads",
          "visual",
        ),
        pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "uploads",
          "videos",
        ),
        pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "uploads",
          "overlay",
        ),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "ref-audio"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "images"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "blog"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "thumbnails"),
        pathMod.join(osMod.homedir(), ".openzigs", "director", "shorts"),
        // Gallery assets (screen recordings, trimmed clips, uploads via Capture & Trim)
        pathMod.join(osMod.homedir(), ".openzigs", "gallery"),
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
        const rendersBase = pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "renders",
        );
        if (fsMod.existsSync(rendersBase)) {
          const jobDirs = fsMod.readdirSync(rendersBase, {
            withFileTypes: true,
          });
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
      const manager = await ctx.getAssetManager();
      const removed = await manager.remove(req.params.id);
      res.json({ success: removed });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /assets/ingest — ingest a user-uploaded video through the ingestion pipeline.
   * Body: { filePath: string, enableVision?: boolean, model?: string }
   *
   * Runs: ffprobe → audio extraction → keyframe analysis → (optional) vision → transcript.
   * Returns: ClipAnalysis with keyframes, transcript, and descriptions.
   */
  router.post("/assets/ingest", async (req, res) => {
    try {
      const {
        filePath: srcPath,
        enableVision,
        model: visionModel,
      } = req.body as {
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
      const pathMod = await import("node:path");
      const osMod = await import("node:os");

      // Resolve tilde
      const resolvedSrcPath = srcPath.startsWith("~")
        ? pathMod.join(osMod.homedir(), srcPath.slice(1))
        : pathMod.resolve(srcPath);

      // Path traversal guard: only allow files under home directory or outputDir
      const homeDir = osMod.homedir();
      const allowedRoots = [homeDir, pathMod.resolve(ctx.config.outputDir)];
      const normalizedResolved = pathMod.resolve(resolvedSrcPath);
      if (
        !allowedRoots.some(
          (root) =>
            normalizedResolved.startsWith(root + pathMod.sep) ||
            normalizedResolved === root,
        )
      ) {
        res.status(403).json({
          error: "Access denied: file path is outside allowed directories",
        });
        return;
      }

      if (!fsMod.existsSync(resolvedSrcPath)) {
        res.status(404).json({ error: `File not found: ${resolvedSrcPath}` });
        return;
      }

      const { ingest } = await import("../../video/ingestion/index.js");
      const resolvedModel =
        visionModel || ctx.runtimeConfig.defaultModel || undefined;
      const useVision = enableVision !== false;

      const progressLog: Array<{ phase: string; message: string }> = [];
      const result = await ingest(
        { clips: [resolvedSrcPath], mode: "highlight" },
        {
          copilot: useVision ? ctx.copilot : undefined,
          visionAnalysis: useVision
            ? { maxKeyframes: 10, delayMs: 1000, model: resolvedModel }
            : undefined,
          onProgress: (event) => {
            progressLog.push({ phase: event.phase, message: event.message });
            logger.info(
              `[Director API] Ingest: ${event.phase}: ${event.message}`,
            );
          },
        },
      );

      const clip = result.clips[0];
      if (!clip) {
        res.status(500).json({ error: "Ingestion produced no clip analysis" });
        return;
      }

      logger.info(
        `[Director API] Asset ingested: ${resolvedSrcPath} — ${clip.keyframes.length} keyframes, ${clip.transcript.length} transcript segments`,
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
      if (!kit) {
        res.status(404).json({ error: "Brand kit not found" });
        return;
      }
      res.json(kit);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] GET /brand-kits/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/brand-kits", (req, res) => {
    try {
      const {
        name,
        primaryColor,
        secondaryColor,
        accentColor,
        fontFamily,
        logoPath,
        watermarkPath,
        introTemplateId,
        outroTemplateId,
      } = req.body as Record<string, string | null | undefined>;
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
      const brandKitUpdateSchema = z
        .object({
          name: z.string().min(1).optional(),
          primaryColor: z.string().optional(),
          secondaryColor: z.string().optional(),
          accentColor: z.string().optional(),
          fontFamily: z.string().optional(),
          logoPath: z.string().nullable().optional(),
          watermarkPath: z.string().nullable().optional(),
          introTemplateId: z.string().nullable().optional(),
          outroTemplateId: z.string().nullable().optional(),
        })
        .strict();
      const parsed = brandKitUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid fields",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const repo = new BrandKitRepository(getDatabase());
      const updated = repo.update(req.params.id, parsed.data);
      if (!updated) {
        res.status(404).json({ error: "Brand kit not found" });
        return;
      }
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
      if (!deleted) {
        res.status(404).json({ error: "Brand kit not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Director API] DELETE /brand-kits/:id failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Gallery Collections & Tags (Issue #520) ────────────

  router.get("/gallery/collections", (_req, res) => {
    try {
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      const rows = db
        .prepare(`SELECT * FROM gallery_collections ORDER BY name ASC`)
        .all() as Array<{
        id: string;
        name: string;
        description: string;
        created_at: string;
      }>;
      res.json({
        collections: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          createdAt: r.created_at,
        })),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/collections", (req, res) => {
    try {
      const { name, description } = req.body as {
        name?: string;
        description?: string;
      };
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      const id = nanoid();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO gallery_collections (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, name.trim(), (description || "").trim(), now);
      res.status(201).json({
        id,
        name: name.trim(),
        description: (description || "").trim(),
        createdAt: now,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.put("/gallery/collections/:id", (req, res) => {
    try {
      const { name, description } = req.body as {
        name?: string;
        description?: string;
      };
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      const existing = db
        .prepare(`SELECT id FROM gallery_collections WHERE id = ?`)
        .get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Collection not found" });
        return;
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        sets.push("name = ?");
        values.push(name.trim());
      }
      if (description !== undefined) {
        sets.push("description = ?");
        values.push(description.trim());
      }
      if (sets.length > 0) {
        values.push(req.params.id);
        db.prepare(
          `UPDATE gallery_collections SET ${sets.join(", ")} WHERE id = ?`,
        ).run(...values);
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
      ctx.ensureGalleryTables(db);
      db.prepare(
        `DELETE FROM gallery_collection_items WHERE collection_id = ?`,
      ).run(req.params.id);
      const result = db
        .prepare(`DELETE FROM gallery_collections WHERE id = ?`)
        .run(req.params.id);
      if (result.changes === 0) {
        res.status(404).json({ error: "Collection not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/collections/:id/items", (req, res) => {
    try {
      const { assetPath } = req.body as { assetPath?: string };
      if (!assetPath) {
        res.status(400).json({ error: "assetPath is required" });
        return;
      }
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      db.prepare(
        `INSERT OR IGNORE INTO gallery_collection_items (collection_id, asset_path) VALUES (?, ?)`,
      ).run(req.params.id, assetPath);
      res.status(201).json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/gallery/collections/:id/items", (req, res) => {
    try {
      const { assetPath } = req.body as { assetPath?: string };
      if (!assetPath) {
        res.status(400).json({ error: "assetPath is required" });
        return;
      }
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      db.prepare(
        `DELETE FROM gallery_collection_items WHERE collection_id = ? AND asset_path = ?`,
      ).run(req.params.id, assetPath);
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/gallery/collections/:id/items", (req, res) => {
    try {
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      const rows = db
        .prepare(
          `SELECT asset_path FROM gallery_collection_items WHERE collection_id = ?`,
        )
        .all(req.params.id) as Array<{ asset_path: string }>;
      res.json({ items: rows.map((r) => r.asset_path) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/gallery/tags", (req, res) => {
    try {
      const { assetPath, tag } = req.body as {
        assetPath?: string;
        tag?: string;
      };
      if (!assetPath || !tag) {
        res.status(400).json({ error: "assetPath and tag are required" });
        return;
      }
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      db.prepare(
        `INSERT OR IGNORE INTO gallery_tags (asset_path, tag) VALUES (?, ?)`,
      ).run(assetPath, tag.trim().toLowerCase());
      res.status(201).json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/gallery/tags", (req, res) => {
    try {
      const { assetPath, tag } = req.body as {
        assetPath?: string;
        tag?: string;
      };
      if (!assetPath || !tag) {
        res.status(400).json({ error: "assetPath and tag are required" });
        return;
      }
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      db.prepare(
        `DELETE FROM gallery_tags WHERE asset_path = ? AND tag = ?`,
      ).run(assetPath, tag.trim().toLowerCase());
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/gallery/tags", (req, res) => {
    try {
      const db = getDatabase();
      ctx.ensureGalleryTables(db);
      const assetPath =
        typeof req.query.assetPath === "string"
          ? req.query.assetPath
          : undefined;
      const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
      if (assetPath) {
        const rows = db
          .prepare(`SELECT tag FROM gallery_tags WHERE asset_path = ?`)
          .all(assetPath) as Array<{ tag: string }>;
        res.json({ tags: rows.map((r) => r.tag) });
      } else if (tag) {
        const rows = db
          .prepare(`SELECT asset_path FROM gallery_tags WHERE tag = ?`)
          .all(tag.trim().toLowerCase()) as Array<{ asset_path: string }>;
        res.json({ assets: rows.map((r) => r.asset_path) });
      } else {
        const rows = db
          .prepare(
            `SELECT tag, COUNT(*) as count FROM gallery_tags GROUP BY tag ORDER BY count DESC, tag ASC`,
          )
          .all() as Array<{ tag: string; count: number }>;
        res.json({ tags: rows });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });
}
