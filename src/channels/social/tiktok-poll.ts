/**
 * TikTok polling function for the GenericPollAdapter.
 *
 * TikTok's public Display API (`/v2/video/comment/list/`) requires the
 * `comment.list` scope, which is only granted via TikTok's Research API
 * (academic-only as of 2026). For all other apps, individual video comments
 * are NOT retrievable.
 *
 * This poller therefore surfaces *video-level engagement* (new uploads,
 * comment_count deltas, like_count deltas) as activity events. Per-video
 * in-memory state ensures idempotent emission across cycles. When TikTok
 * later exposes a public comment-list endpoint, extend this poller.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

interface TikTokVideo {
  id?: string;
  title?: string;
  video_description?: string;
  create_time?: number; // seconds since epoch
  comment_count?: number;
  like_count?: number;
  view_count?: number;
  share_url?: string;
}

interface McpResponseShape {
  data?: { videos?: TikTokVideo[] };
  error?: { code?: string; message?: string } | null;
}

export function createTikTokPollFn(
  serverManager: LocalMcpServerManager,
  maxVideos = 10,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const lastCommentCount = new Map<string, number>();
  const lastLikeCount = new Map<string, number>();

  return async (since: string) => {
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    if (!serverManager.isRunning("tiktok")) {
      logger.warn("[TikTokPoll] TikTok MCP server is not running");
      return results;
    }

    const sinceDate = new Date(since);

    const resp = await serverManager.callTool("tiktok", "tiktok_list_videos", {
      max_count: maxVideos,
    });

    if (resp.isError) {
      logger.warn(
        `[TikTokPoll] tiktok_list_videos failed: ${resp.text.slice(0, 200)}`,
      );
      return results;
    }

    // The sidecar formats responses as text — try JSON first (in case of future
    // structured responses) and fall back to a regex parser for the current
    // human-readable format produced by handleListVideos.
    const videos = parseVideosResponse(resp.text);
    logger.info(
      `[TikTokPoll] scanned ${videos.length} videos (since=${since})`,
    );

    for (const v of videos) {
      if (!v.id) continue;

      const createdAt =
        typeof v.create_time === "number"
          ? new Date(v.create_time * 1000)
          : null;
      const isNew = createdAt !== null && createdAt > sinceDate;
      const commentCount = v.comment_count ?? 0;
      const likeCount = v.like_count ?? 0;
      const prevCommentCount = lastCommentCount.get(v.id);
      const prevLikeCount = lastLikeCount.get(v.id);
      const commentDelta =
        prevCommentCount === undefined ? 0 : commentCount - prevCommentCount;
      const likeDelta =
        prevLikeCount === undefined ? 0 : likeCount - prevLikeCount;
      lastCommentCount.set(v.id, commentCount);
      lastLikeCount.set(v.id, likeCount);

      if (!isNew && commentDelta <= 0 && likeDelta <= 0) continue;

      let text: string;
      let commentId: string;
      if (isNew) {
        text = `New TikTok video published: ${v.title ?? v.video_description ?? "(untitled)"}`;
        commentId = `tt_video_created_${v.id}`;
      } else if (commentDelta > 0) {
        text = `+${commentDelta} new comment${commentDelta === 1 ? "" : "s"} on TikTok video`;
        commentId = `tt_comments_${v.id}_${new Date().toISOString().slice(0, 10)}`;
      } else {
        text = `+${likeDelta} new like${likeDelta === 1 ? "" : "s"} on TikTok video`;
        commentId = `tt_likes_${v.id}_${new Date().toISOString().slice(0, 10)}`;
      }

      results.push({
        platform: "tiktok",
        postId: v.id,
        commentId,
        userId: "tiktok_engagement",
        username: "tiktok",
        text,
        timestamp: (createdAt ?? new Date()).toISOString(),
      } satisfies IncomingComment);
    }

    logger.info(`[TikTokPoll] emitted ${results.length} activity events`);
    return results;
  };
}

/**
 * Parse the TikTok sidecar's `tiktok_list_videos` response.
 *
 * The sidecar currently returns a human-readable summary. We do best-effort
 * extraction; if a future sidecar emits JSON we transparently consume it.
 */
function parseVideosResponse(text: string): TikTokVideo[] {
  // Try JSON first.
  try {
    const parsed = JSON.parse(text) as McpResponseShape | TikTokVideo[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed.data?.videos) return parsed.data.videos;
  } catch {
    // fall through to text parsing
  }

  const videos: TikTokVideo[] = [];
  // Sidecar emits blocks like:
  //   ID: 7xxx
  //   Title: ...
  //   Description: ...
  //   Created: 2026-...
  //   Comments: 5
  //   Likes: 12
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const idMatch = block.match(/ID:\s*(\S+)/i);
    if (!idMatch) continue;
    const titleMatch = block.match(/Title:\s*(.+)/i);
    const descMatch = block.match(/Description:\s*(.+)/i);
    const createdMatch = block.match(
      /Created(?:_time)?:\s*(\d+|[\d-]+T[\d:]+Z?)/i,
    );
    const commentMatch = block.match(/Comments?:\s*(\d+)/i);
    const likeMatch = block.match(/Likes?:\s*(\d+)/i);
    const created = createdMatch
      ? /^\d+$/.test(createdMatch[1])
        ? Number(createdMatch[1])
        : Math.floor(new Date(createdMatch[1]).getTime() / 1000)
      : undefined;
    videos.push({
      id: idMatch[1],
      title: titleMatch?.[1].trim(),
      video_description: descMatch?.[1].trim(),
      create_time: created,
      comment_count: commentMatch ? Number(commentMatch[1]) : undefined,
      like_count: likeMatch ? Number(likeMatch[1]) : undefined,
    });
  }
  return videos;
}
