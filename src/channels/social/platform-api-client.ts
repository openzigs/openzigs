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

// ── Instagram API Client ─────────────────────────────────────────────

const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v24.0";

export class InstagramApiClient implements PlatformApiClient {
  readonly platform: SocialPlatform = "instagram";
  private accessToken: string;
  private baseUrl: string;

  constructor(accessToken: string, baseUrl = "https://graph.instagram.com") {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
  }

  async fetchPostContext(postId: string): Promise<PostContext | null> {
    const fields = "caption,permalink,media_type,media_url,username,timestamp";
    const url = `${this.baseUrl}/${META_GRAPH_API_VERSION}/${encodeURIComponent(postId)}?fields=${fields}&access_token=${this.accessToken}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "OpenZigs-SocialBrain/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`[InstagramApiClient] GET /${postId} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as Record<string, string>;
    return {
      postId,
      platform: "instagram",
      caption: data.caption ?? "",
      permalink: data.permalink ?? "",
      mediaType: data.media_type ?? "",
      mediaUrl: data.media_url ?? "",
      authorUsername: data.username ?? "",
      publishedAt: data.timestamp ?? "",
      cachedAt: new Date().toISOString(),
    };
  }
}
