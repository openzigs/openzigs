import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { PostContext, SocialPlatform } from "./types.js";

/**
 * Interface for platform-specific API clients that can fetch post/media
 * details given a post ID. Each platform adapter implements this.
 */
export interface PlatformApiClient {
  readonly platform: SocialPlatform;
  /** Fetch post details from the platform API. Returns null if unavailable. */
  fetchPostContext(postId: string): Promise<PostContext | null>;
}

/**
 * Manages post context enrichment: checks SQLite cache first, then
 * delegates to the platform-specific API client on cache miss.
 */
export class PostContextService {
  private repository: SocialRepository;
  private clients = new Map<SocialPlatform, PlatformApiClient>();
  private cacheTtlMs: number;

  constructor(repository: SocialRepository, cacheTtlMs = 24 * 60 * 60 * 1000) {
    this.repository = repository;
    this.cacheTtlMs = cacheTtlMs;
  }

  registerClient(client: PlatformApiClient): void {
    this.clients.set(client.platform, client);
  }

  /**
   * Get post context — cache-first, then API fallback.
   * Returns null if the platform has no API client or the fetch fails.
   */
  async getPostContext(platform: SocialPlatform, postId: string): Promise<PostContext | null> {
    // 1. Check cache
    const cached = this.repository.getPostContext(postId);
    if (cached) {
      const age = Date.now() - new Date(cached.cachedAt).getTime();
      if (age < this.cacheTtlMs) return cached;
    }

    // 2. Fetch from platform API
    const client = this.clients.get(platform);
    if (!client) return cached ?? null; // stale cache better than nothing

    try {
      const ctx = await client.fetchPostContext(postId);
      if (ctx) {
        this.repository.cachePostContext(ctx);
        return ctx;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[PostContextService] Failed to fetch post ${postId} from ${platform}: ${msg}`);
    }

    return cached ?? null;
  }
}

// ── Twitter API Client ───────────────────────────────────────────────

export class TwitterApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "twitter";
  private bearerToken: string;
  private baseUrl: string;

  constructor(bearerToken: string, baseUrl = "https://api.twitter.com/2") {
    this.bearerToken = bearerToken;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = `${this.baseUrl}/tweets/${encodeURIComponent(postId)}?tweet.fields=created_at,public_metrics,text,author_id`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}`, "User-Agent": "OpenZigs-SocialBrain/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[TwitterApiClient] GET /tweets/${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json()) as { data?: Record<string, string> };
    const tweet = json.data;
    if (!tweet) return null;
    return {
      postId,
      platform: "twitter",
      caption: tweet.text ?? "",
      permalink: `https://twitter.com/i/status/${postId}`,
      mediaType: "tweet",
      mediaUrl: "",
      authorUsername: tweet.author_id ?? "",
      publishedAt: tweet.created_at ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}

// ── YouTube API Client ───────────────────────────────────────────────

export class YouTubeApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "youtube";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://www.googleapis.com/youtube/v3") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = `${this.baseUrl}/videos?part=snippet,statistics&id=${encodeURIComponent(postId)}&key=${this.apiKey}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "OpenZigs-SocialBrain/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[YouTubeApiClient] GET /videos/${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json()) as { items?: Array<{ snippet?: Record<string, string> }> };
    const item = json.items?.[0];
    if (!item?.snippet) return null;
    const snippet = item.snippet;
    return {
      postId,
      platform: "youtube",
      caption: snippet.title ?? "",
      permalink: `https://www.youtube.com/watch?v=${postId}`,
      mediaType: "video",
      mediaUrl: snippet.thumbnails ? "" : "",
      authorUsername: snippet.channelTitle ?? "",
      publishedAt: snippet.publishedAt ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}

// ── LinkedIn API Client ──────────────────────────────────────────────

export class LinkedInApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "linkedin";
  private accessToken: string;
  private baseUrl: string;

  constructor(accessToken: string, baseUrl = "https://api.linkedin.com/v2") {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = `${this.baseUrl}/ugcPosts/${encodeURIComponent(postId)}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "User-Agent": "OpenZigs-SocialBrain/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[LinkedInApiClient] GET /ugcPosts/${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as Record<string, unknown>;
    const specificContent = data.specificContent as Record<string, unknown> | undefined;
    const shareContent = specificContent?.["com.linkedin.ugc.ShareContent"] as Record<string, unknown> | undefined;
    const commentary = shareContent?.shareCommentary as Record<string, string> | undefined;
    return {
      postId,
      platform: "linkedin",
      caption: commentary?.text ?? "",
      permalink: `https://www.linkedin.com/feed/update/${postId}`,
      mediaType: "post",
      mediaUrl: "",
      authorUsername: (data.author as string) ?? "",
      publishedAt: data.created ? new Date(data.created as number).toISOString() : "",
      cachedAt: new Date().toISOString(),
    };
  }
}

// ── TikTok API Client (via TikNeuron) ────────────────────────────────

export class TikTokApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "tiktok";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://tikneuron.com/api/mcp") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = new URL(`${this.baseUrl}/post-detail`);
    url.searchParams.set("tiktok_url", postId);

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "MCP-API-KEY": this.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[TikTokApiClient] GET /post-detail/${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      success: boolean;
      details?: {
        description?: string;
        video_id?: string;
        creator?: string;
        created_at?: string;
        duration?: number;
      };
    };

    if (!data.success || !data.details) return null;

    const d = data.details;
    return {
      postId: d.video_id ?? postId,
      platform: "tiktok",
      caption: d.description ?? "",
      permalink: `https://www.tiktok.com/@${d.creator ?? "unknown"}/video/${d.video_id ?? postId}`,
      mediaType: "VIDEO",
      mediaUrl: "",
      authorUsername: d.creator ?? "",
      publishedAt: d.created_at ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}

// ── Reddit API Client (via Reddit MCP server) ────────────────────────

export class RedditApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "reddit";
  private serverManager: LocalMcpServerManager;

  constructor(serverManager: LocalMcpServerManager) {
    this.serverManager = serverManager;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    // postId may be a fullname like "t3_abc123" or just "abc123"
    const rawId = postId.startsWith("t3_") ? postId.slice(3) : postId;

    const result = await this.serverManager.callTool("reddit", "reddit_get_post_comments", {
      subreddit: "all",
      post_id: rawId,
      limit: 1,
    });

    if (result.isError) {
      logger.warn(`[RedditApiClient] reddit_get_post_comments failed for ${postId}: ${result.text.slice(0, 200)}`);
      return null;
    }

    try {
      const parsed = JSON.parse(result.text) as {
        success?: boolean;
        data?: Array<{
          data?: {
            children?: Array<{
              data?: {
                title?: string;
                selftext?: string;
                author?: string;
                created_utc?: number;
                permalink?: string;
                url?: string;
                is_video?: boolean;
              };
            }>;
          };
        }>;
      };

      if (!parsed.success && !parsed.data) return null;

      // Reddit returns [listing (post), listing (comments)]
      const postData = parsed.data?.[0]?.data?.children?.[0]?.data;
      if (!postData) return null;

      return {
        postId: rawId,
        platform: "reddit",
        caption: postData.title ?? postData.selftext ?? "",
        permalink: postData.permalink
          ? `https://www.reddit.com${postData.permalink}`
          : `https://www.reddit.com/comments/${rawId}`,
        mediaType: postData.is_video ? "video" : "post",
        mediaUrl: postData.url ?? "",
        authorUsername: postData.author ?? "",
        publishedAt: postData.created_utc
          ? new Date(postData.created_utc * 1000).toISOString()
          : "",
        cachedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn(`[RedditApiClient] Failed to parse reddit response for ${postId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

// ── Instagram API Client ─────────────────────────────────────────────

export class InstagramApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "instagram";
  private accessToken: string;
  private baseUrl: string;

  constructor(accessToken: string, baseUrl = "https://graph.instagram.com/v19.0") {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(postId)}?fields=id,caption,media_type,media_url,timestamp,permalink,username&access_token=${encodeURIComponent(this.accessToken)}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "OpenZigs-SocialBrain/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[InstagramApiClient] GET /${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      id?: string;
      caption?: string;
      media_type?: string;
      media_url?: string;
      timestamp?: string;
      permalink?: string;
      username?: string;
    };

    if (!data.id) return null;
    return {
      postId: data.id,
      platform: "instagram",
      caption: data.caption ?? "",
      permalink: data.permalink ?? `https://www.instagram.com/p/${postId}`,
      mediaType: data.media_type ?? "IMAGE",
      mediaUrl: data.media_url ?? "",
      authorUsername: data.username ?? "",
      publishedAt: data.timestamp ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}

// ── Facebook API Client ──────────────────────────────────────────────

export class FacebookApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "facebook";
  private accessToken: string;
  private baseUrl: string;

  constructor(accessToken: string, baseUrl = "https://graph.facebook.com/v19.0") {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(postId)}?fields=id,message,type,created_time,from,permalink_url&access_token=${encodeURIComponent(this.accessToken)}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "OpenZigs-SocialBrain/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[FacebookApiClient] GET /${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      id?: string;
      message?: string;
      type?: string;
      created_time?: string;
      from?: { name?: string; id?: string };
      permalink_url?: string;
    };

    if (!data.id) return null;
    return {
      postId: data.id,
      platform: "facebook",
      caption: data.message ?? "",
      permalink: data.permalink_url ?? `https://www.facebook.com/${postId}`,
      mediaType: data.type ?? "status",
      mediaUrl: "",
      authorUsername: data.from?.name ?? "",
      publishedAt: data.created_time ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}
