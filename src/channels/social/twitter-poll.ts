/**
 * Twitter/X polling function for the GenericPollAdapter.
 * Fetches recent mentions and replies via the Twitter MCP server and maps them to IncomingComment.
 *
 * Strategy:
 *   1. Fetch the authenticated user's ID via `twitter_get_me` (cached after first call).
 *   2. Search for recent replies to the user via `twitter_search_replies`.
 *   3. Filter to tweets newer than `since` and map to `IncomingComment`.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

/** Shape of a tweet from the Twitter API v2 */
interface TwitterTweet {
  id?: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  created_at?: string;
}

/** Shape of a user from expansions */
interface TwitterUser {
  id?: string;
  name?: string;
  username?: string;
}

/** MCP response wrapper: { success, data, error, timestamp } */
interface McpResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string | null;
}

/** Twitter v2 search/mentions response shape */
interface TwitterListResponse {
  data?: TwitterTweet[];
  includes?: { users?: TwitterUser[] };
  meta?: { result_count?: number; newest_id?: string; oldest_id?: string };
}

/**
 * Creates a poll function for Twitter that returns new mentions/replies since `since`.
 */
export function createTwitterPollFn(
  serverManager: LocalMcpServerManager,
  maxResults = 20,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  let cachedUsername: string | null = null;
  let cachedUserId: string | null = null;

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    if (!serverManager.isRunning("twitter")) {
      logger.warn("[TwitterPoll] Twitter MCP server is not running");
      return results;
    }

    // --- Step 1: Resolve the authenticated user's username (cached) ---
    if (!cachedUsername || !cachedUserId) {
      const meResp = await serverManager.callTool("twitter", "twitter_get_me", {});
      if (meResp.isError) {
        logger.warn(`[TwitterPoll] Failed to fetch authenticated user: ${meResp.text.slice(0, 200)}`);
        return results;
      }
      try {
        const parsed = JSON.parse(meResp.text) as McpResponse<{ data?: TwitterUser }>;
        if (parsed.success && parsed.data?.data) {
          cachedUsername = parsed.data.data.username ?? null;
          cachedUserId = parsed.data.data.id ?? null;
        }
      } catch {
        logger.warn("[TwitterPoll] Failed to parse get_me response");
        return results;
      }

      if (!cachedUsername || !cachedUserId) {
        logger.warn("[TwitterPoll] Could not determine authenticated user");
        return results;
      }
    }

    // --- Step 2: Fetch from BOTH mentions timeline AND search, then merge ---
    // Mentions timeline: catches explicit @mentions in tweet text
    // Search (to:user is:reply): catches replies to user's tweets (even without explicit @mention)
    const allTweets: TwitterTweet[] = [];
    const allUsers: TwitterUser[] = [];
    const seenTweetIds = new Set<string>();

    // 2a. Try mentions timeline (OAuth 1.0a)
    const mentionsResp = await serverManager.callTool("twitter", "twitter_get_mentions", {
      user_id: cachedUserId,
      max_results: maxResults,
    });

    if (mentionsResp.isError) {
      logger.info(`[TwitterPoll] Mentions timeline unavailable: ${mentionsResp.text.slice(0, 120)}`);
    } else {
      try {
        const parsed = JSON.parse(mentionsResp.text) as McpResponse<TwitterListResponse>;
        if (parsed.success && parsed.data) {
          for (const t of parsed.data.data ?? []) {
            if (t.id && !seenTweetIds.has(t.id)) {
              seenTweetIds.add(t.id);
              allTweets.push(t);
            }
          }
          for (const u of parsed.data.includes?.users ?? []) allUsers.push(u);
          logger.info(`[TwitterPoll] Mentions returned ${parsed.data.data?.length ?? 0} tweets (result_count=${parsed.data.meta?.result_count ?? "n/a"})`);
        }
      } catch {
        logger.warn("[TwitterPoll] Failed to parse mentions response");
      }
    }

    // 2b. Also search for replies to the user's tweets
    const searchResp = await serverManager.callTool("twitter", "twitter_search_replies", {
      username: cachedUsername,
      max_results: maxResults,
    });

    if (searchResp.isError) {
      logger.info(`[TwitterPoll] Search replies unavailable: ${searchResp.text.slice(0, 120)}`);
    } else {
      try {
        const parsed = JSON.parse(searchResp.text) as McpResponse<TwitterListResponse>;
        if (parsed.success && parsed.data) {
          for (const t of parsed.data.data ?? []) {
            if (t.id && !seenTweetIds.has(t.id)) {
              seenTweetIds.add(t.id);
              allTweets.push(t);
            }
          }
          for (const u of parsed.data.includes?.users ?? []) allUsers.push(u);
          logger.info(`[TwitterPoll] Search returned ${parsed.data.data?.length ?? 0} tweets (result_count=${parsed.data.meta?.result_count ?? "n/a"})`);
        }
      } catch {
        logger.warn("[TwitterPoll] Failed to parse search response");
      }
    }

    if (allTweets.length === 0 && mentionsResp.isError && searchResp.isError) {
      logger.warn("[TwitterPoll] Both mentions and search failed — no data sources available");
      return results;
    }

    if (allTweets.length === 0) {
      logger.warn(
        "[TwitterPoll] Both mentions and search returned 200 OK but zero tweets. " +
        "This is likely due to Twitter API search indexing delay (new tweets can take up to 15 min to appear) " +
        "or the replying account may be too new/low-activity to be indexed.",
      );
    }

    const tweets = allTweets;
    const users = allUsers;

    // Build user lookup map from expansions
    const userMap = new Map<string, TwitterUser>();
    for (const user of users) {
      if (user.id) userMap.set(user.id, user);
    }

    // --- Step 3: Map tweets to IncomingComment (replies) or IncomingSocialMessage (DMs are separate) ---
    logger.info(`[TwitterPoll] Processing ${tweets.length} tweets (since=${since}, sinceDate=${sinceDate.toISOString()})`);
    for (const tweet of tweets) {
      if (!tweet.created_at || !tweet.id) {
        logger.debug(`[TwitterPoll] Skipping tweet: missing created_at or id`);
        continue;
      }

      const createdAt = new Date(tweet.created_at);
      if (createdAt <= sinceDate) {
        logger.debug(`[TwitterPoll] Skipping tweet ${tweet.id}: too old (${tweet.created_at} <= ${since})`);
        continue;
      }

      // Skip tweets authored by ourself
      if (tweet.author_id === cachedUserId) {
        logger.debug(`[TwitterPoll] Skipping tweet ${tweet.id}: authored by self`);
        continue;
      }

      const author = userMap.get(tweet.author_id ?? "");
      const username = author?.username ?? tweet.author_id ?? "";

      // If the tweet has a conversation_id (reply chain), treat as a comment
      if (tweet.conversation_id && tweet.conversation_id !== tweet.id) {
        results.push({
          platform: "twitter",
          postId: tweet.conversation_id,
          commentId: tweet.id,
          userId: tweet.author_id ?? "",
          username,
          text: tweet.text ?? "",
          timestamp: createdAt.toISOString(),
        } satisfies IncomingComment);
      } else {
        // Standalone mention — treat as a message
        results.push({
          platform: "twitter",
          platformMessageId: tweet.id,
          platformUserId: tweet.author_id ?? "",
          username,
          text: tweet.text ?? "",
          timestamp: createdAt.toISOString(),
        } satisfies IncomingSocialMessage);
      }
    }

    return results;
  };
}
