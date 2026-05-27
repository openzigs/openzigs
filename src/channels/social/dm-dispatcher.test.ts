import { describe, it, expect, vi } from "vitest";
import { DmDispatcher } from "./dm-dispatcher.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";

const createMockManager = (
  isRunning = true,
  callResult: { text: string; isError?: boolean } = { text: "ok" },
) => {
  return {
    isRunning: vi.fn().mockReturnValue(isRunning),
    callTool: vi.fn().mockResolvedValue(callResult),
  } as unknown as LocalMcpServerManager;
};

describe("DmDispatcher", () => {
  describe("createDmSender", () => {
    it("sends DM via Twitter using participant_id", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("twitter", "user_123", "Hello!");
      expect(mgr.callTool).toHaveBeenCalledWith("twitter", "twitter_send_dm", {
        participant_id: "user_123",
        text: "Hello!",
      });
    });

    it("sends DM via LinkedIn using recipient_urn", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("linkedin", "urn:li:person:abc", "Hello LinkedIn!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        "linkedin_send_message",
        {
          recipient_urn: "urn:li:person:abc",
          text: "Hello LinkedIn!",
        },
      );
    });

    it("sends DM via Reddit using recipient + subject", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("reddit", "testuser", "Hello Redditor!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "reddit",
        "reddit_send_message",
        {
          recipient: "testuser",
          subject: "Message from OpenZigs",
          text: "Hello Redditor!",
        },
      );
    });

    it("sends DM via Instagram using recipient_id + message", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("instagram", "igsid_123", "Hello from IG!");
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "send_dm", {
        recipient_id: "igsid_123",
        message: "Hello from IG!",
      });
    });

    it("sends DM via Facebook using recipient_id + message", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("facebook", "psid_456", "Hello from FB!");
      expect(mgr.callTool).toHaveBeenCalledWith("facebook", "fb_send_message", {
        recipient_id: "psid_456",
        message: "Hello from FB!",
      });
    });

    it("throws for unsupported platform (youtube DM)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("youtube", "user_yt", "Yo!")).rejects.toThrow(
        "DM sending not supported",
      );
    });

    it("throws when server is not running", async () => {
      const mgr = createMockManager(false);
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("twitter", "user_123", "Hi")).rejects.toThrow(
        "MCP server is not running",
      );
    });

    it("throws when callTool returns error", async () => {
      const mgr = createMockManager(true, {
        text: "Auth failed",
        isError: true,
      });
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("twitter", "user_123", "Hi")).rejects.toThrow(
        "DM send failed",
      );
    });
  });

  describe("createCommentReplier", () => {
    it("replies to comment via Twitter using post_tweet with reply_to", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("twitter", "tweet_123", "Great tweet!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_post_tweet",
        {
          text: "Great tweet!",
          reply_to: "tweet_123",
        },
      );
    });

    it("replies to comment via YouTube", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("youtube", "comment_yt_1", "Great video!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "youtube",
        "yt_reply_to_comment",
        {
          parent_id: "comment_yt_1",
          text: "Great video!",
        },
      );
    });

    it("replies to LinkedIn comment with post_urn empty when no postId provided", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("linkedin", "li_comment_1", "Insightful!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        "linkedin_reply_to_comment",
        {
          comment_urn: "li_comment_1",
          text: "Insightful!",
          post_urn: "",
        },
      );
    });

    it("replies to LinkedIn comment with post_urn populated when postId is provided", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier(
        "linkedin",
        "li_comment_1",
        "Insightful!",
        "urn:li:share:9999",
      );
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        "linkedin_reply_to_comment",
        {
          comment_urn: "li_comment_1",
          text: "Insightful!",
          post_urn: "urn:li:share:9999",
        },
      );
    });

    it("replies to comment via Reddit", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("reddit", "t1_abc", "Thanks!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "reddit",
        "reddit_reply_to_comment",
        {
          thing_id: "t1_abc",
          text: "Thanks!",
        },
      );
    });

    it("replies to comment via Instagram using comment_id + message", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("instagram", "ig_comment_1", "Thanks for commenting!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "instagram",
        "reply_to_comment",
        {
          comment_id: "ig_comment_1",
          message: "Thanks for commenting!",
        },
      );
    });

    it("replies to comment via Facebook using comment_id + message", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("facebook", "fb_comment_1", "Great feedback!");
      expect(mgr.callTool).toHaveBeenCalledWith(
        "facebook",
        "fb_reply_to_comment",
        {
          comment_id: "fb_comment_1",
          message: "Great feedback!",
        },
      );
    });

    it("throws when server is not running", async () => {
      const mgr = createMockManager(false);
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await expect(replier("reddit", "t1_abc", "Hi")).rejects.toThrow(
        "MCP server is not running",
      );
    });

    it("throws when callTool returns error", async () => {
      const mgr = createMockManager(true, {
        text: "Permission denied",
        isError: true,
      });
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await expect(replier("twitter", "comment_1", "Hi")).rejects.toThrow(
        "Comment reply failed",
      );
    });
  });

  describe("pinterest & tiktok (unsupported reply / DM)", () => {
    it("rejects DM send for pinterest (no DM API)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();
      await expect(sendDm("pinterest", "user_1", "hi")).rejects.toThrow(
        /DM sending not supported/i,
      );
    });

    it("rejects DM send for tiktok (no DM API)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();
      await expect(sendDm("tiktok", "user_1", "hi")).rejects.toThrow(
        /DM sending not supported/i,
      );
    });

    it("rejects comment-reply for pinterest (no public reply endpoint yet)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();
      await expect(replier("pinterest", "c_1", "hi", "p_1")).rejects.toThrow(
        /Comment reply not supported/i,
      );
    });

    it("rejects comment-reply for tiktok (no public reply endpoint yet)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();
      await expect(replier("tiktok", "c_1", "hi", "p_1")).rejects.toThrow(
        /Comment reply not supported/i,
      );
    });
  });
});
