import { Router } from "express";
import * as z from "zod";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type {
  OutboxRepository,
  OutboxPlatform,
  OutboxAssetType,
  UpdateOutboxInput,
} from "../outbox/outbox-repository.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import { logger } from "../logging/logger.js";

// ── Validation schemas ──────────────────────────────────────

const VALID_PLATFORMS = [
  "twitter",
  "pinterest",
  "linkedin",
  "youtube",
  "reddit",
  "instagram",
  "facebook",
] as const;
const VALID_ASSET_TYPES = [
  "image",
  "video",
  "audio",
  "document",
  "text",
] as const;

const attachmentSchema = z.object({
  filePath: z.string(),
  filename: z.string(),
  assetType: z.enum(VALID_ASSET_TYPES).optional(),
});

const createOutboxSchema = z.object({
  title: z.string().nullable().optional(),
  asset_id: z.string().nullable().optional(),
  asset_url: z.string().nullable().optional(),
  asset_type: z.enum(VALID_ASSET_TYPES).optional().default("text"),
  content_body: z.string().nullable().optional(),
  attachments: z.array(attachmentSchema).optional().default([]),
  platform: z.enum(VALID_PLATFORMS),
  scheduled_time: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), "Invalid ISO 8601 timestamp"),
  agent_context: z.string().min(1, "Agent context is required"),
  platform_metadata: z.record(z.unknown()).optional().default({}),
  max_retries: z.number().min(0).max(10).optional(),
});

const updateOutboxSchema = z.object({
  title: z.string().nullable().optional(),
  content_body: z.string().nullable().optional(),
  agent_context: z.string().min(1).optional(),
  scheduled_time: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), "Invalid ISO 8601 timestamp")
    .optional(),
  asset_url: z.string().nullable().optional(),
  asset_id: z.string().nullable().optional(),
  asset_type: z.enum(VALID_ASSET_TYPES).optional(),
  attachments: z.array(attachmentSchema).optional(),
  platform_metadata: z.record(z.unknown()).optional(),
});

const batchCreateSchema = z.object({
  items: z.array(createOutboxSchema).min(1).max(50),
});

const listQuerySchema = z.object({
  status: z
    .enum(["pending", "processing", "published", "failed", "canceled"])
    .optional(),
  platform: z.enum(VALID_PLATFORMS).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

const generatePreviewSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  platforms: z
    .array(z.enum(VALID_PLATFORMS))
    .min(1, "At least one platform is required"),
  model: z.string().optional(),
  imageSource: z
    .enum(["extract", "generate", "none"])
    .optional()
    .default("extract"),
});

const enhanceTextSchema = z.object({
  text: z.string().min(1, "Text is required"),
  platforms: z
    .array(z.enum(VALID_PLATFORMS))
    .min(1, "At least one platform is required"),
  model: z.string().optional(),
});

const saveImagesSchema = z.object({
  images: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string().optional(),
      }),
    )
    .min(1)
    .max(10),
});

const enhanceContentSchema = z.object({
  platforms: z
    .array(z.enum(VALID_PLATFORMS))
    .min(1, "At least one platform is required"),
  model: z.string().optional(),
  assetFilename: z.string().optional(),
  assetType: z.string().optional(),
  assetPrompt: z.string().optional(),
  attachments: z
    .array(z.object({ filename: z.string(), assetType: z.string().optional() }))
    .optional(),
  context: z.string().optional(),
});

/** Platform character / format constraints used in the LLM prompt. */
const PLATFORM_CONSTRAINTS: Record<string, string> = {
  twitter: "Max 280 characters. Concise, punchy. Hashtags optional (1-3).",
  linkedin:
    "Max 3000 characters. Professional tone. Can use paragraphs and line breaks.",
  pinterest: "Pin description max 500 characters. Keyword-rich for SEO.",
  reddit: "Title max 300 characters. Body as markdown. Match subreddit tone.",
  youtube: "Title max 100 characters. Description max 5000 characters.",
};

/** Map platform names to the env vars required for publishing. */
const PLATFORM_CREDENTIALS: Record<string, string[]> = {
  twitter: [
    "TWITTER_BEARER_TOKEN",
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_TOKEN_SECRET",
  ],
  pinterest: ["PINTEREST_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_ACCESS_TOKEN"],
  youtube: ["YOUTUBE_API_KEY"],
  reddit: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
  instagram: [
    "INSTAGRAM_ACCESS_TOKEN",
    "FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET",
  ],
  facebook: ["FACEBOOK_PAGE_TOKEN"],
};

const PINTEREST_REPORTS_DIR = path.join(
  os.homedir(),
  ".openzigs",
  "pinterest-reports",
);
const GALLERY_DIR = path.join(os.homedir(), ".openzigs", "gallery");

// ── Router factory ──────────────────────────────────────────

export type OutboxRouterOptions = {
  outboxRepo: OutboxRepository;
  copilotWrapper?: CopilotWrapper;
  mediaQueueRepo?: MediaQueueRepository;
  taskEngine?: TaskEngine;
};

export const createOutboxRouter = ({
  outboxRepo,
  copilotWrapper,
  mediaQueueRepo,
  taskEngine,
}: OutboxRouterOptions): Router => {
  const router = Router();

  // GET /api/admin/outbox/connected-platforms — Which platforms have credentials
  router.get("/connected-platforms", (_req, res) => {
    const result: { platform: string; connected: boolean }[] = [];
    for (const [platform, envVars] of Object.entries(PLATFORM_CREDENTIALS)) {
      const connected =
        envVars.length === 0 || envVars.every((v) => !!process.env[v]?.trim());
      result.push({ platform, connected });
    }
    return res.json({ platforms: result });
  });

  // GET /api/admin/outbox — List outbox items with optional filters
  router.get("/", (req, res) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const items = outboxRepo.list(parsed.data);
      return res.json({ items, total: items.length });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/stats — Counts grouped by status
  router.get("/stats", (_req, res) => {
    try {
      const stats = outboxRepo.getStats();
      return res.json(stats);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/browse — Browse local files for attachment selection
  router.get("/browse", async (req, res) => {
    try {
      const dirParam =
        typeof req.query.dir === "string" ? req.query.dir : os.homedir();
      const resolved = path.resolve(dirParam);

      // Security: only allow paths under the user's home directory
      const home = os.homedir();
      if (!resolved.startsWith(home)) {
        return res
          .status(403)
          .json({ error: "Access denied: path must be under home directory" });
      }

      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return res.json({ dir: resolved, parent: path.dirname(resolved), items });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/generate-preview — AI-generate platform content from URL
  router.post("/generate-preview", async (req, res) => {
    if (!copilotWrapper) {
      return res.status(503).json({ error: "AI backend is not available" });
    }
    try {
      const parsed = generatePreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const { url, platforms, model, imageSource } = parsed.data;

      // ── Gather Pinterest SEO context if pinterest is a target ──
      let pinterestSeoBlock = "";
      if (platforms.includes("pinterest")) {
        pinterestSeoBlock = await loadPinterestSeoContext();
      }

      // ── Fetch page content for AI context + image extraction ──
      let extractedImages: string[] = [];
      let pageTextContent = "";
      try {
        const pageResp = await fetch(url, {
          headers: { "User-Agent": "OpenZigsBot/1.0 (+https://openzigs.com)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (pageResp.ok) {
          const html = await pageResp.text();
          if (imageSource === "extract") {
            extractedImages = extractImagesFromHtml(html, url);
          }
          pageTextContent = extractTextFromHtml(html);
        }
      } catch {
        // Non-fatal: page fetch failure doesn't block content generation
      }

      const constraintsBlock = platforms
        .map(
          (p) =>
            `- ${p}: ${PLATFORM_CONSTRAINTS[p] ?? "No specific constraints."}`,
        )
        .join("\n");

      const prompt = [
        `You are a social media content specialist. A user wants to share the following URL across social platforms.`,
        `URL: ${url}`,
        ``,
        pageTextContent
          ? `Here is the page content (use this to create well-informed, engaging posts):\n---\n${pageTextContent}\n---\n`
          : `Fetch/inspect the content at this URL, then generate platform-appropriate post text.\n`,
        `Generate platform-appropriate post text AND publishing instructions for each platform below.`,
        `Platform constraints:`,
        constraintsBlock,
        pinterestSeoBlock
          ? `\nPinterest SEO context (use to optimize pin description with high-performing keywords):\n${pinterestSeoBlock}`
          : "",
        ``,
        `Return ONLY a valid JSON object (no markdown fences, no explanation) with this exact shape:`,
        `{`,
        `  "previews": {`,
        `    "<platform>": {`,
        `      "text": "<post text>",`,
        `      "publishingInstructions": "<specific instructions for autonomous AI agent to publish on this platform, e.g. target audience, hashtags, subreddit for Reddit, best time to post, etc. For Pinterest do NOT suggest a board name.>"`,
        `    }`,
        `  }`,
        imageSource === "generate"
          ? `, "imagePrompt": "<a concise image generation prompt suitable for the shared content>"`
          : "",
        `}`,
      ].join("\n");

      let result = "";
      for await (const chunk of copilotWrapper.chat(prompt, {
        model: model || undefined,
        availableTools: ["web-search", "browser-navigate"],
      })) {
        result += chunk;
      }

      // Extract JSON from the response (handle markdown fences)
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res
          .status(502)
          .json({ error: "AI did not return valid JSON", raw: result });
      }

      let aiResult: Record<string, unknown>;
      try {
        aiResult = JSON.parse(jsonMatch[0]);
      } catch {
        return res
          .status(502)
          .json({ error: "AI returned invalid JSON", raw: result });
      }

      // Attach extracted images to the response
      if (extractedImages.length > 0) {
        (aiResult as Record<string, unknown>).extractedImages = extractedImages;
      }

      // ── Generate image from prompt if requested ──────────────────────────
      const imagePromptStr =
        typeof aiResult.imagePrompt === "string" ? aiResult.imagePrompt : null;
      if (imageSource === "generate" && imagePromptStr) {
        try {
          const { ImageGenService } =
            await import("../video/generators/image-gen-service.js");
          const userConfig = await ImageGenService.loadUserImageGenConfig();
          const imageGenOutputDir = path.join(
            os.homedir(),
            ".openzigs",
            "gallery",
          );
          await fs.mkdir(imageGenOutputDir, { recursive: true });
          const svc = new ImageGenService({
            ...userConfig,
            outputDir: imageGenOutputDir,
          });

          const genResult = await svc.generateImage(imagePromptStr, {
            width: 1024,
            height: 1024,
          });

          const filename = path.basename(genResult.filePath);
          const imageUrl = `/api/queue/assets/file/${encodeURIComponent(filename)}`;

          // Save to gallery if mediaQueueRepo is available
          if (mediaQueueRepo) {
            const stat = await fs.stat(genResult.filePath);
            mediaQueueRepo.createAsset({
              type: "image",
              filename,
              filePath: genResult.filePath,
              mimeType: "image/png",
              fileSizeBytes: stat.size,
              source: "generated",
              tags: ["ai-generated", "outbox"],
            });
          }

          (aiResult as Record<string, unknown>).generatedImages = [imageUrl];
        } catch (imgErr) {
          // Non-fatal: image gen failure returns prompt for manual use
          const msg = imgErr instanceof Error ? imgErr.message : String(imgErr);
          (aiResult as Record<string, unknown>).imageGenError = msg;
        }
      }

      return res.json(aiResult);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/enhance-text — AI-enhance text content for social platforms
  router.post("/enhance-text", async (req, res) => {
    if (!copilotWrapper) {
      return res.status(503).json({ error: "AI backend is not available" });
    }
    try {
      const parsed = enhanceTextSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const { text, platforms: targetPlatforms, model } = parsed.data;

      const constraintsBlock = targetPlatforms
        .map(
          (p) =>
            `- ${p}: ${PLATFORM_CONSTRAINTS[p] ?? "No specific constraints."}`,
        )
        .join("\n");

      const mentionHints: Record<string, string> = {
        twitter:
          "Use @ for mentions (e.g. @username). Hashtags use # (e.g. #topic).",
        linkedin:
          "Use @ for mentions. No hashtags required but can use # for topics.",
        pinterest: "No @ mentions. Focus on keyword-rich descriptions for SEO.",
        reddit: "Use u/ for user mentions and r/ for subreddits.",
        youtube: "Use @ for channel mentions.",
      };

      const mentionBlock = targetPlatforms
        .map((p) => `- ${p}: ${mentionHints[p] ?? "Standard @ mentions."}`)
        .join("\n");

      const prompt = [
        `You are a social media content specialist. Enhance the following user-written text for social media publishing.`,
        ``,
        `Original text:`,
        `---`,
        text,
        `---`,
        ``,
        `Target platforms: ${targetPlatforms.join(", ")}`,
        ``,
        `Platform constraints:`,
        constraintsBlock,
        ``,
        `Platform mention/callout conventions:`,
        mentionBlock,
        ``,
        `Instructions:`,
        `- Improve the text for engagement while preserving the user's original intent and message.`,
        `- Add relevant hashtags, emojis, or calls to action where appropriate.`,
        `- Use platform-specific mention syntax (@ for Twitter/LinkedIn/YouTube, u/ for Reddit, etc.).`,
        `- If the user included any @ or # references, keep them and format correctly for the platform.`,
        `- Generate a separate optimized version for each platform.`,
        ``,
        `Return ONLY a valid JSON object (no markdown fences, no explanation) with this exact shape:`,
        `{`,
        `  "previews": {`,
        `    "<platform>": {`,
        `      "text": "<enhanced post text for this platform>"`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n");

      let result = "";
      for await (const chunk of copilotWrapper.chat(prompt, {
        model: model || undefined,
      })) {
        result += chunk;
      }

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(500).json({ error: "AI did not return valid JSON" });
      }
      const aiResult = JSON.parse(jsonMatch[0]);
      return res.json(aiResult);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/enhance-content — AI-enhance publishing instructions for gallery/file assets
  router.post("/enhance-content", async (req, res) => {
    if (!copilotWrapper) {
      return res.status(503).json({ error: "AI backend is not available" });
    }
    try {
      const parsed = enhanceContentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const {
        platforms: targetPlatforms,
        model,
        assetFilename,
        assetType,
        assetPrompt,
        attachments,
        context,
      } = parsed.data;

      // Gather Pinterest SEO context if needed
      let pinterestSeoBlock = "";
      if (targetPlatforms.includes("pinterest")) {
        pinterestSeoBlock = await loadPinterestSeoContext();
      }

      const constraintsBlock = targetPlatforms
        .map(
          (p) =>
            `- ${p}: ${PLATFORM_CONSTRAINTS[p] ?? "No specific constraints."}`,
        )
        .join("\n");

      const platformPublishingGuidance: Record<string, string> = {
        twitter:
          "For images: write a short tweet (max 280 chars) with relevant hashtags. For video: write a tweet to accompany the video.",
        linkedin:
          "Write a professional post describing the content. Use line breaks and emojis for readability.",
        pinterest:
          "Write a keyword-rich pin description (max 500 chars) optimized for Pinterest SEO. Include relevant keywords for search discovery. Do NOT suggest a board name — the correct board will be determined automatically at publish time via the Pinterest API.",
        reddit:
          "Suggest a subreddit and title. Keep it conversational and match community tone.",
        youtube:
          "Write a title (max 100 chars) and description. Include relevant tags.",
        instagram:
          "Write an engaging caption with relevant hashtags. Images must be at publicly accessible URLs (JPEG format preferred). Max 2,200 characters.",
        facebook:
          "Write a post suitable for a Facebook Page. Can include text, links, or images. Keep it engaging and on-brand.",
      };

      const publishingGuidanceBlock = targetPlatforms
        .map(
          (p) =>
            `- ${p}: ${platformPublishingGuidance[p] ?? "Write appropriate accompanying text."}`,
        )
        .join("\n");

      // Build asset description
      const assetParts: string[] = [];
      if (assetFilename) assetParts.push(`Filename: ${assetFilename}`);
      if (assetType) assetParts.push(`Type: ${assetType}`);
      if (assetPrompt) assetParts.push(`Description/Prompt: ${assetPrompt}`);
      if (attachments && attachments.length > 0) {
        assetParts.push(
          `Files: ${attachments.map((a) => `${a.filename} (${a.assetType ?? "unknown"})`).join(", ")}`,
        );
      }
      if (context) assetParts.push(`User context: ${context}`);

      const prompt = [
        `You are a social media content specialist. A user wants to publish media content across social platforms.`,
        ``,
        `Asset information:`,
        assetParts.join("\n"),
        ``,
        `Target platforms: ${targetPlatforms.join(", ")}`,
        ``,
        `Platform constraints:`,
        constraintsBlock,
        ``,
        `Platform-specific publishing guidance:`,
        publishingGuidanceBlock,
        pinterestSeoBlock
          ? `\nPinterest SEO context (use to optimize with high-performing keywords):\n${pinterestSeoBlock}`
          : "",
        ``,
        `For each platform, generate:`,
        `1. "text" — The post/caption/description text to accompany this media`,
        `2. "publishingInstructions" — Detailed instructions for an AI agent to publish this content (subreddit for Reddit, hashtags, target audience, etc.). For Pinterest, do NOT include a board name — the board will be determined automatically.`,
        ``,
        `Return ONLY a valid JSON object (no markdown fences, no explanation) with this exact shape:`,
        `{`,
        `  "previews": {`,
        `    "<platform>": {`,
        `      "text": "<post/caption text for this platform>",`,
        `      "publishingInstructions": "<specific agent instructions>"`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n");

      let result = "";
      for await (const chunk of copilotWrapper.chat(prompt, {
        model: model || undefined,
      })) {
        result += chunk;
      }

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(500).json({ error: "AI did not return valid JSON" });
      }
      const aiResult = JSON.parse(jsonMatch[0]);
      return res.json(aiResult);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/save-images — Download images from URLs and save to gallery
  router.post("/save-images", async (req, res) => {
    if (!mediaQueueRepo) {
      return res.status(503).json({ error: "Gallery is not available" });
    }
    try {
      const parsed = saveImagesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }

      await fs.mkdir(GALLERY_DIR, { recursive: true });

      const saved: {
        url: string;
        assetId: string;
        filePath: string;
        filename: string;
      }[] = [];
      for (const img of parsed.data.images) {
        try {
          const imgResp = await fetch(img.url, {
            headers: {
              "User-Agent": "OpenZigsBot/1.0 (+https://openzigs.com)",
            },
            signal: AbortSignal.timeout(30_000),
          });
          if (!imgResp.ok) continue;

          const contentType =
            imgResp.headers.get("content-type") ?? "image/jpeg";
          const ext = contentType.includes("png")
            ? "png"
            : contentType.includes("webp")
              ? "webp"
              : contentType.includes("gif")
                ? "gif"
                : "jpg";
          const safeName = img.filename
            ? path.basename(img.filename)
            : `extracted-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          const filePath = path.join(
            GALLERY_DIR,
            `upload-${Date.now()}-${safeName}`,
          );

          const buffer = Buffer.from(await imgResp.arrayBuffer());
          await fs.writeFile(filePath, buffer);

          const assetId = mediaQueueRepo.createAsset({
            type: "image",
            filename: safeName,
            filePath,
            mimeType: contentType.split(";")[0].trim(),
            fileSizeBytes: buffer.length,
            source: "ingested",
            tags: ["extracted", "outbox"],
          });

          saved.push({ url: img.url, assetId, filePath, filename: safeName });
        } catch {
          // Skip individual image failures
        }
      }

      return res.json({ saved });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/:id — Single item detail
  router.get("/:id", (req, res) => {
    try {
      const item = outboxRepo.getById(req.params.id);
      if (!item) return res.status(404).json({ error: "Not found" });
      return res.json(item);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox — Create a new outbox item
  router.post("/", (req, res) => {
    try {
      const parsed = createOutboxSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const data = parsed.data;
      const item = outboxRepo.insert({
        title: data.title ?? null,
        assetId: data.asset_id ?? null,
        assetUrl: data.asset_url ?? null,
        assetType: data.asset_type as OutboxAssetType,
        contentBody: data.content_body ?? null,
        attachments: data.attachments,
        platform: data.platform as OutboxPlatform,
        scheduledTime: new Date(data.scheduled_time),
        agentContext: data.agent_context,
        platformMetadata: data.platform_metadata,
        maxRetries: data.max_retries,
      });
      return res.status(201).json(item);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/batch — Create multiple outbox items at once
  router.post("/batch", (req, res) => {
    try {
      const parsed = batchCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const created = parsed.data.items.map((data) =>
        outboxRepo.insert({
          title: data.title ?? null,
          assetId: data.asset_id ?? null,
          assetUrl: data.asset_url ?? null,
          assetType: data.asset_type as OutboxAssetType,
          contentBody: data.content_body ?? null,
          attachments: data.attachments,
          platform: data.platform as OutboxPlatform,
          scheduledTime: new Date(data.scheduled_time),
          agentContext: data.agent_context,
          platformMetadata: data.platform_metadata,
          maxRetries: data.max_retries,
        }),
      );
      return res.status(201).json({ items: created, count: created.length });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // PATCH /api/admin/outbox/:id — Update a pending or canceled item
  router.patch("/:id", (req, res) => {
    try {
      const parsed = updateOutboxSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: parsed.error.issues.map((i) => i.message).join(", "),
          });
      }
      const data = parsed.data;
      const updateInput: UpdateOutboxInput = {};
      if (data.title !== undefined) updateInput.title = data.title;
      if (data.content_body !== undefined)
        updateInput.contentBody = data.content_body;
      if (data.agent_context !== undefined)
        updateInput.agentContext = data.agent_context;
      if (data.scheduled_time !== undefined)
        updateInput.scheduledTime = new Date(data.scheduled_time);
      if (data.asset_url !== undefined) updateInput.assetUrl = data.asset_url;
      if (data.asset_id !== undefined) updateInput.assetId = data.asset_id;
      if (data.asset_type !== undefined)
        updateInput.assetType = data.asset_type as OutboxAssetType;
      if (data.attachments !== undefined)
        updateInput.attachments = data.attachments;
      if (data.platform_metadata !== undefined)
        updateInput.platformMetadata = data.platform_metadata;

      const item = outboxRepo.update(req.params.id, updateInput);
      if (!item) {
        return res
          .status(400)
          .json({
            error:
              "Cannot update: item not found or not in editable state (pending/canceled)",
          });
      }
      return res.json(item);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/:id/retry — Retry a failed item
  router.post("/:id/retry", (req, res) => {
    try {
      const item = outboxRepo.retry(req.params.id);
      if (!item)
        return res
          .status(400)
          .json({
            error: "Cannot retry: item not found or not in failed status",
          });
      return res.json(item);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/:id/cancel — Cancel a pending or failed item
  router.post("/:id/cancel", (req, res) => {
    try {
      const item = outboxRepo.cancel(req.params.id);
      if (!item)
        return res
          .status(400)
          .json({
            error:
              "Cannot cancel: item not found or not in pending/failed status",
          });
      return res.json(item);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/:id/publish — Immediately publish a pending item
  // Body: { notifyChannels?: ("telegram" | "discord")[] }
  router.post("/:id/publish", (req, res) => {
    if (!taskEngine) {
      return res.status(503).json({ error: "Task engine not available" });
    }
    try {
      const item = outboxRepo.getById(req.params.id);
      if (!item) return res.status(404).json({ error: "Item not found" });
      if (item.status !== "pending") {
        return res
          .status(400)
          .json({
            error: `Cannot publish: item is ${item.status}, must be pending`,
          });
      }

      // Parse optional notification channels from body
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const notifyChannels = Array.isArray(body.notifyChannels)
        ? (body.notifyChannels as string[]).filter(
            (c) => c === "telegram" || c === "discord",
          )
        : [];

      // Claim the item (mark as processing)
      const now = new Date().toISOString();
      outboxRepo.updateStatus(item.id, "processing", now);

      // Resolve assetId to actual file path if available
      let resolvedAssetPath: string | null = null;
      if (item.assetId && mediaQueueRepo) {
        const asset = mediaQueueRepo.getAsset(item.assetId);
        if (asset?.file_path) resolvedAssetPath = String(asset.file_path);
      }

      // Submit task to engine (same logic as OutboxPoller)
      const goal = [
        `Publish content to ${item.platform}.`,
        item.agentContext,
        item.contentBody
          ? `Pre-approved content (use exactly as-is):\n${item.contentBody}`
          : null,
        item.assetUrl ? `Asset URL: ${item.assetUrl}` : null,
        resolvedAssetPath
          ? `Image file path: ${resolvedAssetPath}`
          : item.assetId
            ? `Asset ID: ${item.assetId}`
            : null,
        item.attachments && item.attachments.length > 0
          ? `Attachments (include these with the post):\n${item.attachments.map((a) => `- ${a.filename} (${a.filePath})`).join("\n")}`
          : null,
        `Outbox Item ID: ${item.id}`,
        `Platform metadata: ${JSON.stringify(item.platformMetadata)}`,
        item.platform === "pinterest"
          ? `IMPORTANT: You MUST call pinterest-list-boards FIRST to get the user's actual boards. IGNORE any board name mentioned anywhere in these instructions — they are AI-generated suggestions and likely wrong. Use ONLY a board_id returned by pinterest-list-boards. The user's board is retrieved from the API, not from the publishing instructions. Pick the most relevant board from the list, or use the first one if unsure.`
          : null,
        notifyChannels.length > 0
          ? `Notify via: ${notifyChannels.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      const autoApprove = [
        "update-outbox-status",
        "pinterest-list-boards",
        "fb_publish_post",
        "publish_media",
      ];
      if (notifyChannels.length > 0) autoApprove.push("send-notification");

      taskEngine.submit(
        {
          trigger: "cron",
          goal,
          context: `Outbox item ${item.id} for ${item.platform} (publish-now)`,
          skillName: "universal-publisher",
          autoApproveTools: autoApprove,
          allowedTools: [
            "update-outbox-status",
            "social-post",
            "twitter-post-tweet",
            "linkedin-create-post",
            "reddit-submit-post",
            "youtube-upload-video",
            "pinterest-list-boards",
            "pinterest-create-pin",
            "fb_publish_post",
            "publish_media",
            "send-notification",
            "web-search",
            "browser-navigate",
            "read-file",
            "shell-execute",
          ],
        },
        { mode: "background" },
      );

      logger.info(
        `Outbox publish-now submitted for item ${item.id} → ${item.platform}`,
      );
      const updated = outboxRepo.getById(item.id);
      return res.json(updated);
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // DELETE /api/admin/outbox/:id — Delete an item
  router.delete("/:id", (req, res) => {
    try {
      const deleted = outboxRepo.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Not found" });
      return res.json({ ok: true });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  return router;
};

// ── Helper functions ────────────────────────────────────────

/** Extract image URLs from HTML meta tags (og:image, twitter:image, etc.) */
function extractImagesFromHtml(html: string, baseUrl: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  const addImage = (raw: string) => {
    try {
      const imgUrl = new URL(raw, baseUrl).href;
      if (seen.has(imgUrl)) return;
      seen.add(imgUrl);
      images.push(imgUrl);
    } catch {
      // skip invalid URLs
    }
  };

  // 1. og:image / twitter:image meta tags (highest priority — curated hero images)
  const metaPatterns = [
    /property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/gi,
    /content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/gi,
    /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/gi,
    /content=["']([^"']+)["'][^>]*name=["']twitter:image["']/gi,
  ];
  for (const pattern of metaPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      addImage(match[1]);
    }
  }

  // 2. Content <img> tags — extract src from all img elements
  const imgTagPattern = /<img\s[^>]*?src=["']([^"']+)["'][^>]*?>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgTagPattern.exec(html)) !== null) {
    const src = imgMatch[1];
    // Skip common non-content images
    if (/\.(svg|ico)(\?|$)/i.test(src)) continue; // icons
    if (/gravatar\.com|pixel|tracker|analytics|beacon/i.test(src)) continue; // tracking
    if (/data:image/i.test(src)) continue; // inline data URIs
    if (/1x1|spacer|blank/i.test(src)) continue; // spacer pixels

    // Check for explicit tiny dimensions in the tag (skip icons/badges)
    const fullTag = imgMatch[0];
    const widthMatch = fullTag.match(/width=["']?(\d+)/i);
    const heightMatch = fullTag.match(/height=["']?(\d+)/i);
    if (widthMatch && parseInt(widthMatch[1]) < 80) continue;
    if (heightMatch && parseInt(heightMatch[1]) < 80) continue;

    addImage(src);
  }

  // 3. Lazy-loaded images: data-src, data-lazy-src, data-original attributes
  const lazyPatterns = [
    /<img\s[^>]*?data-src=["']([^"']+)["'][^>]*?>/gi,
    /<img\s[^>]*?data-lazy-src=["']([^"']+)["'][^>]*?>/gi,
    /<img\s[^>]*?data-original=["']([^"']+)["'][^>]*?>/gi,
  ];
  for (const pattern of lazyPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const src = match[1];
      if (/\.(svg|ico)(\?|$)/i.test(src)) continue;
      if (/data:image/i.test(src)) continue;
      addImage(src);
    }
  }

  // 4. WordPress srcset — pick the largest variant from srcset attributes
  const srcsetPattern = /<img\s[^>]*?srcset=["']([^"']+)["'][^>]*?>/gi;
  let srcsetMatch: RegExpExecArray | null;
  while ((srcsetMatch = srcsetPattern.exec(html)) !== null) {
    const entries = srcsetMatch[1].split(",").map((s) => s.trim());
    // Parse "url 600w" entries and pick the widest
    let best = "";
    let bestW = 0;
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      const w = parseInt(parts[1]?.replace("w", "") ?? "0");
      if (w > bestW) {
        bestW = w;
        best = parts[0];
      }
    }
    if (best && bestW >= 300) addImage(best);
  }

  return images.slice(0, 20);
}

/** Strip HTML tags and extract readable text content, truncated for LLM context. */
function extractTextFromHtml(html: string): string {
  // Remove script, style, nav, header, footer elements
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Replace block-level tags with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n");
  // Remove all remaining tags (loop to catch nested/malformed tags)
  let prev = "";
  while (text !== prev) {
    prev = text;
    text = text.replace(/<[^>]+>/g, " ");
  }
  // Decode common HTML entities (&amp; decoded LAST to prevent double-decoding)
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  // Normalize whitespace
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  // Truncate to ~4000 chars to avoid bloating the prompt
  return text.length > 4000 ? text.slice(0, 4000) + "..." : text;
}

/** Load the latest Pinterest SEO report context (keyword-metrics or seo-analysis). */
async function loadPinterestSeoContext(): Promise<string> {
  try {
    if (!fsSync.existsSync(PINTEREST_REPORTS_DIR)) return "";

    const files = fsSync
      .readdirSync(PINTEREST_REPORTS_DIR)
      .filter(
        (f) =>
          (f.startsWith("seo-analysis-") || f.startsWith("keyword-metrics-")) &&
          f.endsWith(".json"),
      )
      .sort()
      .reverse();

    if (files.length === 0) return "";

    const content = fsSync.readFileSync(
      path.join(PINTEREST_REPORTS_DIR, files[0]),
      "utf-8",
    );
    const data = JSON.parse(content) as Record<string, unknown>;

    // Extract top keywords from the report
    const keywords: string[] = [];
    if (Array.isArray(data.keywords)) {
      for (const kw of data.keywords.slice(0, 15)) {
        if (typeof kw === "object" && kw !== null && "keyword" in kw) {
          keywords.push(String((kw as Record<string, unknown>).keyword));
        }
      }
    }
    if (Array.isArray(data.recommended_keywords)) {
      for (const kw of data.recommended_keywords.slice(0, 10)) {
        keywords.push(String(kw));
      }
    }

    if (keywords.length === 0) return "";
    return `Top-performing Pinterest keywords for this account: ${keywords.join(", ")}`;
  } catch {
    return "";
  }
}
