/**
 * Facebook polling function for the GenericPollAdapter.
 * Fetches recent posts from the Facebook Page and checks for new comments via the Facebook MCP server.
 *
 * Strategy:
 *   1. Fetch recent page posts via `fb_get_page_posts`.
 *   2. For each post, fetch comments via `fb_get_post_comments`.
 *   3. Filter to comments newer than `since` and map to `IncomingComment`.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

/** Shape of a Facebook post from the Graph API */
interface FacebookPost {
  id?: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
}

/** Shape of a Facebook comment from the Graph API */
interface FacebookComment {
  id?: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
}

/** MCP response wrapper */
interface McpResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string | null;
}

/** Facebook posts response shape */
interface FacebookPostsResponse {
  data?: FacebookPost[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Facebook comments response shape */
interface FacebookCommentsResponse {
  data?: FacebookComment[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Creates a poll function for Facebook that returns new comments since `since`.
 */
export function createFacebookPollFn(
  serverManager: LocalMcpServerManager,
  maxPosts = 10,
  maxCommentsPerPost = 50,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    if (!serverManager.isRunning("facebook")) {
      logger.warn("[FacebookPoll] Facebook MCP server is not running");
      return results;
    }

    // --- Step 1: Fetch recent page posts ---
    const postsResp = await serverManager.callTool("facebook", "fb_get_page_posts", {
      limit: maxPosts,
    });

    if (postsResp.isError) {
      logger.warn(`[FacebookPoll] Failed to fetch page posts: ${postsResp.text.slice(0, 200)}`);
      return results;
    }

    let posts: FacebookPost[] = [];
    try {
      const parsed = JSON.parse(postsResp.text) as McpResponse<FacebookPostsResponse>;
      if (parsed.success && parsed.data?.data) {
        posts = parsed.data.data;
      }
    } catch {
      logger.warn("[FacebookPoll] Failed to parse page posts response");
      return results;
    }

    if (posts.length === 0) {
      logger.debug("[FacebookPoll] No posts found on page");
      return results;
    }

    logger.info(`[FacebookPoll] Checking comments on ${posts.length} recent posts (since=${since})`);

    // --- Step 2: For each post, fetch comments ---
    for (const post of posts) {
      if (!post.id) continue;

      const commentsResp = await serverManager.callTool("facebook", "fb_get_post_comments", {
        post_id: post.id,
        limit: maxCommentsPerPost,
      });

      if (commentsResp.isError) {
        logger.debug(`[FacebookPoll] Failed to fetch comments for post ${post.id}: ${commentsResp.text.slice(0, 120)}`);
        continue;
      }

      let comments: FacebookComment[] = [];
      try {
        const parsed = JSON.parse(commentsResp.text) as McpResponse<FacebookCommentsResponse>;
        if (parsed.success && parsed.data?.data) {
          comments = parsed.data.data;
        }
      } catch {
        logger.debug(`[FacebookPoll] Failed to parse comments response for post ${post.id}`);
        continue;
      }

      // --- Step 3: Filter to comments newer than `since`, skip own page comments ---
      for (const comment of comments) {
        if (!comment.id || !comment.created_time || !comment.message) continue;

        const createdAt = new Date(comment.created_time);
        if (createdAt <= sinceDate) continue;

        // Skip comments authored by the page itself
        if (pageId && comment.from?.id === pageId) continue;

        // Note: Facebook Graph API v3.3+ may not return from.id for regular user
        // comments (privacy restriction).  We still ingest the comment so the
        // rule engine can reply to it via comment_id — DMs will be skipped
        // downstream when userId is empty.
        if (!comment.from?.id) {
          logger.debug(`[FacebookPoll] Comment ${comment.id} has no from.id (privacy restriction) — ingesting anyway for comment replies`);
        }

        results.push({
          platform: "facebook",
          postId: post.id,
          commentId: comment.id,
          userId: comment.from?.id ?? "",
          username: comment.from?.name ?? comment.from?.id ?? "",
          text: comment.message,
          timestamp: createdAt.toISOString(),
        } satisfies IncomingComment);
      }
    }

    logger.info(`[FacebookPoll] Found ${results.length} new comments`);
    return results;
  };
}
