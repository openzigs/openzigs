/**
 * Reddit polling function for the GenericPollAdapter.
 * Fetches inbox messages and maps them to IncomingSocialMessage / IncomingComment.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingSocialMessage, IncomingComment } from "./types.js";

/** Shape of a Reddit inbox item from the API */
interface RedditInboxItem {
  name?: string;      // fullname, e.g. "t4_abc123" (message) or "t1_xyz" (comment reply)
  author?: string;
  dest?: string;
  subject?: string;
  body?: string;
  created_utc?: number;
  was_comment?: boolean;
  link_id?: string;    // parent post fullname for comment replies (t3_xxx)
  context?: string;    // permalink context
}

/**
 * Creates a poll function for Reddit that returns new messages/comments since `since`.
 */
export function createRedditPollFn(
  serverManager: LocalMcpServerManager,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    const response = await serverManager.callTool("reddit", "reddit_get_inbox", { limit: 50 });

    if (response.isError) {
      logger.warn(`[RedditPoll] Failed to fetch inbox: ${response.text.slice(0, 200)}`);
      return results;
    }

    let items: RedditInboxItem[] = [];
    try {
      const parsed = JSON.parse(response.text) as {
        success?: boolean;
        data?: {
          data?: { children?: Array<{ data?: RedditInboxItem }> };
          children?: Array<{ data?: RedditInboxItem }>;
        };
      };

      // Handle Reddit listing response format
      const listing = parsed.data;
      const children = listing?.data?.children ?? listing?.children ?? [];
      items = children
        .map((c) => c.data)
        .filter((d): d is RedditInboxItem => d != null);
    } catch (error) {
      logger.warn(`[RedditPoll] Failed to parse inbox response: ${error instanceof Error ? error.message : String(error)}`);
      return results;
    }

    for (const item of items) {
      const createdAt = item.created_utc
        ? new Date(item.created_utc * 1000)
        : new Date(0);

      // Skip items older than `since`
      if (createdAt <= sinceDate) continue;

      const timestamp = createdAt.toISOString();

      if (item.was_comment && item.link_id) {
        // Comment reply — treat as IncomingComment
        const postId = item.link_id.startsWith("t3_")
          ? item.link_id.slice(3)
          : item.link_id;
        results.push({
          platform: "reddit",
          postId,
          commentId: item.name ?? "",
          userId: item.author ?? "",
          username: item.author ?? "",
          text: item.body ?? "",
          timestamp,
        } satisfies IncomingComment);
      } else {
        // Private message — treat as IncomingSocialMessage
        results.push({
          platform: "reddit",
          platformMessageId: item.name ?? "",
          platformUserId: item.author ?? "",
          username: item.author ?? "",
          text: item.body ?? "",
          timestamp,
        } satisfies IncomingSocialMessage);
      }
    }

    return results;
  };
}
