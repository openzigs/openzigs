/**
 * Storyboard / authoring routes for Director Mode.
 *
 * Owns drafts, scenes, narration metadata, templates, voice configuration,
 * scene-level enhancement, thumbnails, blog-to-video, hero-reel, shorts
 * proposal, and the runtime `/config` endpoints. Extracted from
 * `director.ts` as part of epic #1113 (sub-issue #1139).
 *
 * Behaviour MUST stay identical to the pre-split monolith — handler bodies are
 * the verbatim originals with closure refs prefixed by `ctx.`. The route
 * snapshot in `director.routes.test.ts` is the regression gate.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { Router } from "express";
import { nanoid } from "nanoid";
import { logger } from "../../logging/logger.js";
import { getDatabase } from "../../productivity/database.js";
import { NARRATION_DIRECTIVES } from "../../voice/pacing-translator.js";
import { AVAILABLE_LOCAL_VOICES } from "../../voice/types.js";
import { getUserSelectedModel } from "../../config/user-model.js";
import type { DirectorContext, ThumbnailJob } from "./context.js";

export function registerStoryboardRoutes(
  router: Router,
  ctx: DirectorContext,
): void {
  /**
   * GET /narration/directives — available speech directives & voice presets for autocomplete.
   */
  router.get("/narration/directives", (_req, res) => {
    res.json({
      directives: NARRATION_DIRECTIVES,
      voices: AVAILABLE_LOCAL_VOICES.map((v) => {
        // Infer language/gender from the voice id prefix (af=American Female, bm=British Male, etc.)
        const prefix = v.id.slice(0, 2);
        const langMap: Record<string, string> = {
          a: "en-US",
          b: "en-GB",
          j: "ja-JP",
          z: "zh-CN",
        };
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
      enabled: ctx.config.enabled,
      outputDir: ctx.config.outputDir,
      defaultTemplate: ctx.config.defaultTemplate,
      defaultModel: ctx.runtimeConfig.defaultModel,
      pixabayApiKey: ctx.runtimeConfig.pixabayApiKey
        ? "••••" + ctx.runtimeConfig.pixabayApiKey.slice(-4)
        : "",
      jamendoClientId: ctx.runtimeConfig.jamendoClientId
        ? "••••" + ctx.runtimeConfig.jamendoClientId.slice(-4)
        : "",
      pexelsApiKey: ctx.runtimeConfig.pexelsApiKey
        ? "••••" + ctx.runtimeConfig.pexelsApiKey.slice(-4)
        : "",
      pixabayConfigured:
        !!ctx.runtimeConfig.pixabayApiKey &&
        !ctx.runtimeConfig.pixabayApiKey.startsWith("${"),
      jamendoConfigured:
        !!ctx.runtimeConfig.jamendoClientId &&
        !ctx.runtimeConfig.jamendoClientId.startsWith("${"),
      pexelsConfigured:
        !!ctx.runtimeConfig.pexelsApiKey &&
        !ctx.runtimeConfig.pexelsApiKey.startsWith("${"),
    });
  });

  /**
   * PUT /config — update Director Mode configuration.
   * Body: { pixabayApiKey?, jamendoClientId?, pexelsApiKey?, defaultModel? }
   */
  router.put("/config", (req, res) => {
    const { pixabayApiKey, jamendoClientId, pexelsApiKey, defaultModel } =
      req.body as {
        pixabayApiKey?: string;
        jamendoClientId?: string;
        pexelsApiKey?: string;
        defaultModel?: string;
      };

    if (pixabayApiKey !== undefined) {
      ctx.runtimeConfig.pixabayApiKey = pixabayApiKey;
      ctx.config.assets.pixabayApiKey = pixabayApiKey;
      // Reset asset manager so it picks up the new key
      ctx.resetAssetManager();
    }
    if (jamendoClientId !== undefined) {
      ctx.runtimeConfig.jamendoClientId = jamendoClientId;
      ctx.config.assets.jamendoClientId = jamendoClientId;
      ctx.resetAssetManager();
    }
    if (pexelsApiKey !== undefined) {
      ctx.runtimeConfig.pexelsApiKey = pexelsApiKey;
      ctx.config.assets.pexelsApiKey = pexelsApiKey;
      ctx.resetAssetManager();
    }
    if (defaultModel !== undefined) {
      ctx.runtimeConfig.defaultModel = defaultModel;
    }

    logger.info("[Director API] Config updated");
    res.json({ success: true });
  });

  /**
   * GET /templates — list all available video templates.
   */
  router.get("/templates", async (_req, res) => {
    try {
      const { createTemplateRegistry } =
        await import("../../video/templates/template-registry.js");
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
      res.json({ templates, defaultTemplate: ctx.config.defaultTemplate });
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
      const { createTemplateRegistry } =
        await import("../../video/templates/template-registry.js");
      const registry = createTemplateRegistry();
      const template = registry.get(
        req.params
          .id as import("../../video/manifest/manifest-types.js").TemplateId,
      );
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
      const allowedRoots = [homeDir, pathMod.resolve(ctx.config.outputDir)];
      if (
        !allowedRoots.some(
          (root) =>
            normalizedImagePath.startsWith(root + pathMod.sep) ||
            normalizedImagePath === root,
        )
      ) {
        res.status(403).json({
          error: "Access denied: imagePath is outside allowed directories",
        });
        return;
      }

      if (!fsMod.existsSync(normalizedImagePath)) {
        res.status(404).json({ error: `Image not found: ${imagePath}` });
        return;
      }
      const imageOutputDir = pathMod.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      const imageGenUserConfig = await (
        await import("../../video/generators/image-gen-service.js")
      ).ImageGenService.loadUserImageGenConfig();
      const imageService = new (
        await import("../../video/generators/image-gen-service.js")
      ).ImageGenService({ outputDir: imageOutputDir, ...imageGenUserConfig });
      await imageService.initialize();

      const result = await imageService.enhanceImage(
        normalizedImagePath,
        prompt,
        {
          strength,
          model,
          seed,
        },
      );

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

  /**
   * POST /enhance-instructions — use the LLM to enrich a Director style/instructions preamble.
   * Body: { raw_instructions: string, mode?: string }
   * Response: { enhanced_instructions: string, thinking: string }
   */
  router.post("/enhance-instructions", async (req, res) => {
    try {
      const {
        raw_instructions,
        mode,
        model: bodyModel,
      } = req.body as {
        raw_instructions?: string;
        mode?: string;
        model?: string;
      };

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

      const enhanceModel = bodyModel || (await getUserSelectedModel());
      let fullResponse = "";
      for await (const chunk of ctx.copilot.chat(userMessage, {
        conversationId,
        systemMessage: { mode: "replace", content: systemMessage },
        tools: [],
        availableTools: [],
        ...(enhanceModel ? { model: enhanceModel } : {}),
      })) {
        fullResponse += chunk;
      }
      await ctx.copilot.destroySession(conversationId);

      // Parse JSON response — strip any accidental markdown fences
      const jsonStr = fullResponse
        .replace(/^```(?:json)?\n?/m, "")
        .replace(/```\s*$/m, "")
        .trim();
      let parsed: { thinking?: string; enhanced_instructions?: string };
      try {
        parsed = JSON.parse(jsonStr) as {
          thinking?: string;
          enhanced_instructions?: string;
        };
      } catch {
        // Fallback: return the raw text as the enhancement
        parsed = {
          thinking: "Instructions enhanced.",
          enhanced_instructions: fullResponse.trim(),
        };
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
      if (
        manifestPath.includes("..") ||
        manifestPath.includes("\0") ||
        outputDir.includes("..") ||
        outputDir.includes("\0")
      ) {
        res.status(400).json({ error: "Invalid path" });
        return;
      }
      const normalizedManifestPath = pathMod.resolve(manifestPath);
      const normalizedOutputDir = pathMod.resolve(outputDir);
      const homeDir = osMod.homedir();
      const allowedRoots = [homeDir, pathMod.resolve(ctx.config.outputDir)];
      if (
        !allowedRoots.some(
          (root) =>
            normalizedManifestPath.startsWith(root + pathMod.sep) ||
            normalizedManifestPath === root,
        )
      ) {
        res.status(403).json({
          error: "Access denied: manifestPath is outside allowed directories",
        });
        return;
      }
      if (
        !allowedRoots.some(
          (root) =>
            normalizedOutputDir.startsWith(root + pathMod.sep) ||
            normalizedOutputDir === root,
        )
      ) {
        res.status(403).json({
          error: "Access denied: outputDir is outside allowed directories",
        });
        return;
      }

      if (!fsMod.existsSync(normalizedManifestPath)) {
        res.status(404).json({ error: `Manifest not found: ${manifestPath}` });
        return;
      }

      const manifestRaw = JSON.parse(
        fsMod.readFileSync(normalizedManifestPath, "utf-8"),
      );
      const { DirectorManifestSchema } =
        await import("../../video/manifest/manifest-schema.js");
      const manifest = DirectorManifestSchema.parse(manifestRaw);

      // LLM frame selection
      const { extractKeyframesFromManifest, selectThumbnailFrame } =
        await import("../../video/thumbnails/frame-selector.js");
      const keyframes = extractKeyframesFromManifest(manifest, outputDir);

      if (keyframes.length === 0) {
        res
          .status(400)
          .json({ error: "No scene images found in output directory" });
        return;
      }

      const frameResult = await selectThumbnailFrame(
        keyframes,
        manifest,
        ctx.copilot,
      );

      // Apply text override if provided
      const textLines =
        Array.isArray(textOverride) && textOverride.length > 0
          ? textOverride
              .filter((t): t is string => typeof t === "string")
              .slice(0, 3)
          : frameResult.suggestedText;

      // Stylize the selected frame via Flux img2img
      let stylizedPath = frameResult.framePath;
      try {
        const imageOutputDir = pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "images",
        );
        const imageGenMod =
          await import("../../video/generators/image-gen-service.js");
        const imageGenUserConfig =
          await imageGenMod.ImageGenService.loadUserImageGenConfig();
        const imageService = new imageGenMod.ImageGenService({
          outputDir: imageOutputDir,
          ...imageGenUserConfig,
        });
        await imageService.initialize();

        const stylePrompt =
          style ??
          "YouTube thumbnail style, highly saturated, expressive, high contrast, vibrant colors, professional";
        const enhanced = await imageService.enhanceImage(
          frameResult.framePath,
          stylePrompt,
          {
            width: 1280,
            height: 720,
            steps: 20,
            strength: 0.6,
          },
        );
        stylizedPath = enhanced.filePath;
      } catch (enhanceErr) {
        logger.warn(
          `[Director API] Thumbnail img2img enhancement failed, using raw frame: ${enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr)}`,
        );
      }

      // Composite text overlay
      const { compositeThumbnail } =
        await import("../../video/thumbnails/thumbnail-compositor.js");
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
      const resolvedTitle =
        (title && typeof title === "string" && title.trim()) ||
        "Untitled Draft";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(
        id,
        resolvedTitle,
        manifestJson,
        thumbnail ?? null,
        productionMode,
        now,
        now,
      );

      logger.info(`[Director API] Draft created: ${id} "${resolvedTitle}"`);
      res.json({
        id,
        title: resolvedTitle,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });
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
      const rows = db
        .prepare(
          `SELECT id, title, thumbnail, production_mode, created_at, updated_at, status
         FROM director_drafts ORDER BY updated_at DESC`,
        )
        .all() as Array<{
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
          thumbnail: r.thumbnail
            ? r.thumbnail.startsWith("http") || r.thumbnail.startsWith("/api")
              ? r.thumbnail
              : `/api/admin/director/files/${encodeURIComponent(r.thumbnail)}`
            : null,
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
      const row = db
        .prepare(
          `SELECT id, title, manifest, thumbnail, production_mode, created_at, updated_at, status
         FROM director_drafts WHERE id = ?`,
        )
        .get(req.params.id) as
        | {
            id: string;
            title: string;
            manifest: string;
            thumbnail: string | null;
            production_mode: string;
            created_at: string;
            updated_at: string;
            status: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }

      let manifest: unknown;
      try {
        manifest = JSON.parse(row.manifest);
      } catch (err) {
        manifest = null;
        logger.warn(
          `[Director API] Draft ${row.id} has corrupt manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const thumbnailUrl = row.thumbnail
        ? row.thumbnail.startsWith("http") || row.thumbnail.startsWith("/api")
          ? row.thumbnail
          : `/api/admin/director/files/${encodeURIComponent(row.thumbnail)}`
        : null;

      res.json({
        id: row.id,
        title: row.title,
        manifest,
        thumbnail: thumbnailUrl,
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
      const row = db
        .prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(id) as
        | {
            title: string;
            manifest: string;
          }
        | undefined;

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

      const { generateSubtitles } =
        await import("../../video/subtitle-export.js");
      const content = generateSubtitles(
        manifest as import("../../video/subtitle-export.js").ManifestForSubtitles,
        format,
      );

      const safeTitle = row.title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
      const filename = `${safeTitle}.${format}`;
      const contentType =
        format === "srt" ? "application/x-subrip" : "text/vtt";

      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.send(content);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] GET /drafts/:id/subtitles/:format failed: ${msg}`,
      );
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

      const existing = db
        .prepare(`SELECT id FROM director_drafts WHERE id = ?`)
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

      db.prepare(
        `UPDATE director_drafts SET ${updates.join(", ")} WHERE id = ?`,
      ).run(...values);
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
      const result = db
        .prepare(`DELETE FROM director_drafts WHERE id = ?`)
        .run(req.params.id);
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
      const draft = db
        .prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(req.params.id) as { title: string; manifest: string } | undefined;
      if (!draft) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }
      const { label } = req.body as { label?: string };
      const id = randomUUID();
      const now = new Date().toISOString();
      const resolvedLabel =
        label?.trim() ||
        `v – ${new Date(now).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}`;
      db.prepare(
        `INSERT INTO director_draft_versions (id, draft_id, label, manifest, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, req.params.id, resolvedLabel, draft.manifest, now);
      logger.info(
        `[Director API] Draft version created: ${id} for draft ${req.params.id}`,
      );
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
      const rows = db
        .prepare(
          `SELECT id, label, created_at FROM director_draft_versions
         WHERE draft_id = ? ORDER BY created_at DESC`,
        )
        .all(req.params.id) as Array<{
        id: string;
        label: string;
        created_at: string;
      }>;
      res.json({
        versions: rows.map((r) => ({
          id: r.id,
          label: r.label,
          createdAt: r.created_at,
        })),
      });
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
      const ver = db
        .prepare(
          `SELECT manifest FROM director_draft_versions WHERE id = ? AND draft_id = ?`,
        )
        .get(req.params.versionId, req.params.id) as
        | { manifest: string }
        | undefined;
      if (!ver) {
        res.status(404).json({ error: "Version not found" });
        return;
      }
      db.prepare(
        `UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`,
      ).run(ver.manifest, new Date().toISOString(), req.params.id);
      logger.info(
        `[Director API] Draft ${req.params.id} restored from version ${req.params.versionId}`,
      );
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
      const rows = db
        .prepare(
          `SELECT id, job_id, quality, status, output_path, error, created_at, updated_at
         FROM director_renders WHERE draft_id = ? ORDER BY created_at DESC`,
        )
        .all(req.params.id) as Array<{
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
        const job = ctx.renderOrchestrator?.getJob(r.job_id);
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
      const draft = db
        .prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(req.params.id) as { title: string; manifest: string } | undefined;
      if (!draft) {
        res.status(404).json({ error: `Draft not found: ${req.params.id}` });
        return;
      }

      const { DirectorManifestSchema } =
        await import("../../video/manifest/manifest-schema.js");
      const manifest = DirectorManifestSchema.parse(JSON.parse(draft.manifest));

      const imageDir = pathMod.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      const outputDir = pathMod.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "thumbnails",
      );
      if (!fsMod.existsSync(outputDir)) {
        fsMod.mkdirSync(outputDir, { recursive: true });
      }

      const {
        style,
        textOverride,
        mode,
        prompt,
        clickbaitOverlay,
        baseFrameUrl,
      } = req.body as {
        style?: string;
        textOverride?: string[];
        mode?: "frame-select" | "flux-enhance" | "flux-generate";
        prompt?: string;
        clickbaitOverlay?: "none" | "arrows" | "circles" | "emoji" | "badge";
        baseFrameUrl?: string;
      };

      const imageGenMod =
        await import("../../video/generators/image-gen-service.js");
      const imageGenUserConfig =
        await imageGenMod.ImageGenService.loadUserImageGenConfig();
      const imageService = new imageGenMod.ImageGenService({
        outputDir: imageDir,
        ...imageGenUserConfig,
      });
      await imageService.initialize();

      // -- Helper: select the best keyframe from the manifest --
      const pickBestFrame = async () => {
        const { extractKeyframesFromManifest, selectThumbnailFrame } =
          await import("../../video/thumbnails/frame-selector.js");
        const keyframes = extractKeyframesFromManifest(manifest, imageDir);
        if (keyframes.length === 0) return null;
        return selectThumbnailFrame(keyframes, manifest, ctx.copilot);
      };

      // -- Helper: resolve a base frame path from URL or fresh selection --
      const resolveBaseFrame = async (): Promise<{
        path: string;
        timestamp: number;
        rationale: string;
        text: string[];
      } | null> => {
        // If the client sent back a previously selected frame URL, resolve it
        if (baseFrameUrl) {
          const filename = baseFrameUrl.split("/").pop() ?? "";
          // Check thumbnails directory first, then images directory
          let resolved = pathMod.join(outputDir, filename);
          if (!fsMod.existsSync(resolved)) {
            resolved = pathMod.join(imageDir, filename);
          }
          if (fsMod.existsSync(resolved)) {
            return {
              path: resolved,
              timestamp: 0,
              rationale: "Using previously selected frame",
              text: [manifest.projectTitle.toUpperCase()],
            };
          }
        }
        // Fall back to fresh LLM selection
        const frameResult = await pickBestFrame();
        if (!frameResult) return null;
        return {
          path: frameResult.framePath,
          timestamp: frameResult.timestamp,
          rationale: frameResult.rationale,
          text: frameResult.suggestedText,
        };
      };

      let backgroundPath: string;
      let rawFrameUrl: string | undefined;
      let frameInfo: { timestamp: number; rationale: string } = {
        timestamp: 0,
        rationale: "",
      };
      let suggestedText: string[];
      const effectiveMode = mode ?? "frame-select";

      if (effectiveMode === "frame-select") {
        // Step 1 flow: just pick the best frame, no enhancement. Return fast.
        const frame = await resolveBaseFrame();
        if (!frame) {
          res.status(400).json({
            error:
              "No scene images found — ensure the draft has generated images",
          });
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
          const textStream = ctx.copilot.chat(
            `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
            { tools: [], ...(thumbModel ? { model: thumbModel } : {}) },
          );
          for await (const chunk of textStream) textChunks.push(chunk);
          let jsonText = textChunks.join("").trim();
          if (jsonText.startsWith("```"))
            jsonText = jsonText
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "");
          const parsed = JSON.parse(jsonText) as { suggestedText?: string[] };
          if (Array.isArray(parsed.suggestedText)) {
            suggestedText = parsed.suggestedText
              .filter((t): t is string => typeof t === "string")
              .slice(0, 3);
          }
        } catch {
          logger.warn(
            "[Director API] Thumbnail text suggestion failed, using project title",
          );
        }
      } else if (effectiveMode === "flux-enhance") {
        // Long-running Kontext edit — return 202, run in background, poll or Socket.IO for result
        const frame = await resolveBaseFrame();
        if (!frame) {
          res.status(400).json({
            error:
              "No scene images found — ensure the draft has generated images",
          });
          return;
        }

        const thumbnailJobId = nanoid();
        const job: ThumbnailJob = {
          id: thumbnailJobId,
          draftId: req.params.id,
          status: "running",
          startedAt: Date.now(),
        };
        ctx.thumbnailJobs.set(thumbnailJobId, job);
        // Evict old completed jobs (keep last 20)
        const allThumbJobs = [...ctx.thumbnailJobs.values()];
        const finishedThumb = allThumbJobs
          .filter((j) => j.status !== "running")
          .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
        while (finishedThumb.length > 20) {
          ctx.thumbnailJobs.delete(finishedThumb.shift()!.id);
        }

        res.status(202).json({ thumbnailJobId, mode: effectiveMode });
        logger.info(
          `[Director API] Thumbnail job ${thumbnailJobId} accepted (flux-enhance) — running in background`,
        );

        (async () => {
          try {
            const enhancePrompt =
              prompt ??
              style ??
              "YouTube thumbnail style, highly saturated, expressive, high contrast, vibrant colors, professional";
            const enhanced = await imageService.kontextEdit(
              frame.path,
              enhancePrompt,
              {
                width: 1280,
                height: 720,
                steps: 20,
                guidance: 2.5,
              },
            );
            logger.info(
              `[Director API] Thumbnail img2img enhanced: ${enhanced.filePath} (${enhanced.generationTimeMs}ms)`,
            );

            const textLines =
              Array.isArray(textOverride) && textOverride.length > 0
                ? textOverride
                    .filter((t): t is string => typeof t === "string")
                    .slice(0, 3)
                : frame.text;

            const { compositeThumbnail } =
              await import("../../video/thumbnails/thumbnail-compositor.js");
            const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
            const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
            await compositeThumbnail({
              backgroundPath: enhanced.filePath,
              textLines,
              textPlacement: "bottom",
              textColor: "#ffffff",
              outputPath: thumbnailPath,
              clickbaitOverlay:
                clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
            });

            db.prepare(
              `UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`,
            ).run(thumbnailFilename, new Date().toISOString(), req.params.id);

            const resultPayload = {
              thumbnailUrl: `/api/admin/director/files/${thumbnailFilename}`,
              suggestedText: textLines,
              selectedFrame: {
                timestamp: frame.timestamp,
                rationale: `Enhanced with: "${enhancePrompt.slice(0, 80)}"`,
              },
              mode: effectiveMode,
            };
            job.status = "complete";
            job.result = resultPayload;
            job.completedAt = Date.now();
            if (ctx.io())
              ctx.io()!.emit("thumbnail:complete", {
                thumbnailJobId,
                draftId: req.params.id,
                ...resultPayload,
              });
            logger.info(
              `[Director API] Thumbnail job ${thumbnailJobId} complete`,
            );
          } catch (bgErr) {
            const cause =
              bgErr instanceof Error && bgErr.cause
                ? ` (cause: ${bgErr.cause instanceof Error ? bgErr.cause.message : String(bgErr.cause)})`
                : "";
            const bgMsg =
              (bgErr instanceof Error ? bgErr.message : String(bgErr)) + cause;
            job.status = "failed";
            job.error = bgMsg;
            job.completedAt = Date.now();
            logger.error(
              `[Director API] Thumbnail job ${thumbnailJobId} failed: ${bgMsg}`,
            );
            if (ctx.io())
              ctx.io()!.emit("thumbnail:failed", {
                thumbnailJobId,
                draftId: req.params.id,
                error: bgMsg,
              });
          }
        })();
        return;
      } else {
        // flux-generate: completely new image — also long-running, same async pattern
        const thumbnailJobId = nanoid();
        const job: ThumbnailJob = {
          id: thumbnailJobId,
          draftId: req.params.id,
          status: "running",
          startedAt: Date.now(),
        };
        ctx.thumbnailJobs.set(thumbnailJobId, job);
        const allThumbJobs = [...ctx.thumbnailJobs.values()];
        const finishedThumb = allThumbJobs
          .filter((j) => j.status !== "running")
          .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
        while (finishedThumb.length > 20) {
          ctx.thumbnailJobs.delete(finishedThumb.shift()!.id);
        }

        res.status(202).json({ thumbnailJobId, mode: effectiveMode });
        logger.info(
          `[Director API] Thumbnail job ${thumbnailJobId} accepted (flux-generate) — running in background`,
        );

        (async () => {
          try {
            const thumbnailPrompt =
              prompt ??
              `YouTube thumbnail for "${manifest.projectTitle}", highly saturated, expressive, high contrast, vibrant colors, dramatic lighting, professional photography, 4K`;

            const genResult = await imageService.generateImage(
              thumbnailPrompt,
              {
                width: 1280,
                height: 720,
              },
            );
            let genSuggestedText: string[] = [
              manifest.projectTitle.toUpperCase(),
            ];

            try {
              const thumbModel2 = await getUserSelectedModel();
              const textChunks: string[] = [];
              const textStream = ctx.copilot.chat(
                `You are a YouTube clickbait expert. Given this video title: "${manifest.projectTitle}", suggest 2 short, bold, enticing text overlay lines for the thumbnail. ALL CAPS, max 25 chars per line. Respond with JSON: { "suggestedText": ["LINE1", "LINE2"] }`,
                { tools: [], ...(thumbModel2 ? { model: thumbModel2 } : {}) },
              );
              for await (const chunk of textStream) textChunks.push(chunk);
              let jsonText = textChunks.join("").trim();
              if (jsonText.startsWith("```"))
                jsonText = jsonText
                  .replace(/^```(?:json)?\n?/, "")
                  .replace(/\n?```$/, "");
              const parsed = JSON.parse(jsonText) as {
                suggestedText?: string[];
              };
              if (Array.isArray(parsed.suggestedText)) {
                genSuggestedText = parsed.suggestedText
                  .filter((t): t is string => typeof t === "string")
                  .slice(0, 3);
              }
            } catch {
              logger.warn(
                "[Director API] Thumbnail text suggestion failed, using project title",
              );
            }

            const textLines =
              Array.isArray(textOverride) && textOverride.length > 0
                ? textOverride
                    .filter((t): t is string => typeof t === "string")
                    .slice(0, 3)
                : genSuggestedText;

            const { compositeThumbnail } =
              await import("../../video/thumbnails/thumbnail-compositor.js");
            const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
            const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
            await compositeThumbnail({
              backgroundPath: genResult.filePath,
              textLines,
              textPlacement: "bottom",
              textColor: "#ffffff",
              outputPath: thumbnailPath,
              clickbaitOverlay:
                clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
            });

            db.prepare(
              `UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`,
            ).run(thumbnailFilename, new Date().toISOString(), req.params.id);

            const resultPayload = {
              thumbnailUrl: `/api/admin/director/files/${thumbnailFilename}`,
              suggestedText: textLines,
              selectedFrame: {
                timestamp: 0,
                rationale: `AI-generated from prompt: "${thumbnailPrompt.slice(0, 100)}"`,
              },
              mode: effectiveMode,
            };
            job.status = "complete";
            job.result = resultPayload;
            job.completedAt = Date.now();
            if (ctx.io())
              ctx.io()!.emit("thumbnail:complete", {
                thumbnailJobId,
                draftId: req.params.id,
                ...resultPayload,
              });
            logger.info(
              `[Director API] Thumbnail job ${thumbnailJobId} complete`,
            );
          } catch (bgErr) {
            const cause =
              bgErr instanceof Error && bgErr.cause
                ? ` (cause: ${bgErr.cause instanceof Error ? bgErr.cause.message : String(bgErr.cause)})`
                : "";
            const bgMsg =
              (bgErr instanceof Error ? bgErr.message : String(bgErr)) + cause;
            job.status = "failed";
            job.error = bgMsg;
            job.completedAt = Date.now();
            logger.error(
              `[Director API] Thumbnail job ${thumbnailJobId} failed: ${bgMsg}`,
            );
            if (ctx.io())
              ctx.io()!.emit("thumbnail:failed", {
                thumbnailJobId,
                draftId: req.params.id,
                error: bgMsg,
              });
          }
        })();
        return;
      }

      // frame-select mode reaches here — composite and respond synchronously
      const textLines =
        Array.isArray(textOverride) && textOverride.length > 0
          ? textOverride
              .filter((t): t is string => typeof t === "string")
              .slice(0, 3)
          : suggestedText;

      const { compositeThumbnail } =
        await import("../../video/thumbnails/thumbnail-compositor.js");
      const thumbnailFilename = `thumb_${req.params.id}_${Date.now()}.jpg`;
      const thumbnailPath = pathMod.join(outputDir, thumbnailFilename);
      await compositeThumbnail({
        backgroundPath,
        textLines,
        textPlacement: "bottom",
        textColor: "#ffffff",
        outputPath: thumbnailPath,
        clickbaitOverlay:
          clickbaitOverlay !== "none" ? clickbaitOverlay : undefined,
      });

      db.prepare(
        `UPDATE director_drafts SET thumbnail = ?, updated_at = ? WHERE id = ?`,
      ).run(thumbnailFilename, new Date().toISOString(), req.params.id);

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

  router.get("/thumbnail-job/:jobId", (req, res) => {
    const job = ctx.thumbnailJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Thumbnail job not found" });
      return;
    }
    if (job.status === "running") {
      res.json({ status: "running", elapsedMs: Date.now() - job.startedAt });
      return;
    }
    if (job.status === "failed") {
      res.json({ status: "failed", error: job.error });
      return;
    }
    res.json({ status: "complete", ...job.result });
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

      const {
        draftId,
        prompt,
        provider,
        model: imageModel,
        seed,
      } = req.body as {
        draftId?: string;
        prompt?: string;
        provider?: "auto" | "local" | "cloud";
        model?: "flux-schnell" | "flux-dev" | "sdxl-base";
        seed?: number;
      };

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const osMod = await import("node:os");
      const pathMod = await import("node:path");
      const imageOutputDir = pathMod.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      const { ImageGenService } =
        await import("../../video/generators/image-gen-service.js");
      const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({
        outputDir: imageOutputDir,
        ...imageGenUserConfig,
      });
      await imageService.initialize();

      const result = await imageService.generateImage(prompt, {
        provider: provider ?? "auto",
        localModel: imageModel,
        seed,
      });

      // If a draftId is provided, update the corresponding scene in the draft manifest
      if (draftId) {
        const db = getDatabase();
        const row = db
          .prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
          .get(draftId) as { manifest: string } | undefined;

        if (row) {
          try {
            const manifest = JSON.parse(row.manifest);
            if (Array.isArray(manifest.timeline)) {
              const scenes = manifest.timeline.filter(
                (e: { type: string }) =>
                  e.type === "image_scene" || e.type === "video_clip",
              );
              if (scenes[sceneIndex]) {
                scenes[sceneIndex].src = result.filePath;
                const now = new Date().toISOString();
                db.prepare(
                  `UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`,
                ).run(JSON.stringify(manifest), now, draftId);
              }
            }
          } catch {
            // Non-fatal: scene image was generated, draft update failed
            logger.warn(
              `[Director API] Failed to update draft ${draftId} scene ${sceneIndex}`,
            );
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
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/regenerate failed: ${msg}`,
      );
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

      const { draftId, assetId } = req.body as {
        draftId?: string;
        assetId?: string;
      };
      if (!assetId || typeof assetId !== "string") {
        res.status(400).json({ error: "assetId is required" });
        return;
      }

      const db = getDatabase();
      const asset = db
        .prepare("SELECT * FROM media_assets WHERE id = ?")
        .get(assetId) as { file_path: string } | undefined;
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
      const imageDir = pathMod.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      fsMod.mkdirSync(imageDir, { recursive: true });
      const ext = pathMod.extname(sourcePath) || ".png";
      const destFilename = `gallery-${Date.now()}${ext}`;
      const destPath = pathMod.join(imageDir, destFilename);
      fsMod.copyFileSync(sourcePath, destPath);

      // Update draft if provided
      if (draftId) {
        const db = getDatabase();
        const row = db
          .prepare("SELECT manifest FROM director_drafts WHERE id = ?")
          .get(draftId) as { manifest: string } | undefined;

        if (row) {
          try {
            const manifest = JSON.parse(row.manifest);
            if (Array.isArray(manifest.timeline)) {
              const scenes = manifest.timeline.filter(
                (e: { type: string }) =>
                  e.type === "image_scene" || e.type === "video_clip",
              );
              if (scenes[sceneIndex]) {
                scenes[sceneIndex].src = destPath;
                const now = new Date().toISOString();
                db.prepare(
                  "UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?",
                ).run(JSON.stringify(manifest), now, draftId);
              }
            }
          } catch {
            logger.warn(
              `[Director API] Failed to update draft ${draftId} scene ${sceneIndex}`,
            );
          }
        }
      }

      res.json({ filePath: destPath });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/replace-from-gallery failed: ${msg}`,
      );
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

      const {
        draftId,
        videoDurationSec,
        currentScript,
        context,
        model: bodyModel,
      } = req.body as {
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
      const row = db
        .prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as { manifest: string } | undefined;

      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      const manifest = JSON.parse(row.manifest);
      const scenes = (manifest.timeline ?? []).filter(
        (e: { type: string }) =>
          e.type === "image_scene" || e.type === "video_clip",
      );

      if (sceneIndex >= scenes.length) {
        res.status(400).json({
          error: `Scene index ${sceneIndex} out of range (${scenes.length} scenes)`,
        });
        return;
      }

      const scene = scenes[sceneIndex];
      const prevScene = sceneIndex > 0 ? scenes[sceneIndex - 1] : null;
      const nextScene =
        sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : null;

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

      const rewriteModel = bodyModel || (await getUserSelectedModel());
      const stream = ctx.copilot.chat(prompt, {
        tools: [],
        ...(rewriteModel ? { model: rewriteModel } : {}),
      });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const newScript = chunks
        .join("")
        .trim()
        .replace(/^["']|["']$/g, "");

      // Update the draft manifest with the new script
      scene.scriptText = newScript;
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(manifest), now, draftId);

      logger.info(
        `[Director API] Rewrote script for scene ${sceneIndex} in draft ${draftId}`,
      );
      res.json({ sceneIndex, newScript });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/rewrite-script failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /blog-to-video — convert a blog post URL into a draft video manifest.
   * Body: { url: string, template?, styleHint?, imageProvider?, imageModel?, musicTrackPath?, targetDuration? }
   * Response: { draftId, manifest, blog, storyboard, processingTimeMs }
   */
  router.post("/blog-to-video", async (req, res) => {
    try {
      const {
        url,
        template,
        styleHint,
        imageProvider,
        imageModel,
        musicTrackPath,
        targetDuration,
        brandVoiceId,
      } = req.body as {
        url?: string;
        template?: "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo";
        styleHint?: string;
        imageProvider?: "cloud" | "local" | "auto";
        imageModel?: "flux" | "flux-schnell" | "flux-dev" | "sdxl-base";
        musicTrackPath?: string;
        targetDuration?: number;
        brandVoiceId?: string;
      };

      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "url is required" });
        return;
      }

      if (
        musicTrackPath &&
        (musicTrackPath.includes("\0") || musicTrackPath.includes(".."))
      ) {
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

      const { blogToVideo } =
        await import("../../video/blog/blog-to-video-pipeline.js");
      const result = await blogToVideo(
        {
          url,
          template,
          styleHint,
          imageProvider,
          imageModel,
          musicTrackPath,
          model: ctx.runtimeConfig.defaultModel || undefined,
          targetDuration,
          brandVoiceBlock:
            ctx.brandVoiceService?.getVoicePromptBlockById(brandVoiceId) ||
            undefined,
        },
        ctx.copilot,
        ctx.voiceService,
      );

      // Auto-save as a draft
      const db = getDatabase();
      const draftId = nanoid();
      const now = new Date().toISOString();
      const title = result.manifest.projectTitle || "Untitled Blog Video";

      db.prepare(
        `INSERT INTO director_drafts (id, title, manifest, thumbnail, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(
        draftId,
        title,
        JSON.stringify(result.manifest),
        null,
        "blog-to-video",
        now,
        now,
      );

      logger.info(
        `[Director API] Blog-to-video saved as draft ${draftId}: "${title}"`,
      );

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

      if (!ctx.voiceService) {
        res.status(503).json({ error: "Voice service not available" });
        return;
      }

      if (!ctx.voiceService.isReady()) {
        await ctx.voiceService.initialize();
      }

      const osMod = await import("node:os");
      const fsMod = await import("node:fs/promises");
      const imageOutputDir = path.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      await fsMod.mkdir(imageOutputDir, { recursive: true });

      let voiceoverPath: string;
      let usedEngine: string;

      const resolvedEngine = engine ?? "auto";

      // Determine which engine to use
      if (resolvedEngine === "f5tts" || resolvedEngine === "auto") {
        // Check if F5-TTS is available
        const sidecarUrl = ctx.voiceService.getSidecarUrl();
        let f5Available = false;
        let f5Clips: Array<{
          emotion: string;
          ref_audio_path: string;
          ref_text: string;
        }> = [];

        try {
          const healthResp = await fetch(`${sidecarUrl}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (healthResp.ok) {
            const health = (await healthResp.json()) as {
              active_engine?: string;
            };
            if (health.active_engine === "f5tts") {
              const db = getDatabase();
              const f5Profile = db
                .prepare(
                  `SELECT id FROM voice_profiles WHERE engine_type = 'f5tts'
                 ORDER BY updated_at DESC LIMIT 1`,
                )
                .get() as { id: string } | undefined;
              if (f5Profile) {
                const clips = db
                  .prepare(
                    `SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips
                   WHERE profile_id = ? ORDER BY sort_order ASC`,
                  )
                  .all(f5Profile.id) as Array<{
                  emotion: string;
                  ref_audio_path: string;
                  ref_text: string;
                }>;
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

        if (
          f5Available &&
          f5Clips.length > 0 &&
          (resolvedEngine === "f5tts" || resolvedEngine === "auto")
        ) {
          const f5Result = await ctx.voiceService.synthesizeF5TTS(
            text,
            f5Clips.map((c) => ({
              emotion: c.emotion,
              refAudioPath: c.ref_audio_path,
              refText: c.ref_text,
            })),
            f5ttsParams
              ? {
                  steps: f5ttsParams.steps,
                  method: f5ttsParams.method,
                  cfgStrength: f5ttsParams.cfgStrength,
                  swayCoef: f5ttsParams.swayCoef,
                  speed: f5ttsParams.speed,
                  seed: f5ttsParams.seed,
                }
              : undefined,
          );
          const voPath = path.join(
            imageOutputDir,
            `openzigs-vo-${nanoid(8)}.wav`,
          );
          await fsMod.writeFile(voPath, f5Result.audio);
          voiceoverPath = voPath;
          usedEngine = "f5tts";
        } else if (resolvedEngine === "f5tts") {
          res.status(503).json({
            error: "F5-TTS engine not available. Check sidecar health.",
          });
          return;
        } else {
          // Fall back to Kokoro/VoiceService
          const ttsResult = await ctx.voiceService.synthesize(text, voice);
          const ext = ttsResult.contentType?.includes("wav") ? "wav" : "mp3";
          const voPath = path.join(
            imageOutputDir,
            `openzigs-vo-${nanoid(8)}.${ext}`,
          );
          await fsMod.writeFile(voPath, ttsResult.audio);
          voiceoverPath = voPath;
          usedEngine = ctx.voiceService.getProvider();
        }
      } else {
        // Kokoro / VoiceService
        const ttsResult = await ctx.voiceService.synthesize(text, voice);
        const ext = ttsResult.contentType?.includes("wav") ? "wav" : "mp3";
        const voPath = path.join(
          imageOutputDir,
          `openzigs-vo-${nanoid(8)}.${ext}`,
        );
        await fsMod.writeFile(voPath, ttsResult.audio);
        voiceoverPath = voPath;
        usedEngine = ctx.voiceService.getProvider();
      }

      // Measure duration
      const durationSec =
        (await ctx.probeAudioDurationSeconds(voiceoverPath)) ?? 0;

      // Update the draft manifest if draftId provided
      if (draftId) {
        const db = getDatabase();
        const row = db
          .prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
          .get(draftId) as { manifest: string } | undefined;

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
                      const newDuration = Math.max(
                        Math.round((durationSec + 0.35) * fps),
                        fps,
                      );
                      manifest.timeline[i].duration = newDuration;
                    }
                    break;
                  }
                  visualIdx++;
                }
              }
              const now = new Date().toISOString();
              db.prepare(
                `UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`,
              ).run(JSON.stringify(manifest), now, draftId);
            }
          } catch {
            logger.warn(
              `[Director API] Failed to update draft ${draftId} scene ${sceneIndex} voiceover`,
            );
          }
        }
      }

      logger.info(
        `[Director API] Re-recorded scene ${sceneIndex} voiceover: engine=${usedEngine}, dur=${durationSec.toFixed(1)}s`,
      );

      res.json({
        sceneIndex,
        voiceoverPath,
        durationSec,
        engine: usedEngine,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/re-record failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /voice/engines — return available voice engines and their status.
   */
  router.get("/voice/engines", async (_req, res) => {
    try {
      const engines: Array<{
        id: string;
        name: string;
        available: boolean;
        active: boolean;
      }> = [];

      if (ctx.voiceService) {
        const provider = ctx.voiceService.getProvider();
        engines.push({
          id: "kokoro",
          name: "Kokoro (Local TTS)",
          available:
            ctx.voiceService.isReady() &&
            (provider === "local" || provider === "f5tts"),
          active: provider === "local",
        });

        // Check F5-TTS availability
        const sidecarUrl = ctx.voiceService.getSidecarUrl();
        let f5Active = false;
        try {
          const healthResp = await fetch(`${sidecarUrl}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (healthResp.ok) {
            const health = (await healthResp.json()) as {
              active_engine?: string;
            };
            f5Active = health.active_engine === "f5tts";
          }
        } catch {
          // not reachable
        }

        // Check if F5-TTS has clips configured
        let f5HasClips = false;
        try {
          const db = getDatabase();
          const clipCount = db
            .prepare(
              `SELECT COUNT(*) as cnt FROM f5tts_clips c
             JOIN voice_profiles p ON c.profile_id = p.id
             WHERE p.engine_type = 'f5tts'`,
            )
            .get() as { cnt: number } | undefined;
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
          available: provider === "google" && ctx.voiceService.isReady(),
          active: provider === "google",
        });
      }

      res.json({ engines });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /voice/analyze-params — use the LLM to recommend optimal F5-TTS
   * parameters based on the complexity/nature of the narration text.
   *
   * Body: { text: string }
   * Returns: { speed, steps, method, cfgStrength, swayCoef, reasoning }
   */
  router.post("/voice/analyze-params", async (req, res) => {
    try {
      const { text, model: bodyModel } = req.body as {
        text?: string;
        model?: string;
      };
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

      const ttsModel = bodyModel || (await getUserSelectedModel());
      let fullResponse = "";
      for await (const chunk of ctx.copilot.chat(
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
      await ctx.copilot.destroySession(conversationId);

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
        method: ["euler", "midpoint", "rk4"].includes(parsed.method ?? "")
          ? parsed.method
          : "rk4",
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
      const {
        text,
        engine,
        model: bodyModel,
      } = req.body as { text?: string; engine?: string; model?: string };
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

${
  isF5
    ? `### Emotion Tags — (Emotion)
F5-TTS can switch between reference audio clips tagged by emotion. Use these to control vocal tone:
- (Regular) — normal, conversational tone (default)
- (Excited) — enthusiastic, energetic delivery
- (Serious) — grave, authoritative tone
- (Whisper) — soft, intimate, secretive
- (Warm) — friendly, empathetic, caring
Place the emotion tag BEFORE the text that should use that tone. It stays active until the next emotion tag.`
    : ""
}

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

      const directiveModel = bodyModel || (await getUserSelectedModel());
      let fullResponse = "";
      for await (const chunk of ctx.copilot.chat(
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
      await ctx.copilot.destroySession(conversationId);

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

  /**
   * POST /scenes/:sceneIndex/enhance-prompt — use the LLM to improve/enhance
   * the image generation prompt for a scene.
   *
   * Body: { prompt: string, context?: string }
   * Returns: { enhanced_prompt: string, thinking: string }
   */
  router.post("/scenes/:sceneIndex/enhance-prompt", async (req, res) => {
    try {
      const {
        prompt,
        context,
        model: bodyModel,
      } = req.body as { prompt?: string; context?: string; model?: string };

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

      const sceneModel = bodyModel || (await getUserSelectedModel());
      let fullResponse = "";
      for await (const chunk of ctx.copilot.chat(
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
      await ctx.copilot.destroySession(conversationId);

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
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/enhance-prompt failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

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
      const row = db
        .prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
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
        (e: { type: string }) =>
          e.type === "image_scene" || e.type === "video_clip",
      );
      if (!scenes[sceneIndex] || !scenes[sceneIndex].src) {
        res.status(404).json({ error: "Scene or scene image not found" });
        return;
      }

      const currentImagePath = scenes[sceneIndex].src as string;
      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(currentImagePath)) {
        res
          .status(404)
          .json({ error: `Source image not found: ${currentImagePath}` });
        return;
      }

      const osMod = await import("node:os");
      const imageOutputDir = path.join(
        osMod.homedir(),
        ".openzigs",
        "director",
        "images",
      );
      const { ImageGenService } =
        await import("../../video/generators/image-gen-service.js");
      const imageGenUserConfig = await ImageGenService.loadUserImageGenConfig();
      const imageService = new ImageGenService({
        outputDir: imageOutputDir,
        ...imageGenUserConfig,
      });
      await imageService.initialize();

      const result = await imageService.enhanceImage(currentImagePath, prompt, {
        strength: strength ?? 0.6,
        model,
        seed,
      });

      // Update the draft manifest with the new image
      scenes[sceneIndex].src = result.filePath;
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(manifestData), now, draftId);

      res.json({
        sceneIndex,
        imagePath: result.filePath,
        generationTimeMs: result.generationTimeMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /scenes/:sceneIndex/img2img failed: ${msg}`,
      );
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
      const { overview, model: bodyModel } = req.body as {
        overview?: string;
        model?: string;
      };

      if (
        !overview ||
        typeof overview !== "string" ||
        overview.trim().length === 0
      ) {
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

      const overviewModel = bodyModel || (await getUserSelectedModel());
      let fullResponse = "";
      for await (const chunk of ctx.copilot.chat(
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
      await ctx.copilot.destroySession(conversationId);

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

      if (
        !inputPath ||
        typeof inputPath !== "string" ||
        inputPath.trim().length === 0
      ) {
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
      const { createDefaultRegistry } =
        await import("../../knowledge/converters/index.js");
      const registry = await createDefaultRegistry();

      if (registry.canConvert(inputPath)) {
        const result = await registry.convert(inputPath);
        if (result.success) {
          extractedText = result.text;
        } else {
          logger.warn(
            `[Director API] Inspiration file conversion failed: ${result.error}`,
          );
        }
      } else {
        // For images, just read them directly
        const imageExts = [
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
          ".gif",
          ".bmp",
          ".tiff",
        ];
        if (imageExts.includes(ext)) {
          extractedImages.push({
            path: inputPath,
            description: pathMod.basename(inputPath),
          });
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
            logger.debug(
              `[Director API] Inspiration image not found: ${imgPath}`,
            );
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
        const imgDir = pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "images",
        );
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
          const tmpDir = pathMod.join(
            osMod.tmpdir(),
            `openzigs-pdfimg-${Date.now()}`,
          );
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
              const outExt =
                pathMod.extname(imgFile).toLowerCase() === ".jpg"
                  ? ".jpg"
                  : ".png";
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
              logger.info(
                `[Director API] Extracted ${extractedImages.length} embedded image(s) from PDF via pdfimages`,
              );
            }
          } catch (err) {
            logger.warn(
              `[Director API] pdfimages extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            await fs
              .rm(tmpDir, { recursive: true, force: true })
              .catch(() => {});
          }
        }

        // Fallback: if no embedded images found, render pages as screenshots
        if (extractedImages.length === 0) {
          let hasMagick = false;
          try {
            await execFileAsync("magick", ["--version"]);
            hasMagick = true;
          } catch {
            logger.debug(
              "[Director API] ImageMagick not available for PDF page rendering",
            );
          }

          if (hasMagick) {
            let pageCount = 0;
            try {
              const { stdout } = await execFileAsync("magick", [
                "identify",
                inputPath,
              ]);
              pageCount = stdout.trim().split("\n").length;
            } catch (err) {
              logger.warn(
                `[Director API] Failed to identify PDF pages: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

            if (pageCount > 0) {
              const maxPages = Math.min(pageCount, 10);
              for (let i = 0; i < maxPages; i++) {
                try {
                  const outName = `insp-pdf-${Date.now()}-page${i + 1}.png`;
                  const outPath = pathMod.join(imgDir, outName);
                  await execFileAsync("magick", [
                    "-density",
                    "200",
                    "-quality",
                    "90",
                    `${inputPath}[${i}]`,
                    "-flatten",
                    "-resize",
                    "1536x1536>",
                    outPath,
                  ]);
                  extractedImages.push({
                    path: outPath,
                    description: `PDF page ${i + 1}`,
                  });
                } catch (err) {
                  logger.warn(
                    `[Director API] PDF page ${i + 1} render failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              if (extractedImages.length > 0) {
                logger.info(
                  `[Director API] Extracted ${extractedImages.length} page image(s) from PDF (fallback)`,
                );
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
        const imgDir = pathMod.join(
          osMod.homedir(),
          ".openzigs",
          "director",
          "images",
        );
        await fs.mkdir(imgDir, { recursive: true });

        const tmpDir = pathMod.join(
          osMod.tmpdir(),
          `openzigs-docximg-${Date.now()}`,
        );
        await fs.mkdir(tmpDir, { recursive: true });
        try {
          // DOCX is a ZIP archive — extract word/media/* which contains embedded images
          await execFileAsync("unzip", [
            "-j",
            "-o",
            inputPath,
            "word/media/*",
            "-d",
            tmpDir,
          ]);
          const tmpFiles = await fs.readdir(tmpDir);
          const imageFiles = tmpFiles
            .filter((f) =>
              /\.(png|jpg|jpeg|gif|bmp|tiff|emf|wmf|svg)$/i.test(f),
            )
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
            logger.info(
              `[Director API] Extracted ${extractedImages.length} embedded image(s) from DOCX`,
            );
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
          const imageList = extractedImages
            .map((img, i) => `${i}: "${img.description}"`)
            .join("\n");
          const descModel = await getUserSelectedModel();
          let descResponse = "";
          for await (const chunk of ctx.copilot.chat(
            `Given these image references from a document, write a concise visual description (1 sentence) for each that would be useful for a hero reel video. If the alt text is already descriptive, refine it. If it's just a filename, infer from context.\n\nImages:\n${imageList}\n\nDocument context (first 1000 chars):\n${extractedText.slice(0, 1000)}\n\nRespond with a JSON array of strings, one description per image. No markdown fences.`,
            {
              conversationId,
              tools: [],
              availableTools: [],
              ...(descModel ? { model: descModel } : {}),
            },
          )) {
            descResponse += chunk;
          }
          await ctx.copilot.destroySession(conversationId);

          const jsonMatch = descResponse.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const descriptions = JSON.parse(jsonMatch[0]) as string[];
            for (
              let i = 0;
              i < Math.min(descriptions.length, extractedImages.length);
              i++
            ) {
              if (descriptions[i] && typeof descriptions[i] === "string") {
                extractedImages[i].description = descriptions[i];
              }
            }
          }
        } catch (descErr) {
          logger.warn(
            `[Director API] Image description generation failed: ${descErr instanceof Error ? descErr.message : String(descErr)}`,
          );
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
      logger.error(
        `[Director API] POST /hero-reel/process-inspiration failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /drafts/:draftId/shorts/propose — Analyze a draft's manifest and propose
   * engaging Short segments via LLM.
   * Body: { maxShorts?: number }
   * Response: { proposals: ShortProposal[] }
   */
  router.post("/drafts/:draftId/shorts/propose", async (req, res) => {
    try {
      const { draftId } = req.params;
      const { maxShorts, model: requestModel } = req.body as {
        maxShorts?: number;
        model?: string;
      };

      const db = getDatabase();
      const row = db
        .prepare(`SELECT title, manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as
        | {
            title: string;
            manifest: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        res.status(500).json({ error: "Corrupt manifest" });
        return;
      }

      const timeline = Array.isArray(manifest.timeline)
        ? manifest.timeline
        : [];
      if (timeline.length === 0) {
        res.status(400).json({ error: "Manifest has no timeline scenes" });
        return;
      }

      const comp = (manifest.composition ?? {}) as Record<string, unknown>;
      const fps = typeof comp.fps === "number" && comp.fps > 0 ? comp.fps : 30;

      // Check if the timeline is a single video_clip — if so, run FFmpeg analysis
      const isSingleVideoClip =
        timeline.length === 1 &&
        (timeline[0] as Record<string, unknown>).type === "video_clip";
      const videoSource = isSingleVideoClip
        ? ((timeline[0] as Record<string, unknown>).source as string) ||
          ((timeline[0] as Record<string, unknown>).src as string) ||
          ""
        : "";

      let totalDurationSec = 0;
      let sceneDescriptions = "";

      const fsMod2 = await import("node:fs");
      if (isSingleVideoClip && videoSource && fsMod2.existsSync(videoSource)) {
        // Run ffprobe + scene detection on the actual video file
        const ffprobeDuration = await new Promise<number>((resolve) => {
          const proc = spawn("ffprobe", [
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            videoSource,
          ]);
          let out = "";
          proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
          proc.on("close", () => {
            const d = parseFloat(out.trim());
            resolve(isNaN(d) ? 0 : d);
          });
          proc.on("error", () => resolve(0));
        });

        totalDurationSec = ffprobeDuration || 60;

        // Scene detection via FFmpeg
        const sceneChanges = await new Promise<
          Array<{ ts: number; score: number }>
        >((resolve) => {
          const proc = spawn("ffmpeg", [
            "-i",
            videoSource,
            "-vf",
            "select='gt(scene,0.3)',showinfo",
            "-f",
            "null",
            "-",
          ]);
          let stderr = "";
          proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
          proc.on("close", () => {
            const changes: Array<{ ts: number; score: number }> = [];
            for (const line of stderr.split("\n")) {
              const ptsMatch = line.match(/pts_time:(\d+\.?\d*)/);
              const sceneMatch = line.match(/scene:(\d+\.?\d*)/);
              if (ptsMatch) {
                changes.push({
                  ts: parseFloat(ptsMatch[1]),
                  score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5,
                });
              }
            }
            resolve(changes);
          });
          proc.on("error", () => resolve([]));
        });

        // Build scene descriptions from detected scene boundaries
        const boundaries = [
          0,
          ...sceneChanges.map((c) => c.ts),
          totalDurationSec,
        ];
        const segments: Array<{ start: number; end: number }> = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
          const start = boundaries[i];
          const end = boundaries[i + 1];
          if (end - start >= 3) segments.push({ start, end });
        }

        if (segments.length === 0) {
          segments.push({ start: 0, end: totalDurationSec });
        }

        sceneDescriptions = segments
          .map(
            (s, i) =>
              `[${i}] (${s.start.toFixed(1)}s–${s.end.toFixed(1)}s, ${Math.round(s.end - s.start)}s) Scene ${i + 1}`,
          )
          .join("\n");
      } else {
        // Multi-scene timeline: use manifest data
        const framesToSec = (raw: unknown): number => {
          if (typeof raw !== "number" || raw <= 0) return 5;
          return raw / fps;
        };

        let cumulativeSec = 0;
        const sceneTimes = timeline.map((s: Record<string, unknown>) => {
          const durSec = framesToSec(s.duration ?? s.durationInFrames);
          const start = cumulativeSec;
          cumulativeSec += durSec;
          return {
            startSec: start,
            endSec: cumulativeSec,
            durationSec: durSec,
          };
        });

        totalDurationSec = cumulativeSec;
        sceneDescriptions = timeline
          .map((s: Record<string, unknown>, i: number) => {
            const text =
              (s.scriptText as string) ||
              (s.title as string) ||
              `Scene ${i + 1}`;
            const src = (s.source as string) || (s.src as string) || "";
            const srcInfo = src ? ` [source: ${path.basename(src)}]` : "";
            return `[${i}] (${sceneTimes[i].startSec.toFixed(1)}s–${sceneTimes[i].endSec.toFixed(1)}s, ${Math.round(sceneTimes[i].durationSec)}s)${srcInfo} ${text.slice(0, 200)}`;
          })
          .join("\n");
      }

      const limit = Math.min(maxShorts || 3, 5);
      const prompt = `You are a viral content strategist. A ${Math.round(totalDurationSec)}-second video/presentation has the following scenes. Your job is to select up to ${limit} SHORT segments (each under 60 seconds) that would make the most engaging YouTube Shorts.

READ each scene's script/description carefully. Identify the most compelling, self-contained ideas that work as standalone Shorts.

SCENES:
${sceneDescriptions}

CRITICAL RULES:
1. Each Short MUST be between 15 and 60 seconds
2. NEVER select the entire video — pick specific interesting segments
3. startTime and endTime are in SECONDS — use the scene timestamps shown above
4. Each Short should cover 1-3 related scenes that tell a complete micro-story
5. Prefer segments with: strong opening hooks, surprising facts, quotable lines, clear takeaways
6. Avoid intro/outro scenes — pick the meaty content in the middle

Return a JSON array only (no markdown, no explanation):
[
  {
    "startTime": 52.4,
    "endTime": 100.4,
    "title": "Catchy Short title",
    "hookText": "Opening text overlay for the Short",
    "ctaText": "Call to action",
    "reason": "Brief explanation of why this segment is engaging",
    "score": 85
  }
]`;

      const chosenModel =
        requestModel || (await getUserSelectedModel()) || undefined;
      const stream = ctx.copilot.chat(prompt, {
        tools: [],
        ...(chosenModel ? { model: chosenModel } : {}),
      });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const rawResponse = chunks.join("").trim();
      logger.info(
        `[Director API] shorts/propose raw LLM (${rawResponse.length} chars): ${rawResponse.slice(0, 500)}`,
      );
      let suggestions: Array<{
        startTime?: number;
        endTime?: number;
        startSceneIndex?: number;
        endSceneIndex?: number;
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
        res
          .status(500)
          .json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      const proposals = suggestions.slice(0, limit).map((s) => {
        let startTime: number;
        let endTime: number;

        if (typeof s.startTime === "number" && typeof s.endTime === "number") {
          startTime = s.startTime;
          endTime = s.endTime;
        } else {
          // Fallback: use proportional mapping when LLM returns scene indices
          startTime = 0;
          endTime = Math.min(totalDurationSec, 60);
        }

        if (endTime - startTime > 60) endTime = startTime + 60;

        return {
          startTime,
          endTime,
          title: s.title,
          hookText: s.hookText,
          ctaText: s.ctaText,
          score: typeof s.score === "number" ? s.score : 80,
          reason: s.reason,
        };
      });

      logger.info(
        `[Director API] shorts/propose returning ${proposals.length} proposals for ${Math.round(totalDurationSec)}s video`,
      );
      res.json({ proposals, totalDurationSec: Math.round(totalDurationSec) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /drafts/:draftId/shorts/propose failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });
}
