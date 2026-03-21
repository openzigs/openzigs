/**
 * LinkedIn polling function for the GenericPollAdapter.
 * Fetches recent posts from the LinkedIn profile/org page and checks for new comments
 * via the LinkedIn MCP server.
 *
 * Strategy:
 *   1. Fetch recent posts via `linkedin_get_posts`.
 *   2. For each post, fetch comments via `linkedin_get_post_comments`.
 *   3. Filter to comments newer than `since` and map to `IncomingComment`.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

/** Shape of a LinkedIn post from the REST API */
interface LinkedInPost {
  id?: string;
  author?: string;
  commentary?: string;
  publishedAt?: string;
  createdAt?: number;
  lastModifiedAt?: number;
  lifecycleState?: string;
}

/** Shape of a LinkedIn comment from the Social Actions API */
interface LinkedInComment {
  $URN?: string;
  actor?: string;
  message?: { text?: string };
  created?: { time?: number };
  lastModified?: { time?: number };
  parentComment?: string;
  object?: string;
}

/** MCP response wrapper */
interface McpResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string | null;
}

/** LinkedIn posts response shape */
interface LinkedInPostsResponse {
  elements?: LinkedInPost[];
  paging?: { start?: number; count?: number; total?: number };
}

/** LinkedIn comments response shape */
interface LinkedInCommentsResponse {
  elements?: LinkedInComment[];
  paging?: { start?: number; count?: number; total?: number };
}

/**
 * Creates a poll function for LinkedIn that returns new comments since `since`.
 */
export function createLinkedInPollFn(
  serverManager: LocalMcpServerManager,
  maxPosts = 10,
  maxCommentsPerPost = 50,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const personId = process.env.LINKEDIN_PERSON_ID ?? "";

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    if (!serverManager.isRunning("linkedin")) {
      logger.warn("[LinkedInPoll] LinkedIn MCP server is not running");
      return results;
    }

    // --- Step 1: Fetch recent posts ---
    const postsResp = await serverManager.callTool("linkedin", "linkedin_get_posts", {
      count: maxPosts,
    });

    if (postsResp.isError) {
      logger.warn(`[LinkedInPoll] Failed to fetch posts: ${postsResp.text.slice(0, 200)}`);
      return results;
    }

    let posts: LinkedInPost[] = [];
    try {
      const parsed = JSON.parse(postsResp.text) as McpResponse<LinkedInPostsResponse>;
      if (parsed.success && parsed.data?.elements) {
        posts = parsed.data.elements;
      }
    } catch {
      logger.warn("[LinkedInPoll] Failed to parse posts response");
      return results;
    }

    if (posts.length === 0) {
      logger.debug("[LinkedInPoll] No posts found");
      return results;
    }

    logger.info(`[LinkedInPoll] Checking comments on ${posts.length} recent posts (since=${since})`);

    // --- Step 2: For each post, fetch comments ---
    for (const post of posts) {
      if (!post.id) continue;

      // Construct the post URN — LinkedIn REST API returns id like "urn:li:share:xxx"
      // or "urn:li:ugcPost:xxx" — use as-is if it's a URN, otherwise wrap it
      const postUrn = post.id.startsWith("urn:") ? post.id : `urn:li:share:${post.id}`;

      const commentsResp = await serverManager.callTool("linkedin", "linkedin_get_post_comments", {
        post_urn: postUrn,
        count: maxCommentsPerPost,
      });

      if (commentsResp.isError) {
        logger.debug(`[LinkedInPoll] Failed to fetch comments for post ${postUrn}: ${commentsResp.text.slice(0, 120)}`);
        continue;
      }

      let comments: LinkedInComment[] = [];
      try {
        const parsed = JSON.parse(commentsResp.text) as McpResponse<LinkedInCommentsResponse>;
        if (parsed.success && parsed.data?.elements) {
          comments = parsed.data.elements;
        }
      } catch {
        logger.debug(`[LinkedInPoll] Failed to parse comments response for post ${postUrn}`);
        continue;
      }

      // --- Step 3: Filter to comments newer than `since`, skip own comments ---
      for (const comment of comments) {
        const commentUrn = comment.$URN ?? "";
        const text = comment.message?.text ?? "";
        const createdTime = comment.created?.time;
        if (!commentUrn || !text || !createdTime) continue;

        const createdAt = new Date(createdTime);
        if (createdAt <= sinceDate) continue;

        // Skip comments by the authenticated user (avoid self-reply loops)
        const actorUrn = comment.actor ?? "";
        if (personId && actorUrn.includes(personId)) continue;

        results.push({
          platform: "linkedin",
          postId: postUrn,
          commentId: commentUrn,
          userId: actorUrn,
          username: actorUrn,
          text,
          timestamp: createdAt.toISOString(),
        } satisfies IncomingComment);
      }
    }

    logger.info(`[LinkedInPoll] Found ${results.length} new comments`);
    return results;
  };
}
