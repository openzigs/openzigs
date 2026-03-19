import { describe, it, expect, vi } from "vitest";
import {
  TwitterAdapter,
  LinkedInAdapter,
  GenericPollAdapter,
  InstagramAdapter,
  FacebookAdapter,
  SocialIngestionService,
} from "./social-ingestion.js";

// ── TwitterAdapter ──

describe("TwitterAdapter", () => {
  const adapter = new TwitterAdapter();

  it("has platform = twitter", () => {
    expect(adapter.platform).toBe("twitter");
  });

  it("returns null for empty body", () => {
    expect(adapter.parseWebhook({})).toBeNull();
  });

  it("parses direct message event", () => {
    const body = {
      direct_message_events: [
        {
          id: "dm_123",
          created_timestamp: String(Date.now()),
          message_create: {
            sender_id: "tw_user_1",
            message_data: { text: "Hello via DM" },
          },
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const msg = result as { platform: string; platformUserId: string; text: string };
    expect(msg.platform).toBe("twitter");
    expect(msg.platformUserId).toBe("tw_user_1");
    expect(msg.text).toBe("Hello via DM");
  });

  it("parses reply tweet as comment", () => {
    const body = {
      tweet_create_events: [
        {
          id_str: "tweet_456",
          in_reply_to_status_id_str: "tweet_100",
          text: "Nice thread!",
          created_at: "Thu Jun 01 12:00:00 +0000 2026",
          user: { id_str: "tw_user_2", screen_name: "replier" },
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { platform: string; postId: string; commentId: string; text: string };
    expect(comment.platform).toBe("twitter");
    expect(comment.postId).toBe("tweet_100");
    expect(comment.commentId).toBe("tweet_456");
    expect(comment.text).toBe("Nice thread!");
  });

  it("ignores non-reply tweets", () => {
    const body = {
      tweet_create_events: [
        {
          id_str: "tweet_789",
          text: "Just a tweet",
          created_at: "Thu Jun 01 12:00:00 +0000 2026",
          user: { id_str: "tw_user_3", screen_name: "poster" },
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).toBeNull();
  });
});

// ── LinkedInAdapter ──

describe("LinkedInAdapter", () => {
  const adapter = new LinkedInAdapter();

  it("has platform = linkedin", () => {
    expect(adapter.platform).toBe("linkedin");
  });

  it("returns null for unknown event type", () => {
    expect(adapter.parseWebhook({ eventType: "UNKNOWN" })).toBeNull();
  });

  it("parses messaging event", () => {
    const body = {
      eventType: "MESSAGING",
      event: {
        message: { id: "msg_li_1", text: "Hello from LinkedIn" },
        from: { id: "li_user_1" },
        createdAt: Date.now(),
      },
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const msg = result as { platform: string; platformUserId: string; text: string };
    expect(msg.platform).toBe("linkedin");
    expect(msg.platformUserId).toBe("li_user_1");
    expect(msg.text).toBe("Hello from LinkedIn");
  });

  it("parses comment event", () => {
    const body = {
      eventType: "COMMENT",
      event: {
        id: "comment_li_1",
        object: "urn:li:ugcPost:456",
        actor: "urn:li:person:abc",
        message: { text: "Insightful!" },
        createdAt: Date.now(),
      },
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { platform: string; postId: string; commentId: string; text: string };
    expect(comment.platform).toBe("linkedin");
    expect(comment.postId).toBe("urn:li:ugcPost:456");
    expect(comment.commentId).toBe("comment_li_1");
    expect(comment.text).toBe("Insightful!");
  });
});

// ── GenericPollAdapter ──

describe("GenericPollAdapter", () => {
  it("has correct platform", () => {
    const adapter = new GenericPollAdapter("reddit", async () => []);
    expect(adapter.platform).toBe("reddit");
  });

  it("parseWebhook returns null (polling only)", () => {
    const adapter = new GenericPollAdapter("youtube", async () => []);
    expect(adapter.parseWebhook()).toBeNull();
  });

  it("poll delegates to provided function", async () => {
    const items = [
      {
        platform: "reddit" as const,
        postId: "t3_abc",
        commentId: "t1_xyz",
        userId: "u_test",
        username: "testuser",
        text: "Polled comment",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
    const pollFn = async () => items;
    const adapter = new GenericPollAdapter("reddit", pollFn);
    const result = await adapter.poll!("2025-12-31T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(items[0]);
  });
});

// ── SocialIngestionService tests ──────────────────────────────────

describe("SocialIngestionService", () => {
  const createMockRepo = () => ({
    upsertContact: vi.fn(() => ({ id: "contact-1", platform: "twitter", platform_user_id: "u1", username: "user1", display_name: "", tags: "[]", notes: "", first_seen_at: "", last_seen_at: "", message_count: 1, handoff_active: 0, handoff_thread_id: null, created_at: "", updated_at: "" })),
    insertMessage: vi.fn(() => ({ id: "msg-1", contact_id: "contact-1", platform: "twitter", direction: "inbound", status: "received", platform_message_id: "", content: "hi", metadata: "{}", created_at: "" })),
  });

  it("emits message event on processMessage", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    const handler = vi.fn();
    service.on("message", handler);

    service.processMessage({
      platform: "twitter",
      platformMessageId: "m1",
      platformUserId: "u1",
      username: "user1",
      text: "hello",
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(repo.upsertContact).toHaveBeenCalled();
    expect(repo.insertMessage).toHaveBeenCalled();
  });

  it("registerAdapter adds runtime adapter", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    const adapter = new TwitterAdapter();
    service.registerAdapter(adapter);
    expect(service.getRegisteredPlatforms()).toContain("twitter");
  });

  it("getRegisteredPlatforms returns empty array when no adapters", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    expect(service.getRegisteredPlatforms()).toEqual([]);
  });

  it("handleWebhook warns when no adapter for platform", async () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    // should not throw, just log warning
    await service.handleWebhook("twitter", {}, {});
  });

  it("handleWebhook with adapter that returns null is a no-op", async () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("twitter", {}, {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("handleWebhook processes DM message", async () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("twitter", {
      direct_message_events: [{
        id: "dm_1",
        created_timestamp: String(Date.now()),
        message_create: {
          sender_id: "u1",
          message_data: { text: "hi" },
        },
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook emits comment event for comment webhook", async () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("twitter", {
      tweet_create_events: [{
        id_str: "tweet_456",
        in_reply_to_status_id_str: "tweet_100",
        text: "nice!",
        created_at: "Thu Jun 01 12:00:00 +0000 2026",
        user: { id_str: "u1", screen_name: "user1" },
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook enriches comment with post context service", async () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter();
    const postContextService = {
      getPostContext: vi.fn().mockResolvedValue({
        postId: "tweet_100", platform: "twitter", caption: "original tweet", permalink: "http://x",
        mediaType: "TEXT", mediaUrl: "", authorUsername: "a", publishedAt: "", cachedAt: "",
      }),
    };
    const service = new SocialIngestionService({
      repository: repo as any,
      adapters: [adapter],
      postContextService: postContextService as any,
    });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("twitter", {
      tweet_create_events: [{
        id_str: "tweet_456",
        in_reply_to_status_id_str: "tweet_100",
        text: "wow",
        created_at: "Thu Jun 01 12:00:00 +0000 2026",
        user: { id_str: "u1", screen_name: "user1" },
      }],
    }, {});

    expect(postContextService.getPostContext).toHaveBeenCalledWith("twitter", "tweet_100");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook continues when post context enrichment fails", async () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter();
    const postContextService = {
      getPostContext: vi.fn().mockRejectedValue(new Error("API error")),
    };
    const service = new SocialIngestionService({
      repository: repo as any,
      adapters: [adapter],
      postContextService: postContextService as any,
    });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("twitter", {
      tweet_create_events: [{
        id_str: "tweet_456",
        in_reply_to_status_id_str: "tweet_100",
        text: "ok",
        created_at: "Thu Jun 01 12:00:00 +0000 2026",
        user: { id_str: "u1", screen_name: "user1" },
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook catches parse errors", async () => {
    const repo = createMockRepo();
    const badAdapter: any = {
      platform: "twitter",
      parseWebhook: () => { throw new Error("parse boom"); },
    };
    const service = new SocialIngestionService({ repository: repo as any, adapters: [badAdapter] });
    // should not throw
    await service.handleWebhook("twitter", {}, {});
  });

  it("stopPolling is no-op when no timer exists", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    service.stopPolling("twitter"); // should not throw
  });

  it("stopAllPolling clears all timers", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    service.stopAllPolling(); // should not throw
  });

  it("startPolling warns when adapter has no poll method", () => {
    const repo = createMockRepo();
    const adapter = new TwitterAdapter(); // no poll method
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    service.startPolling("twitter", 60); // should log warning, no crash
  });

  it("processMessage skips duplicate messages", () => {
    const repo = createMockRepo();
    repo.insertMessage.mockReturnValueOnce({ id: "msg-1" } as any).mockReturnValueOnce(null as any);
    const service = new SocialIngestionService({ repository: repo as any });
    const handler = vi.fn();
    service.on("message", handler);

    const msg = { platform: "twitter" as const, platformMessageId: "m1", platformUserId: "u1", username: "user1", text: "hi", timestamp: new Date().toISOString() };
    service.processMessage(msg);
    service.processMessage(msg);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("processComment skips duplicate comments", () => {
    const repo = createMockRepo();
    repo.insertMessage.mockReturnValueOnce({ id: "msg-1" } as any).mockReturnValueOnce(null as any);
    const service = new SocialIngestionService({ repository: repo as any });
    const handler = vi.fn();
    service.on("comment", handler);

    const comment = { platform: "twitter" as const, postId: "p1", commentId: "c1", userId: "u1", username: "user1", text: "great", timestamp: new Date().toISOString() };
    service.processComment(comment);
    service.processComment(comment);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── Twitter adapter edge cases ──

describe("TwitterAdapter - additional", () => {
  const adapter = new TwitterAdapter();

  it("returns null for direct_message_events with no message_create", () => {
    expect(adapter.parseWebhook({ direct_message_events: [{ id: "1" }] })).toBeNull();
  });
});

// ── InstagramAdapter ──

describe("InstagramAdapter", () => {
  const adapter = new InstagramAdapter();

  it("has platform = instagram", () => {
    expect(adapter.platform).toBe("instagram");
  });

  it("returns null for empty body", () => {
    expect(adapter.parseWebhook({})).toBeNull();
  });

  it("returns null for entry with no messaging or changes", () => {
    expect(adapter.parseWebhook({ entry: [{ id: "123" }] })).toBeNull();
  });

  it("parses DM (messaging) webhook payload", () => {
    const body = {
      entry: [{
        id: "ig_page_1",
        messaging: [{
          sender: { id: "igsid_user_1" },
          message: { mid: "mid_123", text: "Hello from IG DM" },
          timestamp: Date.now(),
        }],
      }],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const msg = result as { platform: string; platformUserId: string; text: string; platformMessageId: string };
    expect(msg.platform).toBe("instagram");
    expect(msg.platformUserId).toBe("igsid_user_1");
    expect(msg.text).toBe("Hello from IG DM");
    expect(msg.platformMessageId).toBe("mid_123");
  });

  it("parses comment webhook payload (changes with field=comments)", () => {
    const body = {
      entry: [{
        id: "ig_media_1",
        changes: [{
          field: "comments",
          value: {
            id: "comment_456",
            text: "Great post!",
            from: { id: "ig_user_2", username: "commenter" },
            media: { id: "media_789" },
          },
        }],
      }],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { platform: string; postId: string; commentId: string; username: string; text: string };
    expect(comment.platform).toBe("instagram");
    expect(comment.postId).toBe("media_789");
    expect(comment.commentId).toBe("comment_456");
    expect(comment.username).toBe("commenter");
    expect(comment.text).toBe("Great post!");
  });

  it("falls back to entry.id for postId when media is missing", () => {
    const body = {
      entry: [{
        id: "ig_media_fallback",
        changes: [{
          field: "comments",
          value: {
            id: "comment_999",
            text: "Neat!",
            from: { id: "ig_user_3" },
          },
        }],
      }],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { postId: string; username: string };
    expect(comment.postId).toBe("ig_media_fallback");
    expect(comment.username).toBe("ig_user_3"); // falls back to id when no username
  });

  it("ignores changes with non-comments field", () => {
    const body = {
      entry: [{
        id: "ig_1",
        changes: [{ field: "mentions", value: { id: "1" } }],
      }],
    };
    expect(adapter.parseWebhook(body)).toBeNull();
  });

  it("ignores comments with missing required fields", () => {
    const body = {
      entry: [{
        id: "ig_1",
        changes: [{ field: "comments", value: { id: "c1" } }], // no text, no from
      }],
    };
    expect(adapter.parseWebhook(body)).toBeNull();
  });
});

// ── FacebookAdapter ──

describe("FacebookAdapter", () => {
  const adapter = new FacebookAdapter();

  it("has platform = facebook", () => {
    expect(adapter.platform).toBe("facebook");
  });

  it("returns null for empty body", () => {
    expect(adapter.parseWebhook({})).toBeNull();
  });

  it("returns null for entry with no messaging or changes", () => {
    expect(adapter.parseWebhook({ entry: [{ id: "page_1" }] })).toBeNull();
  });

  it("parses Messenger DM (messaging) webhook payload", () => {
    const body = {
      entry: [{
        id: "page_1",
        messaging: [{
          sender: { id: "psid_user_1" },
          message: { mid: "mid_fb_1", text: "Hello from Messenger" },
          timestamp: Date.now(),
        }],
      }],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const msg = result as { platform: string; platformUserId: string; text: string; platformMessageId: string };
    expect(msg.platform).toBe("facebook");
    expect(msg.platformUserId).toBe("psid_user_1");
    expect(msg.text).toBe("Hello from Messenger");
    expect(msg.platformMessageId).toBe("mid_fb_1");
  });

  it("parses Page comment webhook payload (changes with field=feed, item=comment)", () => {
    const body = {
      entry: [{
        id: "page_1",
        changes: [{
          field: "feed",
          value: {
            item: "comment",
            comment_id: "fb_comment_1",
            post_id: "fb_post_1",
            sender_id: "fb_user_1",
            sender_name: "John Doe",
            message: "Nice post!",
            created_time: Math.floor(Date.now() / 1000),
          },
        }],
      }],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { platform: string; postId: string; commentId: string; username: string; text: string };
    expect(comment.platform).toBe("facebook");
    expect(comment.postId).toBe("fb_post_1");
    expect(comment.commentId).toBe("fb_comment_1");
    expect(comment.username).toBe("John Doe");
    expect(comment.text).toBe("Nice post!");
  });

  it("ignores feed changes that are not comments", () => {
    const body = {
      entry: [{
        id: "page_1",
        changes: [{
          field: "feed",
          value: { item: "post", post_id: "p1" },
        }],
      }],
    };
    expect(adapter.parseWebhook(body)).toBeNull();
  });

  it("ignores non-feed changes", () => {
    const body = {
      entry: [{
        id: "page_1",
        changes: [{ field: "ratings", value: { rating: 5 } }],
      }],
    };
    expect(adapter.parseWebhook(body)).toBeNull();
  });

  it("ignores comments with missing required fields", () => {
    const body = {
      entry: [{
        id: "page_1",
        changes: [{
          field: "feed",
          value: { item: "comment", comment_id: "c1" }, // missing post_id, sender_id, message
        }],
      }],
    };
    expect(adapter.parseWebhook(body)).toBeNull();
  });
});

// ── Integration: Instagram/Facebook with SocialIngestionService ──

describe("SocialIngestionService - Instagram/Facebook integration", () => {
  const createMockRepo = () => ({
    upsertContact: vi.fn(() => ({ id: "contact-ig", platform: "instagram", platform_user_id: "u1", username: "user1", display_name: "", tags: "[]", notes: "", first_seen_at: "", last_seen_at: "", message_count: 1, handoff_active: 0, handoff_thread_id: null, created_at: "", updated_at: "" })),
    insertMessage: vi.fn(() => ({ id: "msg-ig", contact_id: "contact-ig", platform: "instagram", direction: "inbound", status: "received", platform_message_id: "", content: "hi", metadata: "{}", created_at: "" })),
  });

  it("handleWebhook processes Instagram DM", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("instagram", {
      entry: [{
        id: "ig_page",
        messaging: [{
          sender: { id: "igsid_1" },
          message: { mid: "mid_1", text: "hi from ig" },
          timestamp: Date.now(),
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(repo.upsertContact).toHaveBeenCalled();
  });

  it("handleWebhook emits comment event for Instagram comment", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("instagram", {
      entry: [{
        id: "ig_media",
        changes: [{
          field: "comments",
          value: {
            id: "c1",
            text: "cool pic",
            from: { id: "u2", username: "fan" },
            media: { id: "m1" },
          },
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
    const comment = handler.mock.calls[0][0];
    expect(comment.platform).toBe("instagram");
    expect(comment.commentId).toBe("c1");
  });

  it("handleWebhook processes Facebook Messenger DM", async () => {
    const repo = createMockRepo();
    const adapter = new FacebookAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("facebook", {
      entry: [{
        id: "page_1",
        messaging: [{
          sender: { id: "psid_1" },
          message: { mid: "mid_fb", text: "hello messenger" },
          timestamp: Date.now(),
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(repo.upsertContact).toHaveBeenCalled();
  });

  it("handleWebhook emits comment event for Facebook Page comment", async () => {
    const repo = createMockRepo();
    const adapter = new FacebookAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("facebook", {
      entry: [{
        id: "page_1",
        changes: [{
          field: "feed",
          value: {
            item: "comment",
            comment_id: "fc1",
            post_id: "fp1",
            sender_id: "fu1",
            sender_name: "Jane",
            message: "love it",
            created_time: Math.floor(Date.now() / 1000),
          },
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
    const comment = handler.mock.calls[0][0];
    expect(comment.platform).toBe("facebook");
    expect(comment.commentId).toBe("fc1");
  });
});
