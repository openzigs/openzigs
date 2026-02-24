import { describe, it, expect, vi } from "vitest";
import { DmDispatcher } from "./dm-dispatcher.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";

const createMockManager = (isRunning = true, callResult: { text: string; isError?: boolean } = { text: "ok" }) => {
  return {
    isRunning: vi.fn().mockReturnValue(isRunning),
    callTool: vi.fn().mockResolvedValue(callResult),
  } as unknown as LocalMcpServerManager;
};

describe("DmDispatcher", () => {
  describe("createDmSender", () => {
    it("sends DM via Instagram", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("instagram", "user_123", "Hello!");
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "send_dm", expect.objectContaining({ message: "Hello!" }));
    });

    it("sends DM via Facebook", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("facebook", "user_456", "Hi FB!");
      expect(mgr.callTool).toHaveBeenCalledWith("facebook", "fb_send_message", expect.objectContaining({ message: "Hi FB!" }));
    });

    it("sends DM via Twitter", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("twitter", "user_789", "Hey X!");
      expect(mgr.callTool).toHaveBeenCalledWith("twitter", "twitter_send_dm", expect.objectContaining({ message: "Hey X!" }));
    });

    it("sends DM via LinkedIn", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("linkedin", "urn:li:person:abc", "Hello LinkedIn!");
      expect(mgr.callTool).toHaveBeenCalledWith("linkedin", "linkedin_send_message", expect.objectContaining({ message: "Hello LinkedIn!" }));
    });

    it("sends DM via Reddit", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await sendDm("reddit", "testuser", "Hello Redditor!");
      expect(mgr.callTool).toHaveBeenCalledWith("reddit", "reddit_send_message", expect.objectContaining({ message: "Hello Redditor!" }));
    });

    it("throws for unsupported platform (youtube DM)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("youtube", "user_yt", "Yo!")).rejects.toThrow("DM sending not supported");
    });

    it("throws when server is not running", async () => {
      const mgr = createMockManager(false);
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("instagram", "user_123", "Hi")).rejects.toThrow("MCP server is not running");
    });

    it("throws when callTool returns error", async () => {
      const mgr = createMockManager(true, { text: "Auth failed", isError: true });
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const sendDm = dispatcher.createDmSender();

      await expect(sendDm("instagram", "user_123", "Hi")).rejects.toThrow("DM send failed");
    });
  });

  describe("createCommentReplier", () => {
    it("replies to comment via Reddit", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("reddit", "t1_abc", "Thanks!");
      expect(mgr.callTool).toHaveBeenCalledWith("reddit", "reddit_reply_to_comment", expect.objectContaining({ text: "Thanks!" }));
    });

    it("replies to comment via YouTube", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await replier("youtube", "comment_yt_1", "Great video!");
      expect(mgr.callTool).toHaveBeenCalledWith("youtube", "yt_reply_to_comment", expect.objectContaining({ text: "Great video!" }));
    });

    it("throws for platform without comment reply (twitter)", async () => {
      const mgr = createMockManager();
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await expect(replier("twitter", "tweet_123", "Reply")).rejects.toThrow("Comment reply not supported");
    });

    it("throws when server is not running", async () => {
      const mgr = createMockManager(false);
      const dispatcher = new DmDispatcher({ localServerManager: mgr });
      const replier = dispatcher.createCommentReplier();

      await expect(replier("reddit", "t1_abc", "Hi")).rejects.toThrow("MCP server is not running");
    });
  });
});
