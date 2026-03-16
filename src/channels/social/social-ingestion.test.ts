import { describe, it, expect, vi } from "vitest";
import {
  TwitterAdapter,
  LinkedInAdapter,
  GenericPollAdapter,
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
});

// ── Twitter adapter edge cases ──

describe("TwitterAdapter - additional", () => {
  const adapter = new TwitterAdapter();

  it("returns null for direct_message_events with no message_create", () => {
    expect(adapter.parseWebhook({ direct_message_events: [{ id: "1" }] })).toBeNull();
  });
});
