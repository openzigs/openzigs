import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
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

  constructor(opts: SocialIngestionOptions) {
    super();
    this.repository = opts.repository;
    for (const adapter of opts.adapters ?? []) {
      this.adapters.set(adapter.platform, adapter);
    }
  }

  /** Register a platform adapter at runtime (e.g., after config loads). */
  registerAdapter(adapter: SocialPlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  /** Handle a raw webhook payload — delegates to the platform adapter. */
  handleWebhook(platform: SocialPlatform, body: unknown, headers: Record<string, string>): void {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      logger.warn(`[SocialIngestion] No adapter registered for platform: ${platform}`);
      return;
    }

    try {
      const parsed = adapter.parseWebhook(body, headers);
      if (!parsed) return;

      if ("commentId" in parsed) {
        this.emit("comment", parsed as IncomingComment);
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
            this.emit("comment", item);
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
      const value = changes.value as Record<string, string>;
      if (!value) return null;
      return {
        platform: "instagram",
        postId: value.media_id ?? "",
        commentId: value.id ?? "",
        userId: value.from?.toString() ?? "",
        username: value.from?.toString() ?? "",
        text: value.text ?? "",
        timestamp: new Date().toISOString(),
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
