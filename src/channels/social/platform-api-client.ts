import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
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
