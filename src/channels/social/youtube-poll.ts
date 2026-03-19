/**
 * YouTube polling function for the GenericPollAdapter.
 * Fetches recent video comments via the YouTube MCP server and maps them to IncomingComment.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment } from "./types.js";

/** Shape of a YouTube comment thread item from the Data API v3 */
interface YouTubeCommentSnippet {
  textDisplay?: string;
  authorDisplayName?: string;
  authorChannelId?: { value?: string };
  publishedAt?: string;
}

interface YouTubeCommentThread {
  id?: string;
  snippet?: {
    videoId?: string;
    topLevelComment?: {
      id?: string;
      snippet?: YouTubeCommentSnippet;
    };
  };
}

/** Shape of a YouTube search/video item */
interface YouTubeVideoItem {
  id?: string | { videoId?: string };
  snippet?: { title?: string };
}

/** MCP response wrapper: { success, data, error, timestamp } */
interface McpResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string | null;
}

/**
 * Creates a poll function for YouTube that returns new comments since `since`.
 *
 * Strategy:
 *   1. Fetch the most recent videos from the channel via `yt_get_channel_videos`.
 *   2. For each video, fetch recent comments via `yt_get_video_comments`.
 *   3. Filter to comments newer than `since` and map to `IncomingComment`.
 */
export function createYouTubePollFn(
  serverManager: LocalMcpServerManager,
  maxVideos = 5,
  commentsPerVideo = 20,
): (since: string) => Promise<IncomingComment[]> {
  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: IncomingComment[] = [];

    if (!serverManager.isRunning("youtube")) {
      logger.warn("[YouTubePoll] YouTube MCP server is not running");
      return results;
    }

    // --- Step 1: Discover recent videos ---
    const videosResp = await serverManager.callTool("youtube", "yt_get_channel_videos", {
      max_results: maxVideos,
    });

    if (videosResp.isError) {
      logger.warn(`[YouTubePoll] Failed to fetch channel videos: ${videosResp.text.slice(0, 200)}`);
      return results;
    }

    let videoIds: string[];
    try {
      const parsed = JSON.parse(videosResp.text) as McpResponse<{ items?: YouTubeVideoItem[] }>;
      if (!parsed.success || !parsed.data) {
        logger.warn(`[YouTubePoll] Channel videos response unsuccessful: ${parsed.error ?? "unknown"}`);
        return results;
      }
      videoIds = (parsed.data.items ?? [])
        .map((item) => {
          if (typeof item.id === "string") return item.id;
          if (typeof item.id === "object" && item.id?.videoId) return item.id.videoId;
          return null;
        })
        .filter((id): id is string => id != null)
        .slice(0, maxVideos);
    } catch {
      logger.warn("[YouTubePoll] Failed to parse channel videos response");
      return results;
    }

    if (videoIds.length === 0) {
      return results;
    }

    // --- Step 2: Fetch comments for each video ---
    for (const videoId of videoIds) {
      const commentsResp = await serverManager.callTool("youtube", "yt_get_video_comments", {
        video_id: videoId,
        max_results: commentsPerVideo,
      });

      if (commentsResp.isError) {
        logger.warn(`[YouTubePoll] Failed to fetch comments for ${videoId}: ${commentsResp.text.slice(0, 200)}`);
        continue;
      }

      let threads: YouTubeCommentThread[];
      try {
        const parsed = JSON.parse(commentsResp.text) as McpResponse<{ items?: YouTubeCommentThread[] }>;
        if (!parsed.success || !parsed.data) continue;
        threads = parsed.data.items ?? [];
      } catch {
        logger.warn(`[YouTubePoll] Failed to parse comments for ${videoId}`);
        continue;
      }

      for (const thread of threads) {
        const comment = thread.snippet?.topLevelComment;
        const snippet = comment?.snippet;
        if (!snippet?.publishedAt) continue;

        const publishedAt = new Date(snippet.publishedAt);
        if (publishedAt <= sinceDate) continue;

        results.push({
          platform: "youtube",
          postId: videoId,
          commentId: comment?.id ?? thread.id ?? "",
          userId: snippet.authorChannelId?.value ?? "",
          username: snippet.authorDisplayName ?? "",
          text: snippet.textDisplay ?? "",
          timestamp: publishedAt.toISOString(),
        } satisfies IncomingComment);
      }
    }

    return results;
  };
}
