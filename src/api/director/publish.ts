/**
 * Publish / distribution routes for Director Mode.
 *
 * Owns YouTube publication, status polling, history, category lookup,
 * metadata generation, and channel/video analytics. Extracted from
 * `director.ts` as part of epic #1113 (sub-issue #1164).
 */
import path from "node:path";
import os from "node:os";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../../logging/logger.js";
import { getDatabase } from "../../productivity/database.js";
import { getUserSelectedModel } from "../../config/user-model.js";
import type { DirectorContext } from "./context.js";

export function registerPublishRoutes(
  router: Router,
  ctx: DirectorContext,
): void {
  // Lazy-init YouTube publish service
  let _youtubePublishService:
    | import("../../video/youtube-publish-service.js").YouTubePublishService
    | null = null;

  async function getYouTubePublishService() {
    if (!_youtubePublishService) {
      const { YouTubePublishService } =
        await import("../../video/youtube-publish-service.js");
      const { YouTubePublishRepository } =
        await import("../../video/youtube-publish-repository.js");
      const publishRepo = new YouTubePublishRepository(getDatabase());
      _youtubePublishService = new YouTubePublishService({
        toolRegistry: ctx.toolRegistry!,
        publishRepo,
        io: ctx.io(),
        db: getDatabase(),
      });
    }
    return _youtubePublishService;
  }

  const youtubePublishSchema = z.object({
    draftId: z
      .string({ required_error: "draftId is required" })
      .min(1, "draftId is required"),
    filePath: z.string().optional(),
    title: z
      .string({ required_error: "title is required" })
      .min(1, "title is required")
      .transform((s) => s.trim()),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    categoryId: z.string().optional(),
    privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
    notifySubscribers: z.boolean().optional(),
    scheduledPublishTime: z.string().optional(),
  });

  const YOUTUBE_PUBLISH_ALLOWED_DIRS = [
    path.join(os.homedir(), ".openzigs", "video-output"),
    path.join(os.homedir(), ".openzigs", "renders"),
  ];

  // YouTube analytics cache table (idempotent)
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

  function getAnalyticsCache(
    key: string,
  ): { data: unknown; fetchedAt: Date } | null {
    try {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT data, fetched_at FROM youtube_analytics_cache WHERE key = ?`,
        )
        .get(key) as { data: string; fetched_at: number } | undefined;
      if (!row) return null;
      return {
        data: JSON.parse(row.data),
        fetchedAt: new Date(row.fetched_at),
      };
    } catch {
      return null;
    }
  }

  function setAnalyticsCache(key: string, data: unknown): void {
    try {
      const db = getDatabase();
      db.prepare(
        `INSERT OR REPLACE INTO youtube_analytics_cache (key, data, fetched_at) VALUES (?, ?, ?)`,
      ).run(key, JSON.stringify(data), Date.now());
    } catch {
      // Non-fatal — cache write failure shouldn't break the response
    }
  }

  /**
   * POST /youtube/publish — Start a YouTube publish job for a draft.
   * Body: { draftId, filePath?, title, description?, tags?, categoryId?, privacyStatus?, notifySubscribers?, scheduledPublishTime? }
   */
  router.post("/youtube/publish", async (req, res) => {
    try {
      if (!ctx.toolRegistry) {
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }

      const parsed = youtubePublishSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }

      const {
        draftId,
        filePath,
        title,
        description,
        tags,
        categoryId,
        privacyStatus,
        notifySubscribers,
        scheduledPublishTime,
      } = parsed.data;

      // Path traversal guard: filePath must resolve to an allowed directory
      if (filePath) {
        const resolved = path.resolve(
          filePath.startsWith("~")
            ? path.join(os.homedir(), filePath.slice(1))
            : filePath,
        );
        const allowed = YOUTUBE_PUBLISH_ALLOWED_DIRS.some(
          (dir) => resolved.startsWith(dir + path.sep) || resolved === dir,
        );
        if (!allowed) {
          res
            .status(403)
            .json({ error: "File path is outside allowed directories" });
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
      logger.error(
        `[Director API] GET /youtube/publish history failed: ${msg}`,
      );
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
      const { draftId, model: bodyModel } = req.body as {
        draftId?: string;
        model?: string;
      };

      if (!draftId || typeof draftId !== "string") {
        res.status(400).json({ error: "draftId is required" });
        return;
      }

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

      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(row.manifest);
      } catch {
        // non-fatal
      }

      // Extract narration text and scene descriptions from the manifest
      const timeline = Array.isArray(manifest.timeline)
        ? manifest.timeline
        : [];
      const narrationParts: string[] = [];
      const sceneDescriptions: string[] = [];
      for (const entry of timeline) {
        if (entry.scriptText) narrationParts.push(entry.scriptText);
        if (entry.title) sceneDescriptions.push(entry.title);
      }

      // Generate chapter text for context
      const { generateChapters, formatChaptersForDescription } =
        await import("../../video/youtube-chapters.js");
      const chapters = generateChapters(
        manifest as import("../../video/youtube-chapters.js").ManifestForChapters,
      );
      const chapterText = formatChaptersForDescription(chapters);

      const seoModel = bodyModel || (await getUserSelectedModel());
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

      const stream = ctx.copilot.chat(prompt, {
        tools: [],
        ...(seoModel ? { model: seoModel } : {}),
      });
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
        res
          .status(500)
          .json({ error: "Failed to parse LLM response", raw: rawResponse });
        return;
      }

      // Validate and sanitize the response
      const generatedTitle =
        typeof parsed.title === "string"
          ? parsed.title.slice(0, 100)
          : row.title;
      const generatedDescription =
        typeof parsed.description === "string"
          ? parsed.description.slice(0, 5000)
          : "";
      const generatedTags = Array.isArray(parsed.tags)
        ? parsed.tags.filter((t: unknown) => typeof t === "string").slice(0, 30)
        : [];
      const suggestedCategory =
        typeof parsed.suggestedCategory === "string"
          ? parsed.suggestedCategory
          : "Education";

      res.json({
        title: generatedTitle,
        description: generatedDescription,
        tags: generatedTags,
        suggestedCategory,
        chapters: chapterText || null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] POST /youtube/generate-metadata failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  router.get("/youtube/analytics/channel", async (_req, res) => {
    const CACHE_KEY = "channel";
    try {
      if (!ctx.toolRegistry) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }
      // Use channel-info tool (returns snippet + statistics) instead of channel-analytics (stats only)
      const tool = ctx.toolRegistry.getToolDefinition(
        "youtube-get-channel-info",
      );
      if (!tool) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res
          .status(503)
          .json({ error: "youtube-get-channel-info tool not registered" });
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
          thumbnailUrl:
            snippet.thumbnails?.default?.url ??
            snippet.thumbnails?.medium?.url ??
            "",
        };
        setAnalyticsCache(CACHE_KEY, data);
      } catch (liveErr) {
        const msg =
          liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn(
          `[Director API] YouTube channel analytics live fetch failed: ${msg} — falling back to cache`,
        );
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res.status(502).json({ error: msg });
        return;
      }
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] GET /youtube/analytics/channel failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });

  router.get("/youtube/analytics/videos", async (req, res) => {
    const maxResults =
      typeof req.query.maxResults === "string"
        ? req.query.maxResults
        : undefined;
    const limit =
      typeof req.query.limit === "string" ? req.query.limit : undefined;
    const max = parseInt(maxResults ?? limit ?? "50", 10) || 50;
    const CACHE_KEY = `videos:${max}`;
    try {
      if (!ctx.toolRegistry) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res.status(503).json({ error: "Tool registry not available" });
        return;
      }
      const listTool = ctx.toolRegistry.getToolDefinition(
        "youtube-get-channel-videos",
      );
      const detailTool = ctx.toolRegistry.getToolDefinition(
        "youtube-get-video-details",
      );
      if (!listTool) {
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res
          .status(503)
          .json({ error: "youtube-get-channel-videos tool not registered" });
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
            if (id && typeof id === "object")
              return (id as Record<string, string>).videoId;
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
            const snippet =
              ((item as Record<string, unknown>).snippet as
                | Record<string, unknown>
                | undefined) ?? {};
            const stats =
              ((item as Record<string, unknown>).statistics as
                | Record<string, unknown>
                | undefined) ?? {};
            const contentDetails =
              ((item as Record<string, unknown>).contentDetails as
                | Record<string, unknown>
                | undefined) ?? {};
            videos.push({
              videoId: (item as Record<string, string>).id ?? "",
              title: (snippet as Record<string, string>).title ?? "",
              publishedAt:
                (snippet as Record<string, string>).publishedAt ?? "",
              viewCount: Number(
                (stats as Record<string, string>).viewCount ?? 0,
              ),
              likeCount: Number(
                (stats as Record<string, string>).likeCount ?? 0,
              ),
              commentCount: Number(
                (stats as Record<string, string>).commentCount ?? 0,
              ),
              duration:
                (contentDetails as Record<string, string>).duration ?? "",
              thumbnailUrl:
                (
                  snippet as Record<
                    string,
                    Record<string, Record<string, string>>
                  >
                ).thumbnails?.medium?.url ?? "",
              likeRatio:
                Number((stats as Record<string, string>).likeCount ?? 0) > 0
                  ? Number((stats as Record<string, string>).likeCount ?? 0) /
                    (Number((stats as Record<string, string>).likeCount ?? 0) +
                      Number(
                        (stats as Record<string, string>).dislikeCount ?? 0,
                      ) || 1)
                  : 0,
            });
          }
          data = { videos };
        } else {
          // No detail tool — return basic info from search results
          const videos = searchItems.map((item: Record<string, unknown>) => {
            const snippet =
              (item.snippet as Record<string, unknown> | undefined) ?? {};
            const id = item.id as Record<string, unknown> | string | undefined;
            const videoId =
              typeof id === "string"
                ? id
                : ((id as Record<string, string>)?.videoId ?? "");
            return {
              videoId,
              title: (snippet as Record<string, string>).title ?? "",
              publishedAt:
                (snippet as Record<string, string>).publishedAt ?? "",
              viewCount: 0,
              likeCount: 0,
              commentCount: 0,
              duration: "",
              thumbnailUrl:
                (
                  snippet as Record<
                    string,
                    Record<string, Record<string, string>>
                  >
                ).thumbnails?.medium?.url ?? "",
              likeRatio: 0,
            };
          });
          data = { videos };
        }
        setAnalyticsCache(CACHE_KEY, data);
      } catch (liveErr) {
        const msg =
          liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn(
          `[Director API] YouTube videos analytics live fetch failed: ${msg} — falling back to cache`,
        );
        const cached = getAnalyticsCache(CACHE_KEY);
        if (cached) {
          res.json({
            ...(cached.data as object),
            _cached: true,
            _cachedAt: cached.fetchedAt.toISOString(),
          });
          return;
        }
        res.status(502).json({ error: msg });
        return;
      }
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Director API] GET /youtube/analytics/videos failed: ${msg}`,
      );
      res.status(500).json({ error: msg });
    }
  });
}
