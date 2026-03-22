/**
 * YouTube Publish Service — orchestrates video uploads to YouTube via MCP tool registry.
 * Issue #513: Calls yt_upload_video MCP tool, tracks progress via Socket.IO, manages publish lifecycle.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { YouTubePublishRepository } from "./youtube-publish-repository.js";
import type { Server as SocketIOServer } from "socket.io";

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
}

export class YouTubePublishService {
  private readonly toolRegistry: ToolRegistry;
  private readonly publishRepo: YouTubePublishRepository;
  private io: SocketIOServer | null;

  constructor({ toolRegistry, publishRepo, io }: YouTubePublishServiceOptions) {
    this.toolRegistry = toolRegistry;
    this.publishRepo = publishRepo;
    this.io = io ?? null;
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
    const filePath = request.filePath ? resolvePath(request.filePath) : this.resolveRenderOutputPath(request.draftId);

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
        return { publishId, videoId: null, videoUrl: null, status: "failed", error: errorMsg };
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
      return { publishId, videoId: null, videoUrl: null, status: "failed", error: errorMsg };
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
      // Get the yt_upload_video tool from the registry
      const tool = this.toolRegistry.getToolDefinition("yt_upload_video");
      if (!tool) {
        throw new Error("YouTube upload tool (yt_upload_video) is not available. Ensure the YouTube MCP server is running.");
      }

      // Call the MCP tool
      const result = await tool.handler({
        file_path: filePath,
        title: request.title,
        description: request.description ?? "",
        tags: request.tags ?? [],
        category_id: request.categoryId ?? "22",
        privacy_status: request.privacyStatus ?? "private",
        notify_subscribers: request.notifySubscribers ?? true,
      });

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
      const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : (response.data?.url ?? null);
      const finalStatus = request.scheduledPublishTime ? "scheduled" : "published";

      // Update publish record
      this.publishRepo.updateStatus(publishId, finalStatus, {
        video_id: videoId,
        video_url: videoUrl,
        published_at: now,
      });

      this.emitComplete(request.draftId, publishId, videoId, videoUrl);

      // Try to set thumbnail if one exists
      await this.trySetThumbnail(request.draftId, videoId);

      logger.info(`[YouTubePublish] Published ${publishId} → ${videoId ?? "unknown"}`);
      return { publishId, videoId, videoUrl, status: finalStatus };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.publishRepo.updateStatus(publishId, "failed", {
        error_message: errorMsg,
      });
      this.emitError(request.draftId, publishId, errorMsg);
      logger.error(`[YouTubePublish] Failed ${publishId}: ${errorMsg}`);
      return { publishId, videoId: null, videoUrl: null, status: "failed", error: errorMsg };
    }
  }

  /** Get publish status for a draft. */
  getPublishStatus(draftId: string): { status: string; publishId?: string; videoId?: string; videoUrl?: string; error?: string } | null {
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

  // ── Private helpers ────────────────────────────────────────

  private resolveRenderOutputPath(draftId: string): string | null {
    // Check the renders directory for any completed render for this draft
    const rendersDir = resolvePath("~/.openzigs/renders");
    if (!fs.existsSync(rendersDir)) return null;

    // Look for output.mp4 files in render subdirectories
    try {
      const entries = fs.readdirSync(rendersDir, { withFileTypes: true });
      for (const entry of entries.reverse()) {
        if (!entry.isDirectory()) continue;
        const outputPath = path.join(rendersDir, entry.name, "output.mp4");
        if (fs.existsSync(outputPath)) {
          return outputPath;
        }
      }
    } catch {
      // If we can't read the renders dir, fall back to video-output
    }

    // Legacy path
    const legacyPath = resolvePath(`~/.openzigs/video-output/${draftId}/output.mp4`);
    if (fs.existsSync(legacyPath)) return legacyPath;

    return null;
  }

  private async trySetThumbnail(draftId: string, videoId: string | null): Promise<void> {
    if (!videoId) return;

    const thumbnailPath = resolvePath(`~/.openzigs/video-output/thumbnails/${draftId}.jpg`);
    if (!fs.existsSync(thumbnailPath)) {
      // Also check .png
      const pngPath = resolvePath(`~/.openzigs/video-output/thumbnails/${draftId}.png`);
      if (!fs.existsSync(pngPath)) return;
    }

    const tool = this.toolRegistry.getToolDefinition("yt_set_thumbnail");
    if (!tool) {
      logger.debug("[YouTubePublish] yt_set_thumbnail tool not available, skipping thumbnail upload");
      return;
    }

    try {
      const thumbPath = fs.existsSync(thumbnailPath)
        ? thumbnailPath
        : resolvePath(`~/.openzigs/video-output/thumbnails/${draftId}.png`);
      await tool.handler({ video_id: videoId, thumbnail_path: thumbPath });
      logger.info(`[YouTubePublish] Thumbnail set for ${videoId}`);
    } catch (error) {
      logger.warn(`[YouTubePublish] Failed to set thumbnail: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitProgress(draftId: string, publishId: string, stage: string, percent: number): void {
    this.io?.emit("youtube:publish:progress", { draftId, publishId, stage, percent });
  }

  private emitComplete(draftId: string, publishId: string, videoId: string | null, videoUrl: string | null): void {
    this.io?.emit("youtube:publish:complete", { draftId, publishId, videoId, videoUrl });
  }

  private emitError(draftId: string, publishId: string, error: string): void {
    this.io?.emit("youtube:publish:error", { draftId, publishId, error });
  }
}
