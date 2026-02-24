/**
 * Multi-platform DM dispatcher — routes DM sends and comment replies
 * through the appropriate native MCP server.
 */

import { logger } from "../../logging/logger.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { SocialPlatform } from "./types.js";
import type { DmSender, CommentReplier } from "./comment-rule-engine.js";

/** Maps SocialPlatform to MCP server name and tool names. */
const PLATFORM_DM_MAP: Record<string, { server: string; dmTool?: string; replyTool?: string }> = {
  instagram: { server: "instagram", dmTool: "send_dm" },
  facebook: { server: "facebook", dmTool: "fb_send_message", replyTool: "fb_send_message" },
  twitter: { server: "twitter", dmTool: "twitter_send_dm" },
  youtube: { server: "youtube", replyTool: "yt_reply_to_comment" },
  linkedin: { server: "linkedin", dmTool: "linkedin_send_message" },
  reddit: { server: "reddit", dmTool: "reddit_send_message", replyTool: "reddit_reply_to_comment" },
};

export interface DmDispatcherOptions {
  localServerManager: LocalMcpServerManager;
}

export class DmDispatcher {
  private mgr: LocalMcpServerManager;

  constructor(opts: DmDispatcherOptions) {
    this.mgr = opts.localServerManager;
  }

  /** Returns a DmSender function compatible with CommentRuleEngine. */
  createDmSender(): DmSender {
    return async (platform: SocialPlatform, userId: string, text: string): Promise<void> => {
      const mapping = PLATFORM_DM_MAP[platform];
      if (!mapping?.dmTool) {
        throw new Error(`DM sending not supported for platform: ${platform}`);
      }

      if (!this.mgr.isRunning(mapping.server)) {
        throw new Error(`${platform} MCP server is not running`);
      }

      const result = await this.mgr.callTool(mapping.server, mapping.dmTool, {
        recipient_id: userId,
        message: text,
        text,
      });

      if (result.isError) {
        throw new Error(`DM send failed (${platform}): ${result.text}`);
      }

      logger.info(`[DmDispatcher] Sent DM via ${platform} to ${userId}`);
    };
  }

  /** Returns a CommentReplier function compatible with CommentRuleEngine. */
  createCommentReplier(): CommentReplier {
    return async (platform: SocialPlatform, commentId: string, text: string): Promise<void> => {
      const mapping = PLATFORM_DM_MAP[platform];
      if (!mapping?.replyTool) {
        throw new Error(`Comment reply not supported for platform: ${platform}`);
      }

      if (!this.mgr.isRunning(mapping.server)) {
        throw new Error(`${platform} MCP server is not running`);
      }

      const result = await this.mgr.callTool(mapping.server, mapping.replyTool, {
        comment_id: commentId,
        text,
        message: text,
      });

      if (result.isError) {
        throw new Error(`Comment reply failed (${platform}): ${result.text}`);
      }

      logger.info(`[DmDispatcher] Replied to comment ${commentId} via ${platform}`);
    };
  }
}
