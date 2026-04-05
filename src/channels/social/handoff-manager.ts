import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import { SocialRepository } from "./social-repository.js";
import type {
  Contact,
  IncomingSocialMessage,
  EscalationContext,
} from "./types.js";

/** Abstraction over Discord/Telegram thread creation for handoff. */
export interface HandoffChannel {
  readonly type: "discord" | "telegram";
  /** Create a support thread and return its ID. */
  createThread(threadName: string, initialContent: string): Promise<string>;
  /** Post a message to an existing thread. */
  postToThread(threadId: string, message: string): Promise<void>;
  /** Archive / close a thread. */
  archiveThread(threadId: string): Promise<void>;
}

export type HandoffManagerOptions = {
  repository: SocialRepository;
  handoffChannels?: HandoffChannel[];
  preferredChannel?: "discord" | "telegram";
};

export type HandoffSession = {
  contactId: string;
  threadId: string;
  channel: "discord" | "telegram";
  createdAt: Date;
};

/**
 * Manages human-agent handoff by creating private threads in Discord or
 * forum topics in Telegram, forwarding user messages, and routing admin
 * replies back to the user's native platform.
 */
export class HandoffManager extends EventEmitter {
  private repository: SocialRepository;
  private channels = new Map<string, HandoffChannel>();
  private preferredChannel: "discord" | "telegram";
  /** Map of threadId → contactId for reverse lookups when admin replies. */
  private threadToContact = new Map<string, string>();

  constructor(opts: HandoffManagerOptions) {
    super();
    this.repository = opts.repository;
    this.preferredChannel = opts.preferredChannel ?? "discord";
    for (const ch of opts.handoffChannels ?? []) {
      this.channels.set(ch.type, ch);
    }

    // Rebuild reverse map from existing active handoffs
    this.rebuildThreadMap();
  }

  registerChannel(channel: HandoffChannel): void {
    this.channels.set(channel.type, channel);
  }

  /**
   * Escalate a conversation to human review.
   * Creates a support thread and updates the CRM.
   */
  async escalate(
    contact: Contact,
    context: EscalationContext,
    raw: IncomingSocialMessage,
  ): Promise<HandoffSession | null> {
    const channel = this.channels.get(this.preferredChannel);
    if (!channel) {
      logger.warn(
        `[Handoff] No ${this.preferredChannel} channel registered for handoff`,
      );
      return null;
    }

    try {
      const threadName = `Support - ${contact.display_name || contact.username} (${contact.platform})`;

      // Build escalation context message
      const contextLines = [
        `**New Handoff: ${contact.display_name || contact.username}**`,
        "",
        `**Platform:** ${contact.platform}`,
        `**Username:** @${contact.username}`,
        `**Confidence:** ${context.brainConfidence}`,
        `**Intent:** ${context.brainIntent}`,
        `**Tags:** ${JSON.parse(contact.tags).join(", ") || "none"}`,
        `**Messages:** ${contact.message_count} total`,
        `**Trigger:** ${context.triggerReason}`,
        "",
        `**Last message:**`,
        `> ${raw.text}`,
      ];

      if (context.ragChunksUsed.length > 0) {
        contextLines.push("", "**RAG Context Used:**");
        for (const chunk of context.ragChunksUsed.slice(0, 3)) {
          contextLines.push(`> ${chunk.slice(0, 200)}...`);
        }
      }

      const threadId = await channel.createThread(
        threadName,
        contextLines.join("\n"),
      );

      // Update CRM
      this.repository.updateContact(contact.id, {
        handoff_active: 1,
        handoff_thread_id: threadId,
        handoff_channel: channel.type,
      });
      this.repository.addTag(contact.id, "handoff-active");

      // Track for reverse lookups
      this.threadToContact.set(threadId, contact.id);

      const session: HandoffSession = {
        contactId: contact.id,
        threadId,
        channel: channel.type,
        createdAt: new Date(),
      };

      this.emit("escalated", session);
      logger.info(
        `[Handoff] Escalated contact ${contact.id} to ${channel.type} thread ${threadId}`,
      );
      return session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `[Handoff] Failed to escalate contact ${contact.id}: ${msg}`,
      );
      return null;
    }
  }

  /**
   * Forward a new user message to an existing handoff thread.
   */
  async forwardToThread(contact: Contact, message: string): Promise<void> {
    if (
      !contact.handoff_active ||
      !contact.handoff_thread_id ||
      !contact.handoff_channel
    )
      return;

    const channel = this.channels.get(contact.handoff_channel);
    if (!channel) return;

    try {
      const formatted = `**@${contact.username}** (${contact.platform}):\n> ${message}`;
      await channel.postToThread(contact.handoff_thread_id, formatted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Handoff] Forward to thread failed: ${msg}`);
    }
  }

  /**
   * Handle an admin reply in a handoff thread.
   * Returns the contact if found (caller dispatches to platform).
   */
  handleAdminReply(
    threadId: string,
    adminMessage: string,
  ): { contactId: string; message: string } | null {
    const contactId = this.threadToContact.get(threadId);
    if (!contactId) return null;

    const contact = this.repository.getContact(contactId);
    if (!contact || !contact.handoff_active) return null;

    // Log the outbound message
    this.repository.insertMessage({
      contactId,
      platform: contact.platform,
      direction: "outbound",
      status: "auto_replied", // admin-authored
      content: adminMessage,
      metadata: { via: "handoff" },
    });

    this.emit("admin_reply", { contactId, contact, message: adminMessage });
    return { contactId, message: adminMessage };
  }

  /**
   * Close an active handoff session.
   */
  async closeHandoff(contactId: string, resolution?: string): Promise<boolean> {
    const contact = this.repository.getContact(contactId);
    if (!contact || !contact.handoff_active) return false;

    // Archive the thread
    if (contact.handoff_thread_id && contact.handoff_channel) {
      const channel = this.channels.get(contact.handoff_channel);
      if (channel) {
        try {
          await channel.archiveThread(contact.handoff_thread_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Handoff] Thread archive failed: ${msg}`);
        }
      }
      this.threadToContact.delete(contact.handoff_thread_id);
    }

    // Update CRM
    this.repository.updateContact(contactId, {
      handoff_active: 0,
      handoff_thread_id: null,
      handoff_channel: null,
    });
    this.repository.removeTag(contactId, "handoff-active");
    this.repository.addTag(
      contactId,
      `handoff-resolved-${new Date().toISOString().split("T")[0]}`,
    );

    if (resolution) {
      const existing = contact.notes;
      const updated = existing
        ? `${existing}\n\n[Handoff resolved ${new Date().toISOString()}]: ${resolution}`
        : `[Handoff resolved ${new Date().toISOString()}]: ${resolution}`;
      this.repository.updateContact(contactId, { notes: updated });
    }

    this.emit("resolved", { contactId, resolution });
    logger.info(`[Handoff] Closed handoff for contact ${contactId}`);
    return true;
  }

  /** Look up contact by thread ID (for admin reply routing). */
  getContactByThread(threadId: string): string | undefined {
    return this.threadToContact.get(threadId);
  }

  private rebuildThreadMap(): void {
    // Query all contacts with active handoffs to rebuild the thread→contact map
    const result = this.repository.listContacts({
      handoffActive: true,
      pageSize: 1000,
    });
    for (const contact of result.data) {
      if (contact.handoff_thread_id) {
        this.threadToContact.set(contact.handoff_thread_id, contact.id);
      }
    }
  }
}
