/**
 * Lead Capture — extracts email addresses and phone numbers from
 * DM conversations and stores them in the CRM (like ManyChat's lead capture).
 */

import { EventEmitter } from "node:events";
import { logger } from "../../logging/logger.js";
import type { SocialRepository } from "./social-repository.js";
import type { SocialPlatform } from "./types.js";

/** Matches common email patterns. */
const EMAIL_RE =
  /\b[A-Za-z0-9._%+!#$&'*/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+\b/;

/** Matches common phone number patterns (international and US). */
const PHONE_RE =
  /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;

export type LeadCaptureOptions = {
  repository: SocialRepository;
  /** Auto-tag contacts when lead data is captured. */
  autoTag?: string;
};

/**
 * Processes inbound messages to detect and capture lead information.
 *
 * Emits:
 * - "lead_captured" — { contactId, email?, phone?, platform }
 */
export class LeadCaptureService extends EventEmitter {
  private repository: SocialRepository;
  private autoTag: string;

  constructor(opts: LeadCaptureOptions) {
    super();
    this.repository = opts.repository;
    this.autoTag = opts.autoTag ?? "lead";
  }

  /**
   * Scan a message for lead data and update the contact if found.
   * Returns true if any new lead data was captured.
   */
  extract(contactId: string, text: string, platform: SocialPlatform): boolean {
    const emailMatch = EMAIL_RE.exec(text);
    const phoneMatch = PHONE_RE.exec(text);

    if (!emailMatch && !phoneMatch) return false;

    const email = emailMatch?.[0];
    const phone = phoneMatch?.[0];

    // Only update if we're actually capturing new data
    const contact = this.repository.getContact(contactId);
    if (!contact) return false;

    const existingEmail = (contact as Record<string, unknown>).email as
      | string
      | null;
    const existingPhone = (contact as Record<string, unknown>).phone as
      | string
      | null;
    const newEmail = email && !existingEmail ? email : undefined;
    const newPhone = phone && !existingPhone ? phone : undefined;

    if (!newEmail && !newPhone) return false;

    this.repository.updateContactLead(contactId, {
      email: newEmail,
      phone: newPhone,
    });

    if (this.autoTag) {
      this.repository.addTag(contactId, this.autoTag);
    }

    this.emit("lead_captured", {
      contactId,
      email: newEmail,
      phone: newPhone,
      platform,
    });

    logger.info(
      `[LeadCapture] Captured lead for contact ${contactId}: ` +
        `email=${newEmail ?? "none"}, phone=${newPhone ?? "none"}`,
    );

    return true;
  }
}
