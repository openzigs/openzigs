import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialRepository } from "./social-repository.js";
import {
  PostContextService,
  TwitterApiClient,
  YouTubeApiClient,
  LinkedInApiClient,
  RedditApiClient,
} from "./platform-api-client.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

// ── PostContextService ──

describe("PostContextService", () => {
  let repo: SocialRepository;
  let service: PostContextService;

  beforeEach(() => {
    const db = createTestDb();
    repo = new SocialRepository(db);
    repo.migrate();
    service = new PostContextService(repo);
  });

  it("registers client by platform", () => {
    const client = new TwitterApiClient("test-token");
    service.registerClient(client);
    // No error means it registered successfully
    expect(true).toBe(true);
  });

  it("returns null for unregistered platform", async () => {
    const result = await service.getPostContext("twitter", "123");
    expect(result).toBeNull();
  });

  it("caches post context on second call", async () => {
    const client = new TwitterApiClient("test-token");
    const fetchSpy = vi.fn().mockResolvedValue({
      postId: "123",
      platform: "twitter",
      caption: "Hello",
      permalink: "https://x.com/p/123",
      mediaType: "IMAGE",
      mediaUrl: "",
      authorUsername: "test_user",
      publishedAt: "2026-01-01T00:00:00Z",
      cachedAt: new Date().toISOString(),
    });
    client.fetchPostContext = fetchSpy;
    service.registerClient(client);

    await service.getPostContext("twitter", "123");
    await service.getPostContext("twitter", "123");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cached
  });

  it("registers multiple platform clients without error", () => {
    service.registerClient(new TwitterApiClient("tw-token"));
    service.registerClient(new YouTubeApiClient("yt-key"));
    service.registerClient(new LinkedInApiClient("li-token"));
    // All 3 registered without error
    expect(true).toBe(true);
  });
});

// ── TwitterApiClient ──

describe("TwitterApiClient", () => {
  it("has platform = twitter", () => {
    const client = new TwitterApiClient("bearer-token");
    expect(client.platform).toBe("twitter");
  });

  it("returns null on HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }) as unknown as typeof fetch;

    const client = new TwitterApiClient("bad-token");
    const result = await client.fetchPostContext("tweet_123");
    expect(result).toBeNull();
  });

  it("parses successful tweet response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          text: "Hello Twitter!",
          author_id: "user_789",
          created_at: "2026-01-05T10:00:00Z",
        },
      }),
    }) as unknown as typeof fetch;

    const client = new TwitterApiClient("good-token");
    const result = await client.fetchPostContext("tweet_123");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("twitter");
    expect(result!.caption).toBe("Hello Twitter!");
    expect(result!.permalink).toContain("tweet_123");
  });

  it("returns null when data is missing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const client = new TwitterApiClient("good-token");
    const result = await client.fetchPostContext("tweet_999");
    expect(result).toBeNull();
  });
});

// ── YouTubeApiClient ──

describe("YouTubeApiClient", () => {
  it("has platform = youtube", () => {
    const client = new YouTubeApiClient("api-key");
    expect(client.platform).toBe("youtube");
  });

  it("returns null when no items", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;

    const client = new YouTubeApiClient("api-key");
    const result = await client.fetchPostContext("video_123");
    expect(result).toBeNull();
  });

  it("parses successful video response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            snippet: {
              title: "My Video",
              channelTitle: "My Channel",
              publishedAt: "2026-02-01T08:00:00Z",
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const client = new YouTubeApiClient("api-key");
    const result = await client.fetchPostContext("video_123");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("youtube");
    expect(result!.caption).toBe("My Video");
    expect(result!.permalink).toContain("video_123");
  });
});

// ── LinkedInApiClient ──

describe("LinkedInApiClient", () => {
  it("has platform = linkedin", () => {
    const client = new LinkedInApiClient("access-token");
    expect(client.platform).toBe("linkedin");
  });

  it("returns null on HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }) as unknown as typeof fetch;

    const client = new LinkedInApiClient("bad-token");
    const result = await client.fetchPostContext("urn:li:ugcPost:123");
    expect(result).toBeNull();
  });

  it("parses successful post response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        author: "urn:li:person:abc",
        created: 1706745600000,
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: "LinkedIn post text" },
          },
        },
      }),
    }) as unknown as typeof fetch;

    const client = new LinkedInApiClient("good-token");
    const result = await client.fetchPostContext("urn:li:ugcPost:123");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("linkedin");
    expect(result!.caption).toBe("LinkedIn post text");
    expect(result!.authorUsername).toBe("urn:li:person:abc");
  });
});

// ── RedditApiClient ──

const createMockServerManager = (response: { text: string; isError?: boolean }) => ({
  callTool: vi.fn().mockResolvedValue(response),
  isRunning: vi.fn().mockReturnValue(true),
});

describe("RedditApiClient", () => {
  it("has platform = reddit", () => {
    const mgr = createMockServerManager({ text: "{}" });
    const client = new RedditApiClient(mgr as any);
    expect(client.platform).toBe("reddit");
  });

  it("returns null on MCP error", async () => {
    const mgr = createMockServerManager({ text: "Server not running", isError: true });
    const client = new RedditApiClient(mgr as any);
    const result = await client.fetchPostContext("t3_abc123");
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const mgr = createMockServerManager({ text: "not json" });
    const client = new RedditApiClient(mgr as any);
    const result = await client.fetchPostContext("abc123");
    expect(result).toBeNull();
  });

  it("returns null when no post data in response", async () => {
    const mgr = createMockServerManager({
      text: JSON.stringify({ success: true, data: [] }),
    });
    const client = new RedditApiClient(mgr as any);
    const result = await client.fetchPostContext("abc123");
    expect(result).toBeNull();
  });

  it("parses successful post context response", async () => {
    const mgr = createMockServerManager({
      text: JSON.stringify({
        success: true,
        data: [
          {
            data: {
              children: [
                {
                  data: {
                    title: "Test Reddit Post",
                    selftext: "This is the body",
                    author: "testuser",
                    created_utc: 1706745600,
                    permalink: "/r/test/comments/abc123/test_post/",
                    is_video: false,
                    url: "https://reddit.com/r/test/comments/abc123/",
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const client = new RedditApiClient(mgr as any);
    const result = await client.fetchPostContext("t3_abc123");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("reddit");
    expect(result!.postId).toBe("abc123");
    expect(result!.caption).toBe("Test Reddit Post");
    expect(result!.authorUsername).toBe("testuser");
    expect(result!.permalink).toContain("reddit.com");
    expect(result!.mediaType).toBe("post");
  });

  it("strips t3_ prefix from postId", async () => {
    const mgr = createMockServerManager({
      text: JSON.stringify({
        success: true,
        data: [
          {
            data: {
              children: [{ data: { title: "Title", author: "u", created_utc: 0 } }],
            },
          },
        ],
      }),
    });
    const client = new RedditApiClient(mgr as any);
    await client.fetchPostContext("t3_xyz789");
    expect(mgr.callTool).toHaveBeenCalledWith("reddit", "reddit_get_post_comments", {
      subreddit: "all",
      post_id: "xyz789",
      limit: 1,
    });
  });

  it("detects video posts", async () => {
    const mgr = createMockServerManager({
      text: JSON.stringify({
        success: true,
        data: [
          {
            data: {
              children: [
                {
                  data: {
                    title: "Video Post",
                    author: "poster",
                    created_utc: 1706745600,
                    is_video: true,
                    url: "https://v.redd.it/abc",
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const client = new RedditApiClient(mgr as any);
    const result = await client.fetchPostContext("vid123");
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe("video");
  });

  it("registers with PostContextService", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const repo = new SocialRepository(db);
    repo.migrate();
    const service = new PostContextService(repo);
    const mgr = createMockServerManager({ text: "{}" });
    const client = new RedditApiClient(mgr as any);
    service.registerClient(client);
    // No error = success
    expect(true).toBe(true);
  });
});
