import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type { PostContextService } from "./platform-api-client.js";
import type {
  IncomingSocialMessage,
  IncomingComment,
  SocialPlatform,
} from "./types.js";

/** Platform adapter interface — each platform implements this. */
export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  /** Parse an inbound webhook payload into a normalised message (or null if not applicable). */
  parseWebhook(
    body: unknown,
    headers: Record<string, string>,
  ): IncomingSocialMessage | IncomingComment | null;
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
export interface PollHealth {
  consecutiveErrors: number;
  lastSuccess: string | null;
  lastError: string | null;
  backoffUntil: string | null;
  totalPolls: number;
}

export class SocialIngestionService extends EventEmitter {
  private repository: SocialRepository;
  private adapters = new Map<SocialPlatform, SocialPlatformAdapter>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private pollHealth = new Map<string, PollHealth>();
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
  async handleWebhook(
    platform: SocialPlatform,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<void> {
    logger.info(`[SocialIngestion] Webhook received for ${platform}`);
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      logger.warn(
        `[SocialIngestion] No adapter registered for platform: ${platform}`,
      );
      this.pushWebhookLog(platform, false, "no_adapter");
      return;
    }

    try {
      const parsed = adapter.parseWebhook(body, headers);
      if (!parsed) {
        this.pushWebhookLog(platform, false, "unparseable");
        return;
      }

      if ("commentId" in parsed) {
        const comment = parsed as IncomingComment;
        this.pushWebhookLog(platform, true, "comment");
        // Enrich comment with post context (non-blocking on failure)
        if (this.postContextService && comment.postId) {
          try {
            const ctx = await this.postContextService.getPostContext(
              comment.platform,
              comment.postId,
            );
            if (ctx) comment.postContext = ctx;
          } catch (err) {
            const ctxMsg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[SocialIngestion] Post context enrichment failed: ${ctxMsg}`,
            );
          }
        }
        this.processComment(comment);
      } else {
        this.pushWebhookLog(platform, true, "message");
        this.processMessage(parsed as IncomingSocialMessage);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `[SocialIngestion] Webhook parse error (${platform}): ${msg}`,
      );
      this.pushWebhookLog(platform, false, "parse_error");
    }
  }

  /** Push an inbound event into the diagnostics ring buffer. */
  private pushWebhookLog(
    platform: string,
    parsed: boolean,
    type?: string,
    source = "webhook",
  ): void {
    this.webhookLog.push({
      ts: new Date().toISOString(),
      platform,
      parsed,
      type,
      source,
    });
    if (this.webhookLog.length > 50) this.webhookLog.shift();
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

    // Log the inbound message (dedup by platformMessageId)
    const message = this.repository.insertMessage({
      contactId: contact.id,
      platform: msg.platform,
      direction: "inbound",
      status: "received",
      platformMessageId: msg.platformMessageId,
      content: msg.text,
      metadata: msg.metadata,
    });

    if (!message) {
      logger.info(
        `[SocialIngestion] Duplicate message skipped: ${msg.platform}/${msg.platformMessageId}`,
      );
      return;
    }

    // Emit for downstream processing (Brain)
    this.emit("message", { message, contact, raw: msg });
  }

  /** Process a normalised inbound comment: upsert contact, log as message, then emit. */
  processComment(comment: IncomingComment): void {
    // Upsert contact in CRM
    const contact = this.repository.upsertContact({
      platform: comment.platform,
      platformUserId: comment.userId,
      username: comment.username,
    });

    // Log the inbound comment as a message (dedup by commentId as platformMessageId)
    const message = this.repository.insertMessage({
      contactId: contact.id,
      platform: comment.platform,
      direction: "inbound",
      status: "received",
      platformMessageId: comment.commentId,
      content: comment.text,
      metadata: { postId: comment.postId, source: "comment" },
    });

    if (!message) {
      logger.info(
        `[SocialIngestion] Duplicate comment skipped: ${comment.platform}/${comment.commentId}`,
      );
      return;
    }

    this.emit("comment", comment);
  }

  /** Start polling for a platform at the given interval (seconds). */
  startPolling(platform: SocialPlatform, intervalSeconds: number): void {
    const adapter = this.adapters.get(platform);
    if (!adapter?.poll) {
      logger.warn(
        `[SocialIngestion] Adapter for ${platform} does not support polling`,
      );
      return;
    }

    // Stop existing timer if any
    this.stopPolling(platform);

    // Initialize health tracking for this platform
    const health: PollHealth = this.pollHealth.get(platform) ?? {
      consecutiveErrors: 0,
      lastSuccess: null,
      lastError: null,
      backoffUntil: null,
      totalPolls: 0,
    };
    this.pollHealth.set(platform, health);

    // On first poll, look back 24 hours to catch messages received while the
    // server was down.  The repository deduplicates by platformMessageId, so
    // re-ingesting already-seen messages is safe.
    const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
    let lastPoll = new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

    const poll = async () => {
      // Respect backoff window — skip this cycle if we're backing off
      if (health.backoffUntil && new Date() < new Date(health.backoffUntil)) {
        logger.info(
          `[SocialIngestion] ${platform} in backoff until ${health.backoffUntil}, skipping poll`,
        );
        return;
      }

      health.totalPolls++;
      try {
        const items = await adapter.poll!(lastPoll);
        lastPoll = new Date().toISOString();

        // Reset error state on success
        health.consecutiveErrors = 0;
        health.lastSuccess = lastPoll;
        health.backoffUntil = null;

        for (const item of items) {
          if ("commentId" in item) {
            const comment = item as IncomingComment;
            if (this.postContextService && comment.postId) {
              try {
                const ctx = await this.postContextService.getPostContext(
                  comment.platform,
                  comment.postId,
                );
                if (ctx) comment.postContext = ctx;
              } catch {
                /* best-effort enrichment */
              }
            }
            this.pushWebhookLog(platform, true, "comment", "poll");
            this.processComment(comment);
          } else {
            this.pushWebhookLog(platform, true, "message", "poll");
            this.processMessage(item);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[SocialIngestion] Poll error (${platform}): ${msg}`);
        this.pushWebhookLog(platform, false, "poll_error", "poll");

        health.consecutiveErrors++;
        health.lastError = msg;

        // Exponential backoff: 2^(n-1) × interval, capped at the polling interval itself
        const backoffSeconds = Math.min(
          Math.pow(2, health.consecutiveErrors - 1) * intervalSeconds,
          Math.max(intervalSeconds, 600),
        );
        health.backoffUntil = new Date(
          Date.now() + backoffSeconds * 1000,
        ).toISOString();
        logger.warn(
          `[SocialIngestion] ${platform} consecutive error #${health.consecutiveErrors} — backing off for ${backoffSeconds}s`,
        );
      }
    };

    const timer = setInterval(poll, intervalSeconds * 1000);
    this.pollTimers.set(platform, timer);
    logger.info(
      `[SocialIngestion] Started polling ${platform} every ${intervalSeconds}s`,
    );

    // Do an initial poll immediately
    void poll();
  }

  stopPolling(platform: SocialPlatform): void {
    const timer = this.pollTimers.get(platform);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(platform);
      this.pollHealth.delete(platform);
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

  /** Return platforms that currently have active poll timers. */
  getActivePollers(): SocialPlatform[] {
    return [...this.pollTimers.keys()] as SocialPlatform[];
  }

  /** Return poll health for a specific platform (or null if not polling). */
  getPollHealth(platform: SocialPlatform): PollHealth | null {
    return this.pollHealth.get(platform) ?? null;
  }

  /** Return poll health snapshot for all active pollers. */
  getAllPollHealth(): Record<string, PollHealth> {
    const result: Record<string, PollHealth> = {};
    for (const [platform, health] of this.pollHealth) {
      result[platform] = { ...health };
    }
    return result;
  }

  /** Recent inbound events for diagnostics (ring buffer, last 50). */
  private webhookLog: Array<{
    ts: string;
    platform: string;
    parsed: boolean;
    type?: string;
    source?: string;
  }> = [];

  /** Get recent inbound event log. */
  getWebhookLog(): Array<{
    ts: string;
    platform: string;
    parsed: boolean;
    type?: string;
    source?: string;
  }> {
    return [...this.webhookLog];
  }
}

// ── Built-in Platform Adapters ───────────────────────────────────────

/** Twitter/X Account Activity API webhook adapter. */
export class TwitterAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "twitter";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;

    // Direct message events
    const dmEvents = payload.direct_message_events as
      | Array<Record<string, unknown>>
      | undefined;
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
        timestamp: new Date(
          Number(event.created_timestamp ?? Date.now()),
        ).toISOString(),
      };
    }

    // Tweet create events (mentions / replies treated as comments)
    const tweetCreateEvents = payload.tweet_create_events as
      | Array<Record<string, unknown>>
      | undefined;
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

/** LinkedIn webhook adapter (Organization Social Action Notifications). */
export class LinkedInAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "linkedin";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;

    // LinkedIn Organization Social Action Notifications use a batch payload:
    // { type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS", notifications: [...] }
    const payloadType = payload.type as string | undefined;

    if (payloadType === "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS") {
      const notifications = payload.notifications as
        | Array<Record<string, unknown>>
        | undefined;
      if (!notifications?.length) return null;

      // Process the first COMMENT notification (Social Brain handles one at a time)
      for (const notification of notifications) {
        const action = notification.action as string | undefined;
        if (action !== "COMMENT" && action !== "ADMIN_COMMENT") continue;

        const sourcePost = (notification.sourcePost as string) ?? "";
        const generatedActivity =
          (notification.generatedActivity as string) ?? "";
        const lastModifiedAt = notification.lastModifiedAt as
          | number
          | undefined;

        // Extract comment text from decoratedGeneratedActivity if available
        const decorated = notification.decoratedGeneratedActivity as
          | Record<string, unknown>
          | undefined;
        const commentData = decorated?.comment as
          | Record<string, unknown>
          | undefined;
        const commentText =
          (commentData?.text as string) ??
          (commentData?.message as string) ??
          "";
        const commentOwner = (commentData?.owner as string) ?? "";

        if (!generatedActivity || !sourcePost) continue;

        return {
          platform: "linkedin",
          postId: sourcePost,
          commentId: generatedActivity,
          userId: commentOwner,
          username: commentOwner,
          text: commentText,
          timestamp: new Date(lastModifiedAt ?? Date.now()).toISOString(),
        };
      }
    }

    // Legacy format fallback: eventType-based payload
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
        timestamp: new Date(
          (event.createdAt as number) ?? Date.now(),
        ).toISOString(),
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
        timestamp: new Date(
          (event.createdAt as number) ?? Date.now(),
        ).toISOString(),
      };
    }

    return null;
  }
}

/** Generic adapter for platforms that use polling (Reddit, YouTube, etc.). */
export class GenericPollAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  private _poll: (
    since: string,
  ) => Promise<(IncomingSocialMessage | IncomingComment)[]>;

  constructor(
    platform: SocialPlatform,
    pollFn: (
      since: string,
    ) => Promise<(IncomingSocialMessage | IncomingComment)[]>,
  ) {
    this.platform = platform;
    this._poll = pollFn;
  }

  parseWebhook(): null {
    return null; // Polling-only adapter
  }

  async poll(
    since: string,
  ): Promise<(IncomingSocialMessage | IncomingComment)[]> {
    return this._poll(since);
  }
}

// ── Instagram Webhook Adapter ────────────────────────────────────────

/** Instagram webhook adapter for DMs and comments via Meta Graph API. */
export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "instagram";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;
    const entry = (payload.entry as Array<Record<string, unknown>>)?.[0];
    if (!entry) return null;

    // Instagram messaging webhook (DMs)
    const messaging = entry.messaging as
      | Array<Record<string, unknown>>
      | undefined;
    if (messaging?.length) {
      const event = messaging[0];
      const sender = event.sender as Record<string, string> | undefined;
      const message = event.message as Record<string, string> | undefined;
      if (sender?.id && message?.text) {
        return {
          platform: "instagram",
          platformMessageId: message.mid ?? `ig_msg_${Date.now()}`,
          platformUserId: sender.id,
          username: sender.id,
          text: message.text,
          timestamp: new Date(
            Number(event.timestamp ?? Date.now()),
          ).toISOString(),
        };
      }
    }

    // Instagram comment webhook (changes array with field="comments")
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (changes?.length) {
      for (const change of changes) {
        if (change.field !== "comments") continue;
        const value = change.value as Record<string, unknown> | undefined;
        if (!value) continue;
        const commentId = value.id as string | undefined;
        const text = value.text as string | undefined;
        const from = value.from as Record<string, string> | undefined;
        const mediaId = value.media as Record<string, string> | undefined;
        if (commentId && text && from?.id) {
          return {
            platform: "instagram",
            postId: mediaId?.id ?? (entry.id as string) ?? "",
            commentId,
            userId: from.id,
            username: from.username ?? from.id,
            text,
            timestamp: new Date().toISOString(),
          };
        }
      }
    }

    return null;
  }
}

// ── Facebook Webhook Adapter ─────────────────────────────────────────

/** Facebook webhook adapter for Messenger DMs and Page post comments. */
export class FacebookAdapter implements SocialPlatformAdapter {
  readonly platform: SocialPlatform = "facebook";

  parseWebhook(body: unknown): IncomingSocialMessage | IncomingComment | null {
    const payload = body as Record<string, unknown>;
    const entry = (payload.entry as Array<Record<string, unknown>>)?.[0];
    if (!entry) return null;

    // Facebook Messenger webhook (messaging array)
    const messaging = entry.messaging as
      | Array<Record<string, unknown>>
      | undefined;
    if (messaging?.length) {
      const event = messaging[0];
      const sender = event.sender as Record<string, string> | undefined;
      const message = event.message as Record<string, string> | undefined;
      if (sender?.id && message?.text) {
        return {
          platform: "facebook",
          platformMessageId: message.mid ?? `fb_msg_${Date.now()}`,
          platformUserId: sender.id,
          username: sender.id,
          text: message.text,
          timestamp: new Date(
            Number(event.timestamp ?? Date.now()),
          ).toISOString(),
        };
      }
    }

    // Facebook Page comment webhook (changes array with field="feed")
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (changes?.length) {
      for (const change of changes) {
        if (change.field !== "feed") continue;
        const value = change.value as Record<string, unknown> | undefined;
        if (!value || value.item !== "comment") continue;
        const commentId = value.comment_id as string | undefined;
        const postId = value.post_id as string | undefined;
        const senderId = value.sender_id as string | undefined;
        const senderName = value.sender_name as string | undefined;
        const message = value.message as string | undefined;
        if (commentId && postId && senderId && message) {
          return {
            platform: "facebook",
            postId,
            commentId,
            userId: senderId,
            username: senderName ?? senderId,
            text: message,
            timestamp: new Date(
              Number(value.created_time ?? Date.now()) * 1000,
            ).toISOString(),
          };
        }
      }
    }

    return null;
  }
}
