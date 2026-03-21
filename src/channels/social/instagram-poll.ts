/**
 * Instagram polling function for the GenericPollAdapter.
 * Fetches recent posts from the Instagram Business Account and checks for new comments via the Instagram MCP server.
 *
 * Strategy:
 *   1. Fetch recent media posts via `get_media_posts`.
 *   2. For each post, fetch comments via `get_media_comments`.
 *   3. Filter to comments newer than `since` and map to `IncomingComment`.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

/** Shape of an Instagram media post from the Graph API */
interface InstagramMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/** Shape of an Instagram comment from the Graph API */
interface InstagramComment {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  from?: { id?: string; username?: string };
}

/** MCP response wrapper */
interface McpResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string | null;
}

/** Instagram posts response shape */
interface InstagramPostsResponse {
  posts?: InstagramMedia[];
  count?: number;
}

/** Instagram comments response shape */
interface InstagramCommentsResponse {
  comments?: InstagramComment[];
  count?: number;
}

/**
 * Creates a poll function for Instagram that returns new comments since `since`.
 */
export function createInstagramPollFn(
  serverManager: LocalMcpServerManager,
  maxPosts = 10,
  maxCommentsPerPost = 50,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "";

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    if (!serverManager.isRunning("instagram")) {
      logger.warn("[InstagramPoll] Instagram MCP server is not running");
      return results;
    }

    // --- Step 1: Fetch recent media posts ---
    const postsResp = await serverManager.callTool("instagram", "get_media_posts", {
      limit: maxPosts,
    });

    if (postsResp.isError) {
      logger.warn(`[InstagramPoll] Failed to fetch media posts: ${postsResp.text.slice(0, 200)}`);
      return results;
    }

    let posts: InstagramMedia[] = [];
    try {
      const parsed = JSON.parse(postsResp.text) as McpResponse<InstagramPostsResponse>;
      if (parsed.success && parsed.data?.posts) {
        posts = parsed.data.posts;
      }
    } catch {
      logger.warn("[InstagramPoll] Failed to parse media posts response");
      return results;
    }

    if (posts.length === 0) {
      logger.debug("[InstagramPoll] No posts found on account");
      return results;
    }

    logger.info(`[InstagramPoll] Checking comments on ${posts.length} recent posts (since=${since})`);

    // --- Step 2: For each post, fetch comments ---
    for (const post of posts) {
      if (!post.id) continue;

      // Note: comments_count can be stale/cached by Instagram, so we always
      // check for comments on every post rather than relying on the count.
      // This ensures newly posted comments are not missed.

      const commentsResp = await serverManager.callTool("instagram", "get_media_comments", {
        media_id: post.id,
        limit: maxCommentsPerPost,
      });

      if (commentsResp.isError) {
        logger.debug(`[InstagramPoll] Failed to fetch comments for post ${post.id}: ${commentsResp.text.slice(0, 120)}`);
        continue;
      }

      let comments: InstagramComment[] = [];
      try {
        const parsed = JSON.parse(commentsResp.text) as McpResponse<InstagramCommentsResponse>;
        if (parsed.success && parsed.data?.comments) {
          comments = parsed.data.comments;
        }
      } catch {
        logger.debug(`[InstagramPoll] Failed to parse comments response for post ${post.id}`);
        continue;
      }

      // --- Step 3: Filter to comments newer than `since`, skip own account comments ---
      for (const comment of comments) {
        if (!comment.id || !comment.timestamp || !comment.text) continue;

        const createdAt = new Date(comment.timestamp);
        if (createdAt <= sinceDate) continue;

        // Skip comments authored by the business account itself
        // Instagram comments have `from.id` for IGSID or `username` field
        const commentUserId = comment.from?.id ?? "";
        const commentUsername = comment.username ?? comment.from?.username ?? "";

        // If the comment is from our own account (by ID or username match), skip it
        if (businessAccountId && commentUserId === businessAccountId) continue;

        results.push({
          platform: "instagram",
          postId: post.id,
          commentId: comment.id,
          userId: commentUserId,
          username: commentUsername,
          text: comment.text,
          timestamp: createdAt.toISOString(),
        } satisfies IncomingComment);
      }
    }

    logger.info(`[InstagramPoll] Found ${results.length} new comments`);
    return results;
  };
}
