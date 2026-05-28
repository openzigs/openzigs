/**
 * YouTube Publish Service — orchestrates video uploads to YouTube via MCP tool registry.
 * Issue #513: Calls yt_upload_video MCP tool, tracks progress via Socket.IO, manages publish lifecycle.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import { extractSubtitleSegments, generateSrt } from "./subtitle-export.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { YouTubePublishRepository } from "./youtube-publish-repository.js";
import type { Server as SocketIOServer } from "socket.io";
import type Database from "better-sqlite3";

/** Resolve ~ to the user's home directory. */
function resolvePath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export interface YouTubePublishRequest {
  draftId: string;
  filePath?: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "public" | "unlisted" | "private";
  notifySubscribers?: boolean;
  scheduledPublishTime?: string;
  skipAutoThumbnail?: boolean;
}

export interface YouTubePublishResult {
  publishId: string;
  videoId: string | null;
  videoUrl: string | null;
  status: "published" | "failed" | "scheduled";
  error?: string;
}

export interface YouTubePublishServiceOptions {
  toolRegistry: ToolRegistry;
  publishRepo: YouTubePublishRepository;
  io?: SocketIOServer | null;
  db?: Database.Database | null;
}

export class YouTubePublishService {
  private readonly toolRegistry: ToolRegistry;
  private readonly publishRepo: YouTubePublishRepository;
  private io: SocketIOServer | null;
  private readonly db: Database.Database | null;

  constructor({
    toolRegistry,
    publishRepo,
    io,
    db,
  }: YouTubePublishServiceOptions) {
    this.toolRegistry = toolRegistry;
    this.publishRepo = publishRepo;
    this.io = io ?? null;
    this.db = db ?? null;
  }

  setIO(io: SocketIOServer): void {
    this.io = io;
  }

  /**
   * Publish a video to YouTube.
   * Looks up the rendered MP4 from the default output path if not provided.
   */
  /** Allowed base directories for video file paths (defense-in-depth). */
  private static readonly ALLOWED_DIRS = [
    resolvePath("~/.openzigs/video-output"),
    resolvePath("~/.openzigs/renders"),
  ];

  async publish(request: YouTubePublishRequest): Promise<YouTubePublishResult> {
    const publishId = nanoid(12);
    const now = new Date().toISOString();

    // Resolve the video file path
    const filePath = request.filePath
      ? resolvePath(request.filePath)
      : this.resolveRenderOutputPath(request.draftId);

    // Defense-in-depth: validate file path is within allowed directories
    if (filePath) {
      const resolved = path.resolve(filePath);
      const allowed = YouTubePublishService.ALLOWED_DIRS.some(
        (dir) => resolved.startsWith(dir + path.sep) || resolved === dir,
      );
      if (!allowed) {
        const errorMsg = "File path is outside allowed directories";
        this.publishRepo.insert({
          id: publishId,
          draft_id: request.draftId,
          video_id: null,
          video_url: null,
          title: request.title,
          privacy_status: request.privacyStatus ?? "private",
          published_at: null,
          status: "failed",
          error_message: errorMsg,
          created_at: now,
          updated_at: now,
        });
        return {
          publishId,
          videoId: null,
          videoUrl: null,
          status: "failed",
          error: errorMsg,
        };
      }
    }
    if (!filePath || !fs.existsSync(filePath)) {
      const errorMsg = `Video file not found: ${filePath ?? "(no render output)"}`;
      this.publishRepo.insert({
        id: publishId,
        draft_id: request.draftId,
        video_id: null,
        video_url: null,
        title: request.title,
        privacy_status: request.privacyStatus ?? "private",
        published_at: null,
        status: "failed",
        error_message: errorMsg,
        created_at: now,
        updated_at: now,
      });
      return {
        publishId,
        videoId: null,
        videoUrl: null,
        status: "failed",
        error: errorMsg,
      };
    }

    // Create the publish record in uploading state
    this.publishRepo.insert({
      id: publishId,
      draft_id: request.draftId,
      video_id: null,
      video_url: null,
      title: request.title,
      privacy_status: request.privacyStatus ?? "private",
      published_at: null,
      status: "uploading",
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    // Emit progress event
    this.emitProgress(request.draftId, publishId, "uploading", 0);

    try {
      // Invoke through the registry so the publish flows through the audit log.
      // The Node-native youtube-upload-video tool returns the same
      // { success, data: { video_id, url } } envelope the sidecar version did.
      const result = await this.toolRegistry.invokeTool(
        "youtube-upload-video",
        {
          file_path: filePath,
          title: request.title,
          description: request.description ?? "",
          tags: request.tags ?? [],
          category_id: request.categoryId ?? "22",
          privacy_status: request.privacyStatus ?? "private",
          notify_subscribers: request.notifySubscribers ?? true,
        },
        { source: "director-studio" },
      );

      if (result.isError) {
        throw new Error(result.text);
      }

      // Parse the MCP tool response
      const response = JSON.parse(result.text) as {
        success: boolean;
        data?: { id?: string; video_id?: string; url?: string };
        error?: string;
      };

      if (!response.success) {
        throw new Error(response.error ?? "Upload failed");
      }

      const videoId = response.data?.video_id ?? response.data?.id ?? null;
      const videoUrl = videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : (response.data?.url ?? null);
      const finalStatus = request.scheduledPublishTime
        ? "scheduled"
        : "published";

      // Update publish record
      this.publishRepo.updateStatus(publishId, finalStatus, {
        video_id: videoId,
        video_url: videoUrl,
        published_at: now,
      });

      this.emitComplete(request.draftId, publishId, videoId, videoUrl);

      // Try to set thumbnail if one exists
      await this.trySetThumbnail(
        request.draftId,
        videoId,
        filePath,
        request.title,
        request.skipAutoThumbnail,
      );

      // Try to upload captions if the draft has subtitles
      if (videoId) {
        const srtContent = this.generateSrtForDraft(request.draftId);
        if (srtContent) {
          // Fire and forget — caption upload failure should not block publish success.
          // Delay 15s: YouTube may reject caption uploads with 404 while the video is
          // still processing after upload. A brief wait reduces spurious failures;
          // users can also retry manually via the UI.
          const captionDelay = new Promise<void>((r) => setTimeout(r, 15_000));
          captionDelay
            .then(() => this.uploadCaptions(publishId))
            .catch((err) => {
              logger.warn(
                `[YouTubePublish] Auto caption upload failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }

      logger.info(
        `[YouTubePublish] Published ${publishId} → ${videoId ?? "unknown"}`,
      );
      return { publishId, videoId, videoUrl, status: finalStatus };
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const errorMsg = YouTubePublishService.parseYouTubeError(rawMsg);
      this.publishRepo.updateStatus(publishId, "failed", {
        error_message: errorMsg,
      });
      this.emitError(request.draftId, publishId, errorMsg);
      logger.error(`[YouTubePublish] Failed ${publishId}: ${errorMsg}`);
      return {
        publishId,
        videoId: null,
        videoUrl: null,
        status: "failed",
        error: errorMsg,
      };
    }
  }

  /** Get publish status for a draft. */
  getPublishStatus(draftId: string): {
    status: string;
    publishId?: string;
    videoId?: string;
    videoUrl?: string;
    error?: string;
  } | null {
    const latest = this.publishRepo.getLatestByDraftId(draftId);
    if (!latest) return null;
    return {
      status: latest.status,
      publishId: latest.id,
      videoId: latest.video_id ?? undefined,
      videoUrl: latest.video_url ?? undefined,
      error: latest.error_message ?? undefined,
    };
  }

  /** Get all publishes for a draft. */
  getPublishHistory(draftId: string) {
    return this.publishRepo.getByDraftId(draftId);
  }

  /**
   * Check whether a previously published YouTube video still exists.
   * If the video has been deleted from YouTube, updates the publish record status to "deleted".
   * Returns the updated status.
   */
  async checkVideoExists(
    publishId: string,
  ): Promise<{ exists: boolean; status: string }> {
    const record = this.publishRepo.getById(publishId);
    if (!record) {
      return { exists: false, status: "not_found" };
    }
    if (!record.video_id) {
      return { exists: false, status: record.status };
    }

    const tool = this.toolRegistry.getToolDefinition(
      "youtube-check-video-exists",
    );
    if (!tool) {
      logger.warn(
        "[YouTubePublish] youtube-check-video-exists tool not available",
      );
      return { exists: true, status: record.status };
    }

    try {
      const result = await this.toolRegistry.invokeTool(
        "youtube-check-video-exists",
        { video_id: record.video_id },
        { source: "director-studio" },
      );
      if (result.isError) {
        logger.warn(
          `[YouTubePublish] Video existence check failed: ${result.text}`,
        );
        return { exists: true, status: record.status };
      }

      const response = JSON.parse(result.text) as {
        success: boolean;
        data?: { exists: boolean };
      };
      const exists = response.data?.exists ?? true;

      if (!exists && record.status === "published") {
        this.publishRepo.updateStatus(publishId, "deleted");
        this.io?.emit("youtube:publish:status-changed", {
          draftId: record.draft_id,
          publishId,
          status: "deleted",
        });
        logger.info(
          `[YouTubePublish] Video ${record.video_id} no longer exists, marked as deleted`,
        );
        return { exists: false, status: "deleted" };
      }

      return { exists, status: record.status };
    } catch (error) {
      logger.warn(
        `[YouTubePublish] Video existence check error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { exists: true, status: record.status };
    }
  }

  /**
   * Upload SRT captions to YouTube for a published video.
   * Reads the manifest from the draft to generate subtitle content.
   */
  async uploadCaptions(
    publishId: string,
    options?: { language?: string; captionName?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const record = this.publishRepo.getById(publishId);
    if (!record?.video_id) {
      return { success: false, error: "No video ID found for this publish" };
    }

    const srtContent = this.generateSrtForDraft(record.draft_id);
    if (!srtContent) {
      return {
        success: false,
        error: "No subtitle content available for this draft",
      };
    }

    const tool = this.toolRegistry.getToolDefinition("youtube-upload-captions");
    if (!tool) {
      return {
        success: false,
        error: "youtube-upload-captions tool not available",
      };
    }

    try {
      const result = await this.toolRegistry.invokeTool(
        "youtube-upload-captions",
        {
          video_id: record.video_id,
          language: options?.language ?? "en",
          caption_name: options?.captionName ?? "English",
          srt_content: srtContent,
        },
        { source: "director-studio" },
      );

      if (result.isError) {
        return { success: false, error: result.text };
      }

      const response = JSON.parse(result.text) as {
        success: boolean;
        error?: string;
      };
      if (!response.success) {
        return {
          success: false,
          error: response.error ?? "Caption upload failed",
        };
      }

      logger.info(
        `[YouTubePublish] Captions uploaded for video ${record.video_id}`,
      );
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[YouTubePublish] Caption upload failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Generate SRT content for a draft by reading its manifest from the DB.
   */
  generateSrtForDraft(draftId: string): string | null {
    if (!this.db) return null;

    try {
      const row = this.db
        .prepare(`SELECT manifest FROM director_drafts WHERE id = ?`)
        .get(draftId) as { manifest: string } | undefined;

      if (!row?.manifest) return null;

      const manifest = JSON.parse(row.manifest);
      const segments = extractSubtitleSegments(manifest);
      if (segments.length === 0) return null;

      return generateSrt(segments);
    } catch (error) {
      logger.warn(
        `[YouTubePublish] Failed to generate SRT for draft ${draftId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────

  private resolveRenderOutputPath(draftId: string): string | null {
    // 1. Query director_renders for the latest completed render for this draft
    if (this.db) {
      try {
        const row = this.db
          .prepare(
            `SELECT output_path FROM director_renders WHERE draft_id = ? AND status = 'complete' AND output_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          )
          .get(draftId) as { output_path: string } | undefined;
        if (row?.output_path && fs.existsSync(row.output_path)) {
          logger.debug(
            `[YouTubePublish] Resolved render path from DB: ${row.output_path}`,
          );
          return row.output_path;
        }
      } catch (err) {
        logger.warn(
          `[YouTubePublish] DB lookup for render path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Scan renders directory for any .mp4 file (not just output.mp4)
    const rendersDir = resolvePath("~/.openzigs/renders");
    if (fs.existsSync(rendersDir)) {
      try {
        const entries = fs.readdirSync(rendersDir, { withFileTypes: true });
        for (const entry of entries.reverse()) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(rendersDir, entry.name);
          const files = fs.readdirSync(subDir);
          const mp4 = files.find((f) => f.endsWith(".mp4"));
          if (mp4) {
            return path.join(subDir, mp4);
          }
        }
      } catch {
        // If we can't read the renders dir, fall back to video-output
      }
    }

    // 3. Legacy path
    const legacyPath = resolvePath(
      `~/.openzigs/video-output/${draftId}/output.mp4`,
    );
    if (fs.existsSync(legacyPath)) return legacyPath;

    return null;
  }

  private async trySetThumbnail(
    draftId: string,
    videoId: string | null,
    videoFilePath?: string,
    videoTitle?: string,
    skipAutoThumbnail?: boolean,
  ): Promise<void> {
    if (!videoId) return;

    const thumbnailDir = resolvePath("~/.openzigs/video-output/thumbnails");
    const jpgPath = path.join(thumbnailDir, `${draftId}.jpg`);
    const pngPath = path.join(thumbnailDir, `${draftId}.png`);

    let thumbPath: string | null = null;

    if (fs.existsSync(jpgPath)) {
      thumbPath = jpgPath;
    } else if (fs.existsSync(pngPath)) {
      thumbPath = pngPath;
    } else if (!skipAutoThumbnail && videoFilePath) {
      // Auto-generate a thumbnail using the frame selector + compositor pipeline
      thumbPath = await this.autoGenerateThumbnail(
        draftId,
        videoFilePath,
        videoTitle ?? "Untitled",
        thumbnailDir,
      );
    }

    if (!thumbPath) return;

    const tool = this.toolRegistry.getToolDefinition("youtube-set-thumbnail");
    if (!tool) {
      logger.debug(
        "[YouTubePublish] youtube-set-thumbnail tool not available, skipping thumbnail upload",
      );
      return;
    }

    try {
      await this.toolRegistry.invokeTool(
        "youtube-set-thumbnail",
        { video_id: videoId, image_path: thumbPath },
        { source: "director-studio" },
      );
      logger.info(`[YouTubePublish] Thumbnail set for ${videoId}`);
    } catch (error) {
      logger.warn(
        `[YouTubePublish] Failed to set thumbnail: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Auto-generate a thumbnail from the video file using the compositor pipeline.
   * Uses the first frame of the video as the background and overlays the title.
   * Returns the output path on success, null on failure.
   */
  async autoGenerateThumbnail(
    draftId: string,
    videoFilePath: string,
    title: string,
    thumbnailDir: string,
  ): Promise<string | null> {
    try {
      const { compositeThumbnail } =
        await import("./thumbnails/thumbnail-compositor.js");

      // Try to extract a frame using ffmpeg; fall back to using the video file directly
      const framePath = await this.extractFirstFrame(videoFilePath, draftId);
      if (!framePath) {
        logger.warn(
          "[YouTubePublish] Could not extract frame for auto-thumbnail",
        );
        return null;
      }

      const outputPath = path.join(thumbnailDir, `${draftId}.jpg`);

      // Compose the thumbnail with text overlay
      await compositeThumbnail({
        backgroundPath: framePath,
        textLines: [title.toUpperCase()],
        textPlacement: "bottom",
        textColor: "#ffffff",
        outputPath,
        outputFormat: "jpeg",
      });

      logger.info(
        `[YouTubePublish] Auto-generated thumbnail for draft ${draftId}`,
      );
      return outputPath;
    } catch (error) {
      logger.warn(
        `[YouTubePublish] Auto-thumbnail generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Extract the first frame from a video using ffmpeg.
   * Returns the path to the extracted frame, or null if extraction fails.
   */
  private async extractFirstFrame(
    videoPath: string,
    draftId: string,
  ): Promise<string | null> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const tmpDir = resolvePath("~/.openzigs/video-output/thumbnails");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const framePath = path.join(tmpDir, `${draftId}_frame.jpg`);

    try {
      await execFileAsync("ffmpeg", [
        "-i",
        videoPath,
        "-ss",
        "1",
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        framePath,
      ]);
      if (fs.existsSync(framePath)) return framePath;
      return null;
    } catch {
      return null;
    }
  }

  private emitProgress(
    draftId: string,
    publishId: string,
    stage: string,
    percent: number,
  ): void {
    this.io?.emit("youtube:publish:progress", {
      draftId,
      publishId,
      stage,
      percent,
    });
  }

  private emitComplete(
    draftId: string,
    publishId: string,
    videoId: string | null,
    videoUrl: string | null,
  ): void {
    this.io?.emit("youtube:publish:complete", {
      draftId,
      publishId,
      videoId,
      videoUrl,
    });
  }

  private emitError(draftId: string, publishId: string, error: string): void {
    this.io?.emit("youtube:publish:error", { draftId, publishId, error });
  }

  /** Parse raw YouTube error strings into user-friendly messages. */
  static parseYouTubeError(raw: string): string {
    // Already a clean message from the Python MCP layer
    if (raw.startsWith("Daily YouTube API quota")) return raw;
    if (raw.startsWith("YouTube API rate limit")) return raw;
    if (raw.startsWith("Access denied.")) return raw;
    if (raw.startsWith("Insufficient permissions.")) return raw;
    if (raw.startsWith("YouTube authorization expired.")) return raw;

    // Try to extract reason from embedded JSON
    const quotaMatch = raw.match(/"reason"\s*:\s*"quotaExceeded"/);
    if (quotaMatch)
      return "Daily YouTube API quota exceeded. Quota resets at midnight Pacific Time.";

    const authMatch = raw.match(/"reason"\s*:\s*"(unauthorized|authError)"/);
    if (authMatch)
      return "YouTube authorization expired. Please re-connect your YouTube account in Settings.";

    const forbiddenMatch = raw.match(
      /"reason"\s*:\s*"(forbidden|insufficientPermissions)"/,
    );
    if (forbiddenMatch)
      return "Access denied. Check that your YouTube OAuth token has upload permissions.";

    return raw;
  }
}
