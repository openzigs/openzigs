import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type { PostContextService } from "./platform-api-client.js";
import type { IncomingSocialMessage, IncomingComment, SocialPlatform } from "./types.js";

/** Platform adapter interface — each platform implements this. */
export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  /** Parse an inbound webhook payload into a normalised message (or null if not applicable). */
  parseWebhook(body: unknown, headers: Record<string, string>): IncomingSocialMessage | IncomingComment | null;
  /** Poll for new messages since the given timestamp. */
  poll?(since: string): Promise<(IncomingSocialMessage | IncomingComment)[]>;
}

export type SocialIngestionOptions = {
  repository: SocialRepository;
  adapters?: SocialPlatformAdapter[];
  postContextService?: PostContextService;
};

/**
 * SocialIngestionService normalises inbound social messages from webhooks and
 * polling into a unified stream. Emits events for downstream processing
 * (Brain, Comment Rule Engine).
 */
export class SocialIngestionService extends EventEmitter {
  private repository: SocialRepository;
  private adapters = new Map<SocialPlatform, SocialPlatformAdapter>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private postContextService?: PostContextService;

  constructor(opts: SocialIngestionOptions) {
    super();
    this.repository = opts.repository;
    this.postContextService = opts.postContextService;
    for (const adapter of opts.adapters ?? []) {
      this.adapters.set(adapter.platform, adapter);
    }
  }

  /** Register a platform adapter at runtime (e.g., after config loads). */
  registerAdapter(adapter: SocialPlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  /** Handle a raw webhook payload — delegates to the platform adapter. */
  async handleWebhook(platform: SocialPlatform, body: unknown, headers: Record<string, string>): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      logger.warn(`[SocialIngestion] No adapter registered for platform: ${platform}`);
      return;
    }

    try {
      const parsed = adapter.parseWebhook(body, headers);
      if (!parsed) return;

      if ("commentId" in parsed) {
        const comment = parsed as IncomingComment;
        // Enrich comment with post context (non-blocking on failure)
        if (this.postContextService && comment.postId) {
          try {
            const ctx = await this.postContextService.getPostContext(comment.platform, comment.postId);
            if (ctx) comment.postContext = ctx;
          } catch (err) {
            const ctxMsg = err instanceof Error ? err.message : String(err);
            logger.warn(`[SocialIngestion] Post context enrichment failed: ${ctxMsg}`);
          }
        }
        this.emit("comment", comment);
      } else {
        this.processMessage(parsed as IncomingSocialMessage);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SocialIngestion] Webhook parse error (${platform}): ${msg}`);
    }
  }

  /** Process a normalised inbound social message. */
  processMessage(msg: IncomingSocialMessage): void {
    // Upsert contact in CRM
    const contact = this.repository.upsertContact({
      platform: msg.platform,
      platformUserId: msg.platformUserId,
      username: msg.username,
      displayName: msg.displayName,
    });

    // Log the inbound message
    const message = this.repository.insertMessage({
      contactId: contact.id,
      platform: msg.platform,
      direction: "inbound",
      status: "received",
      platformMessageId: msg.platformMessageId,
      content: msg.text,
      metadata: msg.metadata,
    });

    // Emit for downstream processing (Brain)
    this.emit("message", { message, contact, raw: msg });
  }

  /** Start polling for a platform at the given interval (seconds). */
  startPolling(platform: SocialPlatform, intervalSeconds: number): void {
    const adapter = this.adapters.get(platform);
    if (!adapter?.poll) {
      logger.warn(`[SocialIngestion] Adapter for ${platform} does not support polling`);
      return;
    }

    // Stop existing timer if any
    this.stopPolling(platform);

    let lastPoll = new Date(Date.now() - intervalSeconds * 1000).toISOString();

    const poll = async () => {
      try {
        const items = await adapter.poll!(lastPoll);
        lastPoll = new Date().toISOString();
        for (const item of items) {
          if ("commentId" in item) {
            const comment = item as IncomingComment;
            if (this.postContextService && comment.postId) {
              try {
                const ctx = await this.postContextService.getPostContext(comment.platform, comment.postId);
                if (ctx) comment.postContext = ctx;
              } catch { /* best-effort enrichment */ }
            }
            this.emit("comment", comment);
          } else {
            this.processMessage(item);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[SocialIngestion] Poll error (${platform}): ${msg}`);
      }
    };

    const timer = setInterval(poll, intervalSeconds * 1000);
    this.pollTimers.set(platform, timer);
    logger.info(`[SocialIngestion] Started polling ${platform} every ${intervalSeconds}s`);

    // Do an initial poll immediately
    void poll();
  }

  stopPolling(platform: SocialPlatform): void {
    const timer = this.pollTimers.get(platform);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(platform);
    }
  }

  stopAllPolling(): void {
    for (const [platform] of this.pollTimers) {
      this.stopPolling(platform as SocialPlatform);
    }
  }

  getRegisteredPlatforms(): SocialPlatform[] {
    return [...this.adapters.keys()];
  }
}

// ── Built-in Platform Adapters ───────────────────────────────────────

/** Instagram webhook adapter (Meta Graph API format). */
export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "instagram";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;
    const entry = (payload.entry as Array<Record<string, unknown>>)?.[0];
    if (!entry) return null;

    // DM / messaging webhook
    const messaging = (entry.messaging as Array<Record<string, unknown>>)?.[0];
    if (messaging) {
      const sender = messaging.sender as Record<string, string>;
      const message = messaging.message as Record<string, string>;
      if (!sender?.id || !message?.text) return null;

      return {
        platform: "instagram",
        platformMessageId: message.mid ?? "",
        platformUserId: sender.id,
        username: sender.id, // resolved later via API
        text: message.text,
        timestamp: new Date(Number(messaging.timestamp ?? Date.now())).toISOString(),
      };
    }

    // Comment webhook
    const changes = (entry.changes as Array<Record<string, unknown>>)?.[0];
    if (changes?.field === "comments") {
      const value = changes.value as Record<string, unknown>;
      if (!value) return null;
      const from = value.from as Record<string, string> | undefined;
      const media = value.media as Record<string, string> | undefined;
      return {
        platform: "instagram",
        postId: media?.id ?? (value.media_id as string) ?? "",
        commentId: (value.comment_id as string) ?? (value.id as string) ?? "",
        userId: from?.id ?? "",
        username: from?.username ?? from?.id ?? "",
        text: (value.text as string) ?? "",
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }
}

/** Facebook webhook adapter (Meta Graph API format). */
export class FacebookAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "facebook";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;
    if (payload.object !== "page") return null;
    const entry = (payload.entry as Array<Record<string, unknown>>)?.[0];
    if (!entry) return null;

    // Page messaging
    const messaging = (entry.messaging as Array<Record<string, unknown>>)?.[0];
    if (messaging) {
      const sender = messaging.sender as Record<string, string>;
      const message = messaging.message as Record<string, string>;
      if (!sender?.id || !message?.text) return null;

      return {
        platform: "facebook",
        platformMessageId: message.mid ?? "",
        platformUserId: sender.id,
        username: sender.id,
        text: message.text,
        timestamp: new Date(Number(messaging.timestamp ?? Date.now())).toISOString(),
      };
    }

    // Feed changes (comments)
    const changes = (entry.changes as Array<Record<string, unknown>>)?.[0];
    if (changes?.field === "feed") {
      const value = changes.value as Record<string, unknown>;
      if (!value || value.item !== "comment") return null;
      return {
        platform: "facebook",
        postId: (value.post_id as string) ?? "",
        commentId: (value.comment_id as string) ?? "",
        userId: (value.from as Record<string, string>)?.id ?? "",
        username: (value.from as Record<string, string>)?.name ?? "",
        text: (value.message as string) ?? "",
        timestamp: new Date(Number(value.created_time ?? Date.now()) * 1000).toISOString(),
      };
    }

    return null;
  }
}

/** Twitter/X Account Activity API webhook adapter. */
export class TwitterAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "twitter";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;

    // Direct message events
    const dmEvents = payload.direct_message_events as Array<Record<string, unknown>> | undefined;
    if (dmEvents?.length) {
      const event = dmEvents[0];
      const msgCreate = event.message_create as Record<string, unknown>;
      if (!msgCreate) return null;
      const msgData = msgCreate.message_data as Record<string, string>;
      return {
        platform: "twitter",
        platformMessageId: (event.id as string) ?? "",
        platformUserId: (msgCreate.sender_id as string) ?? "",
        username: (msgCreate.sender_id as string) ?? "",
        text: msgData?.text ?? "",
        timestamp: new Date(Number(event.created_timestamp ?? Date.now())).toISOString(),
      };
    }

    // Tweet create events (mentions / replies treated as comments)
    const tweetCreateEvents = payload.tweet_create_events as Array<Record<string, unknown>> | undefined;
    if (tweetCreateEvents?.length) {
      const tweet = tweetCreateEvents[0];
      const user = tweet.user as Record<string, string>;
      const inReplyTo = tweet.in_reply_to_status_id_str as string | undefined;
      if (inReplyTo) {
        return {
          platform: "twitter",
          postId: inReplyTo,
          commentId: (tweet.id_str as string) ?? "",
          userId: user?.id_str ?? "",
          username: user?.screen_name ?? "",
          text: (tweet.text as string) ?? "",
          timestamp: new Date(tweet.created_at as string).toISOString(),
        };
      }
    }

    return null;
  }
}

/** LinkedIn webhook adapter (organization events). */
export class LinkedInAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "linkedin";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;

    // LinkedIn uses a batch-style format with eventType
    const eventType = payload.eventType as string | undefined;

    if (eventType === "MESSAGING") {
      const event = payload.event as Record<string, unknown>;
      if (!event) return null;
      const msg = event.message as Record<string, unknown>;
      const sender = event.from as Record<string, string>;
      return {
        platform: "linkedin",
        platformMessageId: (msg?.id as string) ?? "",
        platformUserId: sender?.id ?? "",
        username: sender?.id ?? "",
        text: (msg?.text as string) ?? "",
        timestamp: new Date(event.createdAt as number ?? Date.now()).toISOString(),
      };
    }

    if (eventType === "COMMENT") {
      const event = payload.event as Record<string, unknown>;
      if (!event) return null;
      const actor = event.actor as string | undefined;
      return {
        platform: "linkedin",
        postId: (event.object as string) ?? "",
        commentId: (event.id as string) ?? "",
        userId: actor ?? "",
        username: actor ?? "",
        text: (event.message as Record<string, string>)?.text ?? "",
        timestamp: new Date(event.createdAt as number ?? Date.now()).toISOString(),
      };
    }

    return null;
  }
}

/** Generic adapter for platforms that use polling (Reddit, YouTube, etc.). */
export class GenericPollAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  private _poll: (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]>;

  constructor(platform: SocialPlatform, pollFn: (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]>) {
    this.platform = platform;
    this._poll = pollFn;
  }

  parseWebhook(): null {
    return null; // Polling-only adapter
  }

  async poll(since: string): Promise<(IncomingSocialMessage | IncomingComment)[]> {
    return this._poll(since);
  }
}
