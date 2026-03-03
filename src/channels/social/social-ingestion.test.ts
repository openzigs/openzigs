import { describe, it, expect, vi } from "vitest";
import {
  InstagramAdapter,
  FacebookAdapter,
  TwitterAdapter,
  LinkedInAdapter,
  GenericPollAdapter,
  SocialIngestionService,
} from "./social-ingestion.js";

// ── InstagramAdapter ──

describe("InstagramAdapter", () => {
  const adapter = new InstagramAdapter();

  it("has platform = instagram", () => {
    expect(adapter.platform).toBe("instagram");
  });

  it("returns null for empty body", () => {
    expect(adapter.parseWebhook({})).toBeNull();
  });

  it("returns null for empty entry", () => {
    expect(adapter.parseWebhook({ entry: [] })).toBeNull();
  });

  it("parses DM messaging webhook", () => {
    const body = {
      entry: [
        {
          messaging: [
            {
              sender: { id: "user_123" },
              message: { mid: "m_abc", text: "Hello!" },
              timestamp: String(Date.now()),
            },
          ],
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    expect("platformMessageId" in result!).toBe(true);
    const msg = result as { platform: string; platformUserId: string; text: string };
    expect(msg.platform).toBe("instagram");
    expect(msg.platformUserId).toBe("user_123");
    expect(msg.text).toBe("Hello!");
  });

  it("parses comment webhook", () => {
    const body = {
      entry: [
        {
          changes: [
            {
              field: "comments",
              value: {
                comment_id: "c_456",
                text: "Nice post!",
                from: { id: "user_789", username: "commenter" },
                media: { id: "media_111" },
              },
            },
          ],
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    expect("commentId" in result!).toBe(true);
    const comment = result as { platform: string; commentId: string; text: string; username: string };
    expect(comment.platform).toBe("instagram");
    expect(comment.commentId).toBe("c_456");
    expect(comment.text).toBe("Nice post!");
    expect(comment.username).toBe("commenter");
  });
});

// ── FacebookAdapter ──

describe("FacebookAdapter", () => {
  const adapter = new FacebookAdapter();

  it("has platform = facebook", () => {
    expect(adapter.platform).toBe("facebook");
  });

  it("returns null for non-page object", () => {
    expect(adapter.parseWebhook({ object: "user" })).toBeNull();
  });

  it("returns null for empty entry", () => {
    expect(adapter.parseWebhook({ object: "page", entry: [] })).toBeNull();
  });

  it("parses page messaging webhook", () => {
    const body = {
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "fb_user_1" },
              message: { mid: "m_fb1", text: "Hi from FB" },
              timestamp: String(Date.now()),
            },
          ],
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const msg = result as { platform: string; platformUserId: string; text: string };
    expect(msg.platform).toBe("facebook");
    expect(msg.platformUserId).toBe("fb_user_1");
    expect(msg.text).toBe("Hi from FB");
  });

  it("parses feed comment webhook", () => {
    const body = {
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                post_id: "post_999",
                comment_id: "c_888",
                from: { id: "fb_user_2", name: "Commenter Name" },
                message: "Great post!",
                created_time: String(Math.floor(Date.now() / 1000)),
              },
            },
          ],
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).not.toBeNull();
    const comment = result as { platform: string; commentId: string; text: string; postId: string };
    expect(comment.platform).toBe("facebook");
    expect(comment.commentId).toBe("c_888");
    expect(comment.postId).toBe("post_999");
    expect(comment.text).toBe("Great post!");
  });

  it("ignores non-comment feed changes", () => {
    const body = {
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: { item: "status", message: "New post" },
            },
          ],
        },
      ],
    };
    const result = adapter.parseWebhook(body);
    expect(result).toBeNull();
  });
});

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
    upsertContact: vi.fn(() => ({ id: "contact-1", platform: "instagram", platform_user_id: "u1", username: "user1", display_name: "", tags: "[]", notes: "", first_seen_at: "", last_seen_at: "", message_count: 1, handoff_active: 0, handoff_thread_id: null, created_at: "", updated_at: "" })),
    insertMessage: vi.fn(() => ({ id: "msg-1", contact_id: "contact-1", platform: "instagram", direction: "inbound", status: "received", platform_message_id: "", content: "hi", metadata: "{}", created_at: "" })),
  });

  it("emits message event on processMessage", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    const handler = vi.fn();
    service.on("message", handler);

    service.processMessage({
      platform: "instagram",
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
    const adapter = new InstagramAdapter();
    service.registerAdapter(adapter);
    expect(service.getRegisteredPlatforms()).toContain("instagram");
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
    await service.handleWebhook("instagram", {}, {});
  });

  it("handleWebhook with adapter that returns null is a no-op", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("instagram", {}, {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("handleWebhook processes DM message", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("message", handler);

    await service.handleWebhook("instagram", {
      entry: [{
        messaging: [{
          sender: { id: "u1" },
          message: { mid: "m1", text: "hi" },
          timestamp: String(Date.now()),
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook emits comment event for comment webhook", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("instagram", {
      entry: [{
        changes: [{
          field: "comments",
          value: {
            from: { id: "u1", username: "user1" },
            text: "nice!",
            comment_id: "c1",
            media: { id: "p1" },
          },
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook enriches comment with post context service", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
    const postContextService = {
      getPostContext: vi.fn().mockResolvedValue({
        postId: "p1", platform: "instagram", caption: "pic", permalink: "http://x",
        mediaType: "IMAGE", mediaUrl: "http://img", authorUsername: "a", publishedAt: "", cachedAt: "",
      }),
    };
    const service = new SocialIngestionService({
      repository: repo as any,
      adapters: [adapter],
      postContextService: postContextService as any,
    });
    const handler = vi.fn();
    service.on("comment", handler);

    await service.handleWebhook("instagram", {
      entry: [{
        changes: [{
          field: "comments",
          value: { from: { id: "u1" }, text: "wow", comment_id: "c2", media: { id: "p1" } },
        }],
      }],
    }, {});

    expect(postContextService.getPostContext).toHaveBeenCalledWith("instagram", "p1");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook continues when post context enrichment fails", async () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter();
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

    await service.handleWebhook("instagram", {
      entry: [{
        changes: [{
          field: "comments",
          value: { from: { id: "u1" }, text: "ok", comment_id: "c3", media: { id: "p1" } },
        }],
      }],
    }, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handleWebhook catches parse errors", async () => {
    const repo = createMockRepo();
    const badAdapter: any = {
      platform: "instagram",
      parseWebhook: () => { throw new Error("parse boom"); },
    };
    const service = new SocialIngestionService({ repository: repo as any, adapters: [badAdapter] });
    // should not throw
    await service.handleWebhook("instagram", {}, {});
  });

  it("stopPolling is no-op when no timer exists", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    service.stopPolling("instagram"); // should not throw
  });

  it("stopAllPolling clears all timers", () => {
    const repo = createMockRepo();
    const service = new SocialIngestionService({ repository: repo as any });
    service.stopAllPolling(); // should not throw
  });

  it("startPolling warns when adapter has no poll method", () => {
    const repo = createMockRepo();
    const adapter = new InstagramAdapter(); // no poll method
    const service = new SocialIngestionService({ repository: repo as any, adapters: [adapter] });
    service.startPolling("instagram", 60); // should log warning, no crash
  });
});

// ── Instagram adapter edge cases ──

describe("InstagramAdapter - additional", () => {
  const adapter = new InstagramAdapter();

  it("returns null for entry with neither messaging nor changes", () => {
    expect(adapter.parseWebhook({ entry: [{ other: "data" }] })).toBeNull();
  });

  it("returns null for messaging without text", () => {
    expect(adapter.parseWebhook({
      entry: [{ messaging: [{ sender: { id: "x" }, message: { mid: "m" } }] }],
    })).toBeNull();
  });
});

// ── Facebook adapter edge cases ──

describe("FacebookAdapter - additional", () => {
  const adapter = new FacebookAdapter();

  it("returns null for page entry with neither messaging nor feed changes", () => {
    expect(adapter.parseWebhook({ object: "page", entry: [{ other: "data" }] })).toBeNull();
  });

  it("returns null for messaging without text", () => {
    expect(adapter.parseWebhook({
      object: "page",
      entry: [{ messaging: [{ sender: { id: "x" }, message: {} }] }],
    })).toBeNull();
  });

  it("returns null for feed changes that are not comments", () => {
    expect(adapter.parseWebhook({
      object: "page",
      entry: [{ changes: [{ field: "feed", value: { item: "post" } }] }],
    })).toBeNull();
  });
});

// ── Twitter adapter edge cases ──

describe("TwitterAdapter - additional", () => {
  const adapter = new TwitterAdapter();

  it("returns null for direct_message_events with no message_create", () => {
    expect(adapter.parseWebhook({ direct_message_events: [{ id: "1" }] })).toBeNull();
  });
});
