/**
 * Reddit browser-based polling adapter.
 * Scrapes inbox messages and comment replies from old.reddit.com via Chrome
 * DevTools Protocol, eliminating the need for Reddit API credentials.
 *
 * ⚠️  WARNING: Browser-based scraping may violate Reddit's Terms of Service.
 *     This feature is provided as a beta convenience for users who cannot
 *     obtain API credentials.  Use at your own risk.
 */

import { logger } from "../../logging/logger.js";
import { createBrowserNavigateHandler } from "../../mcp/tools/browser-navigate.js";
import type { IncomingSocialMessage, IncomingComment } from "./types.js";

interface BrowserPollOptions {
  /** Chrome DevTools host (e.g. "localhost") */
  host: string;
  /** Chrome DevTools port (e.g. 9222) */
  port: number;
}

interface ExtractedInboxItem {
  id: string;
  author: string;
  subject: string;
  body: string;
  timestamp: string;
  isComment: boolean;
  postId: string;
  context: string;
}

/**
 * Creates a browser-based poll function for Reddit that returns new
 * messages/comments since `since`.
 *
 * Strategy:
 *   1. Navigate to old.reddit.com/message/inbox (stable DOM structure).
 *   2. Extract inbox items from the DOM.
 *   3. Separate comment replies from DMs.
 *   4. Filter to items newer than `since` and map to IncomingComment / IncomingSocialMessage.
 *
 * Uses old.reddit.com because its DOM is simple, static HTML — much easier
 * to parse reliably than the React-based new Reddit UI.
 */
export function createRedditBrowserPollFn(
  options: BrowserPollOptions,
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const { host, port } = options;
  const browserHandler = createBrowserNavigateHandler({ host, port });

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: (IncomingSocialMessage | IncomingComment)[] = [];

    try {
      // --- Step 1: Navigate to inbox ---
      const navResult = await browserHandler({
        action: "navigate",
        url: "https://old.reddit.com/message/inbox/",
      });
      if (!navResult.success) {
        logger.warn("[RedditBrowserPoll] Failed to navigate to inbox");
        return results;
      }

      // Wait for page to load
      await sleep(2500);

      // Check if we're logged in (old reddit shows "login" link if not)
      const loginCheck = await browserHandler({
        action: "evaluate",
        expression: `(() => {
          const userArea = document.querySelector('.user');
          if (!userArea) return 'unknown';
          return userArea.textContent.includes('login') || userArea.textContent.includes('sign up')
            ? 'logged_out' : 'logged_in';
        })()`,
      });

      if (loginCheck.text === "logged_out") {
        logger.warn("[RedditBrowserPoll] Not logged in to Reddit — browser mode requires an active session");
        return results;
      }

      // --- Step 2: Extract inbox items ---
      const inboxResult = await browserHandler({
        action: "evaluate",
        expression: `(() => {
          const items = [];
          const messages = document.querySelectorAll('.message');
          for (const msg of messages) {
            const authorEl = msg.querySelector('.author');
            const bodyEl = msg.querySelector('.md');
            const timeEl = msg.querySelector('time');
            const subjectEl = msg.querySelector('.subject a, .subject');
            const taglineEl = msg.querySelector('.tagline');

            const author = authorEl ? authorEl.textContent.trim() : '';
            const body = bodyEl ? bodyEl.textContent.trim() : '';
            const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || '') : '';
            const subject = subjectEl ? subjectEl.textContent.trim() : '';

            // Determine if this is a comment reply or a direct message
            // Comment replies have a "context" link and usually "comment reply" in the tagline
            const contextLink = msg.querySelector('a[href*="/comments/"]');
            const taglineText = taglineEl ? taglineEl.textContent.toLowerCase() : '';
            const isComment = taglineText.includes('comment reply') ||
                              taglineText.includes('post reply') ||
                              !!contextLink;

            // Extract post ID from context link
            let postId = '';
            let context = '';
            if (contextLink) {
              context = contextLink.getAttribute('href') || '';
              const postMatch = context.match(/\\/comments\\/([a-z0-9]+)/);
              if (postMatch) postId = postMatch[1];
            }

            // Build a stable-ish ID from available data
            const id = msg.getAttribute('data-fullname') ||
                       ('rb-' + author + '-' + timestamp.slice(0, 16));

            if (body) {
              items.push({
                id: id,
                author: author,
                subject: subject,
                body: body,
                timestamp: timestamp,
                isComment: isComment,
                postId: postId,
                context: context,
              });
            }
          }
          return JSON.stringify(items);
        })()`,
      });

      let extractedItems: ExtractedInboxItem[] = [];
      try {
        extractedItems = JSON.parse(inboxResult.text ?? "[]");
      } catch {
        logger.warn("[RedditBrowserPoll] Failed to parse inbox items");
        return results;
      }

      // --- Step 3: Filter and map ---
      for (const item of extractedItems) {
        // Parse timestamp — old reddit <time> datetime is ISO format
        let itemDate: Date;
        if (item.timestamp) {
          itemDate = new Date(item.timestamp);
          if (isNaN(itemDate.getTime())) {
            itemDate = new Date();
          }
        } else {
          itemDate = new Date();
        }

        // Skip items older than `since`
        if (itemDate <= sinceDate) continue;

        const ts = itemDate.toISOString();

        if (item.isComment && item.postId) {
          // Comment reply → IncomingComment
          results.push({
            platform: "reddit",
            postId: item.postId,
            commentId: item.id,
            userId: item.author,
            username: item.author,
            text: item.body,
            timestamp: ts,
          } satisfies IncomingComment);
        } else {
          // Direct message → IncomingSocialMessage
          results.push({
            platform: "reddit",
            platformMessageId: item.id,
            platformUserId: item.author,
            username: item.author,
            text: item.body,
            timestamp: ts,
          } satisfies IncomingSocialMessage);
        }
      }

      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[RedditBrowserPoll] Poll cycle failed: ${msg}`);
      return results;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
