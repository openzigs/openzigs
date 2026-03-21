/**
 * YouTube browser-based polling adapter.
 * Scrapes comments from YouTube video pages via Chrome DevTools Protocol,
 * eliminating the need for a YouTube Data API key.
 *
 * ⚠️  WARNING: Browser-based scraping may violate YouTube's Terms of Service.
 *     This feature is provided as a beta convenience for users who cannot
 *     obtain API credentials.  Use at your own risk.
 */

import { logger } from "../../logging/logger.js";
import { createBrowserNavigateHandler } from "../../mcp/tools/browser-navigate.js";
import type { IncomingComment } from "./types.js";

interface BrowserPollOptions {
  /** Chrome DevTools host (e.g. "localhost") */
  host: string;
  /** Chrome DevTools port (e.g. 9222) */
  port: number;
  /** YouTube channel URL or handle (e.g. "https://www.youtube.com/@MyChannel") */
  channelUrl: string;
  /** Max videos to check per poll cycle */
  maxVideos?: number;
  /** Max comments to extract per video */
  commentsPerVideo?: number;
}

/**
 * Creates a browser-based poll function for YouTube that returns new comments since `since`.
 *
 * Strategy:
 *   1. Navigate to the channel's videos page and extract recent video URLs.
 *   2. For each video, navigate to it and wait for comments to load.
 *   3. Extract comments from the DOM via `Runtime.evaluate`.
 *   4. Filter to comments newer than `since` and map to `IncomingComment`.
 */
export function createYouTubeBrowserPollFn(
  options: BrowserPollOptions,
): (since: string) => Promise<IncomingComment[]> {
  const {
    host,
    port,
    channelUrl,
    maxVideos = 5,
    commentsPerVideo = 20,
  } = options;

  const browserHandler = createBrowserNavigateHandler({ host, port });

  return async (since: string) => {
    const sinceDate = new Date(since);
    const results: IncomingComment[] = [];

    try {
      // --- Step 1: Navigate to channel videos page ---
      const videosUrl = channelUrl.replace(/\/$/, "") + "/videos";
      const navResult = await browserHandler({ action: "navigate", url: videosUrl });
      if (!navResult.success) {
        logger.warn("[YouTubeBrowserPoll] Failed to navigate to channel videos page");
        return results;
      }

      // Wait for video grid to render
      await sleep(3000);

      // Extract video URLs from the channel page
      const videoLinksResult = await browserHandler({
        action: "evaluate",
        expression: `(() => {
          const links = document.querySelectorAll('a#video-title-link, a#video-title, ytd-rich-grid-media a#thumbnail');
          const urls = [];
          const seen = new Set();
          for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes('/watch?v=') && !seen.has(href)) {
              seen.add(href);
              urls.push(href);
              if (urls.length >= ${maxVideos}) break;
            }
          }
          return JSON.stringify(urls);
        })()`,
      });

      let videoUrls: string[] = [];
      try {
        videoUrls = JSON.parse(videoLinksResult.text ?? "[]") as string[];
      } catch {
        logger.warn("[YouTubeBrowserPoll] Failed to parse video URLs from channel page");
        return results;
      }

      if (videoUrls.length === 0) {
        logger.info("[YouTubeBrowserPoll] No videos found on channel page");
        return results;
      }

      // --- Step 2: For each video, extract comments ---
      for (const videoPath of videoUrls) {
        const videoUrl = videoPath.startsWith("http")
          ? videoPath
          : `https://www.youtube.com${videoPath}`;

        // Extract videoId from URL
        const videoIdMatch = videoUrl.match(/[?&]v=([^&]+)/);
        const videoId = videoIdMatch?.[1] ?? videoPath;

        try {
          await browserHandler({ action: "navigate", url: videoUrl });

          // Scroll down to trigger comment section loading
          await sleep(2000);
          await browserHandler({
            action: "evaluate",
            expression: "window.scrollTo(0, 600)",
          });
          await sleep(3000);

          // Extract comments from the DOM
          const commentsResult = await browserHandler({
            action: "evaluate",
            expression: `(() => {
              const comments = [];
              const commentEls = document.querySelectorAll('ytd-comment-thread-renderer');
              for (let i = 0; i < Math.min(commentEls.length, ${commentsPerVideo}); i++) {
                const el = commentEls[i];
                const authorEl = el.querySelector('#author-text span, #author-text');
                const textEl = el.querySelector('#content-text');
                const timeEl = el.querySelector('.published-time-text a, yt-formatted-string.published-time-text');
                const channelLink = el.querySelector('#author-text');
                const channelHref = channelLink ? channelLink.getAttribute('href') : null;
                const channelId = channelHref ? channelHref.replace(/^\\//, '').replace(/^@/, '') : '';

                const username = authorEl ? authorEl.textContent.trim() : '';
                const text = textEl ? textEl.textContent.trim() : '';
                const timeText = timeEl ? timeEl.textContent.trim() : '';

                if (text) {
                  comments.push({
                    commentId: 'yt-browser-' + i + '-' + Date.now(),
                    userId: channelId || username,
                    username: username,
                    text: text,
                    relativeTime: timeText,
                  });
                }
              }
              return JSON.stringify(comments);
            })()`,
          });

          let extractedComments: Array<{
            commentId: string;
            userId: string;
            username: string;
            text: string;
            relativeTime: string;
          }> = [];
          try {
            extractedComments = JSON.parse(commentsResult.text ?? "[]");
          } catch {
            logger.warn(`[YouTubeBrowserPoll] Failed to parse comments for ${videoId}`);
            continue;
          }

          for (const c of extractedComments) {
            // Parse relative time (e.g. "2 hours ago", "1 day ago") into approximate date
            const commentDate = parseRelativeTime(c.relativeTime);
            if (commentDate && commentDate <= sinceDate) continue;

            results.push({
              platform: "youtube",
              postId: videoId,
              commentId: c.commentId,
              userId: c.userId,
              username: c.username,
              text: c.text,
              timestamp: commentDate?.toISOString() ?? new Date().toISOString(),
            } satisfies IncomingComment);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[YouTubeBrowserPoll] Error extracting comments for ${videoId}: ${msg}`);
          continue;
        }
      }

      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[YouTubeBrowserPoll] Poll cycle failed: ${msg}`);
      return results;
    }
  };
}

/**
 * Parse a YouTube relative time string like "2 hours ago", "1 day ago" etc.
 * into an approximate Date. Returns null if unparseable.
 */
function parseRelativeTime(text: string): Date | null {
  if (!text) return null;

  const now = Date.now();
  const lc = text.toLowerCase().trim();

  // Match patterns like "2 hours ago", "1 day ago", "3 weeks ago"
  const match = lc.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) {
    // "just now" or similar
    if (lc.includes("just now") || lc.includes("moment")) {
      return new Date(now);
    }
    return null;
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  const MS: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  const ms = MS[unit];
  if (!ms) return null;

  return new Date(now - amount * ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
