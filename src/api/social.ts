/**
 * Social Brain API routes.
 *
 * Mounted at /api/social — provides endpoints for the Social Brain CRM,
 * automation rules, activity log, connections, stats, and handoff management.
 */

import { Router } from "express";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "../logging/logger.js";
import type { SocialRepository } from "../channels/social/social-repository.js";
import type { SocialIngestionService } from "../channels/social/social-ingestion.js";
import type { SocialBrain } from "../channels/social/social-brain.js";
import type { HandoffManager } from "../channels/social/handoff-manager.js";
import type { CommentRuleEngine } from "../channels/social/comment-rule-engine.js";
import type { SocialPlatform, SocialMessage } from "../channels/social/types.js";
import type { SocialBrainAppConfig } from "../config/index.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import { getUserSelectedModel } from "../config/user-model.js";
import type { VoiceLearningService } from "../channels/social/voice-learning.js";
import type { DmDispatcher } from "../channels/social/dm-dispatcher.js";

export type SocialRouterOptions = {
  repository: SocialRepository;
  ingestion: SocialIngestionService;
  brain: SocialBrain;
  handoff: HandoffManager;
  ruleEngine: CommentRuleEngine;
  config?: SocialBrainAppConfig;
  brandVoiceService?: BrandVoiceService;
  copilot?: CopilotWrapper;
  dmDispatcher?: DmDispatcher;
};

const platformSchema = z.enum(["reddit", "youtube", "tiktok", "twitter", "linkedin", "instagram", "facebook"]);

/** Record an approved reply as a voice example (fire-and-forget). */
async function recordVoiceExample(
  voiceLearning: VoiceLearningService,
  repository: SocialRepository,
  message: SocialMessage,
  wasEdited: boolean,
): Promise<void> {
  try {
    const meta = JSON.parse(message.metadata) as Record<string, unknown>;
    const originalMessage = (meta.originalMessage as string) ?? "";
    if (!originalMessage) return; // no context to learn from

    const contact = repository.getContact(message.contact_id);
    await voiceLearning.recordApprovedReply({
      messageId: message.id,
      platform: message.platform,
      username: contact?.username ?? "unknown",
      originalMessage,
      approvedReply: message.content,
      wasEdited,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[VoiceLearning] Failed to record voice example: ${msg}`);
  }
}

/**
 * Dispatch an approved reply to the originating platform via MCP.
 * Reads metadata.source to decide: DM dispatch vs. comment reply.
 */
async function dispatchApprovedReply(
  dispatcher: DmDispatcher | undefined,
  repository: SocialRepository,
  message: SocialMessage,
): Promise<void> {
  if (!dispatcher) {
    logger.warn("[SocialDispatch] No DmDispatcher available — reply approved but not sent to platform");
    return;
  }
  try {
    const meta = JSON.parse(message.metadata) as Record<string, unknown>;
    const source = meta.source as string | undefined;

    if (source === "brain_comment") {
      // Comment reply — need commentId (stored as the original inbound platformMessageId or in meta)
      const commentId = (meta.commentId as string) ?? "";
      const postId = (meta.postId as string) ?? undefined;
      if (!commentId) {
        logger.warn(`[SocialDispatch] Cannot reply to comment — missing commentId in metadata for message ${message.id}`);
        return;
      }
      const replier = dispatcher.createCommentReplier();
      await replier(message.platform, commentId, message.content, postId);
      logger.info(`[SocialDispatch] Sent comment reply to ${message.platform} comment ${commentId}`);
    } else {
      // DM reply — need contact's platform_user_id
      const contact = repository.getContact(message.contact_id);
      if (!contact?.platform_user_id) {
        logger.warn(`[SocialDispatch] Cannot send DM — no platform_user_id for contact ${message.contact_id}`);
        return;
      }
      const sender = dispatcher.createDmSender();
      await sender(message.platform, contact.platform_user_id, message.content);
      logger.info(`[SocialDispatch] Sent DM reply to ${message.platform} user ${contact.platform_user_id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[SocialDispatch] Failed to send approved reply ${message.id}: ${msg}`);
  }
}

/** Exported for use in server.ts Telegram approval callback. */
export { dispatchApprovedReply };

export const createSocialRouter = (opts: SocialRouterOptions): Router => {
  const { repository, ingestion, brain, handoff, config: socialConfig, brandVoiceService, dmDispatcher } = opts;
  const router = Router();
  const voiceLearning = brain.getVoiceLearning();

  /** Build connection info with real credential status. */
  const getConnectionStatus = () => {
    const platforms: SocialPlatform[] = ["twitter", "linkedin", "reddit", "youtube", "tiktok", "instagram", "facebook"];
    const registered = new Set(ingestion.getRegisteredPlatforms());
    const activePollers = new Set(ingestion.getActivePollers());
    const allHealth = ingestion.getAllPollHealth();
    // Map platform → env var so we can check real process.env directly
    const envVarMap: Record<SocialPlatform, string[]> = {
      twitter: ["TWITTER_BEARER_TOKEN"],
      linkedin: ["LINKEDIN_ACCESS_TOKEN"],
      reddit: ["REDDIT_CLIENT_ID"],
      youtube: ["YOUTUBE_API_KEY"],
      tiktok: ["TIKNEURON_MCP_API_KEY"],
      instagram: ["INSTAGRAM_ACCESS_TOKEN"],
      facebook: ["FACEBOOK_PAGE_TOKEN"],
    };
    return platforms.map((p) => {
      const conn = socialConfig?.connections?.[p];
      // Check real env vars directly — config accessToken may contain unresolved templates
      const hasToken = envVarMap[p]?.some((v) => !!process.env[v]) || !!(conn?.accessToken);
      const isRegistered = registered.has(p);
      return {
        platform: p,
        connected: isRegistered && hasToken,
        configured: hasToken,
        enabled: conn?.enabled ?? false,
        mode: conn?.mode ?? "webhook",
        adapterRegistered: isRegistered,
        activelyPolling: activePollers.has(p),
        pollHealth: allHealth[p] ?? null,
      };
    });
  };

  // ── GET /stats — Dashboard statistics ──
  router.get("/stats", (_req, res) => {
    try {
      const stats = repository.getStats();
      const connections = getConnectionStatus();
      res.json({ ...stats, connections });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /contacts — Paginated CRM contact list ──
  router.get("/contacts", (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
      const platform = req.query.platform ? String(req.query.platform) : undefined;
      const search = req.query.search ? String(req.query.search) : undefined;
      const tag = req.query.tag ? String(req.query.tag) : undefined;
      const handoffActive = req.query.handoffActive === "true" ? true : req.query.handoffActive === "false" ? false : undefined;

      const platformValidation = platform ? platformSchema.safeParse(platform) : { success: true as const, data: undefined };
      if (!platformValidation.success) {
        res.status(400).json({ error: "Invalid platform provided." });
        return;
      }

      const result = repository.listContacts({
        platform: platformValidation.data,
        search,
        tag,
        handoffActive,
        page,
        pageSize,
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /contacts/export — CSV export ──
  router.get("/contacts/export", (_req, res) => {
    try {
      const csv = repository.exportContactsCsv();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
      res.send(csv);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /contacts/:id — Get single contact ──
  router.get("/contacts/:id", (req, res) => {
    const contact = repository.getContact(req.params.id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(contact);
  });

  // ── PATCH /contacts/:id — Update contact tags/notes ──
  const updateContactSchema = z.object({
    tags: z.string().optional(),
    notes: z.string().optional(),
  }).strict();

  router.patch("/contacts/:id", (req, res) => {
    const parsed = updateContactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() });
      return;
    }
    const contact = repository.getContact(req.params.id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;
    if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

    const updated = repository.updateContact(req.params.id, updates);
    res.json(updated);
  });

  // ── POST /contacts/:id/tags — Add a tag ──
  router.post("/contacts/:id/tags", (req, res) => {
    const { tag } = req.body as { tag?: string };
    if (!tag || typeof tag !== "string") {
      res.status(400).json({ error: "Missing tag" });
      return;
    }
    const updated = repository.addTag(req.params.id, tag);
    if (!updated) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(updated);
  });

  // ── DELETE /contacts/:id/tags/:tag — Remove a tag ──
  router.delete("/contacts/:id/tags/:tag", (req, res) => {
    const updated = repository.removeTag(req.params.id, req.params.tag);
    if (!updated) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(updated);
  });

  // ── GET /contacts/:id/messages — Message history ──
  router.get("/contacts/:id/messages", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const messages = repository.getMessages(req.params.id, limit, offset);
    res.json({ messages });
  });

  // ── GET /activity — Recent activity feed ──
  router.get("/activity", (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const messages = repository.getRecentActivity(limit, offset);
      res.json({ messages });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Automation Rules CRUD ──────────────────────────────────────────

  // GET /rules — List all rules
  router.get("/rules", (req, res) => {
    try {
      const platform = req.query.platform ? String(req.query.platform) as SocialPlatform : undefined;
      const rules = repository.listRules(platform);
      res.json({ rules });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // POST /rules — Create a rule
  const createRuleSchema = z.object({
    name: z.string().min(1).max(100),
    platform: platformSchema,
    enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => typeof v === "boolean" ? (v ? 1 : 0) : v).default(1),
    post_ids: z.string().nullable().default(null),
    keywords: z.string().default("[]"),
    regex: z.string().nullable().default(null),
    comment_reply_template: z.string().nullable().default(null),
    dm_template: z.string().default(""),
    dm_delay_seconds: z.number().int().min(0).max(3600).default(0),
    max_triggers_per_user: z.number().int().min(1).max(100).default(1),
    max_triggers_total: z.number().int().min(1).nullable().default(null),
    auto_tag: z.string().nullable().default(null),
    model: z.string().max(255).nullable().default(null),
    use_ai_reply: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => typeof v === "boolean" ? (v ? 1 : 0) : v).default(0),
    ai_reply_context: z.string().nullable().default(null),
  }).refine(
    (d) => d.comment_reply_template || d.dm_template || d.use_ai_reply,
    { message: "At least one of comment reply template, DM template, or AI reply must be set" },
  );

  router.post("/rules", (req, res) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() });
      return;
    }
    try {
      const rule = repository.createRule(parsed.data);
      res.status(201).json(rule);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /rules/log — Automation execution log ──
  // (must be registered BEFORE /rules/:id to avoid :id shadowing)
  router.get("/rules/log", (req, res) => {
    try {
      const ruleId = req.query.ruleId ? String(req.query.ruleId) : undefined;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const log = repository.getAutomationLog({ ruleId, limit, offset });
      res.json({ log });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // GET /rules/:id — Get a single rule
  router.get("/rules/:id", (req, res) => {
    const rule = repository.getRule(req.params.id);
    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    res.json(rule);
  });

  // PATCH /rules/:id — Update a rule
  const UpdateRuleSchema = z.object({
    name: z.string().max(255).optional(),
    platform: platformSchema.optional(),
    enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => typeof v === "boolean" ? (v ? 1 : 0) : v).optional(),
    post_ids: z.string().max(10000).optional(),
    keywords: z.string().max(10000).optional(),
    regex: z.string().max(1000).optional(),
    comment_reply_template: z.string().max(5000).optional(),
    dm_template: z.string().max(5000).optional(),
    dm_delay_seconds: z.number().int().min(0).optional(),
    max_triggers_per_user: z.number().int().min(0).optional(),
    max_triggers_total: z.number().int().min(0).optional(),
    auto_tag: z.string().max(255).optional(),
    model: z.string().max(255).nullable().optional(),
    use_ai_reply: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => typeof v === "boolean" ? (v ? 1 : 0) : v).optional(),
    ai_reply_context: z.string().nullable().optional(),
  }).strict();

  router.patch("/rules/:id", (req, res) => {
    const rule = repository.getRule(req.params.id);
    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    const parsed = UpdateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() });
      return;
    }
    try {
      const updated = repository.updateRule(req.params.id, parsed.data as Record<string, unknown>);
      res.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // DELETE /rules/:id — Delete a rule
  router.delete("/rules/:id", (req, res) => {
    const deleted = repository.deleteRule(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    res.json({ success: true });
  });

  // ── Handoff Management ─────────────────────────────────────────────

  // POST /handoff/:contactId/close — Close an active handoff ──
  router.post("/handoff/:contactId/close", async (req, res) => {
    try {
      const { resolution } = req.body as { resolution?: string };
      const closed = await handoff.closeHandoff(req.params.contactId, resolution);
      if (!closed) {
        res.status(404).json({ error: "No active handoff for this contact" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Webhooks — Platform-specific inbound endpoints ────────────────

  // GET /webhooks/:platform — Webhook verification (Meta, etc.)
  router.get("/webhooks/:platform", (req, res) => {
    // Meta webhook verification challenge
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token && challenge && verifyToken && token === verifyToken) {
      logger.info(`[Social] Webhook verification for ${req.params.platform}`);
      res.type("text/plain").status(200).send(String(challenge));
      return;
    }
    res.status(403).send("Forbidden");
  });

  // POST /webhooks/:platform — Inbound webhook payload ──
  router.post("/webhooks/:platform", (req, res) => {
    const platform = req.params.platform as SocialPlatform;
    try {
      void ingestion.handleWebhook(
        platform,
        req.body,
        req.headers as Record<string, string>,
      );
      res.status(200).json({ received: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Social] Webhook error (${platform}): ${msg}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Connections — list platform connection status ──
  router.get("/connections", (_req, res) => {
    res.json({ connections: getConnectionStatus() });
  });

  // ── Webhook event log — recent inbound webhook events for diagnostics ──
  router.get("/webhook-log", (_req, res) => {
    res.json({ events: ingestion.getWebhookLog() });
  });

  // ── Config — platform setup requirements ──
  router.get("/config", (_req, res) => {
    const platformInfo: Record<string, { envVar: string; webhookPath: string; docsUrl: string }> = {
      twitter: {
        envVar: "TWITTER_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/twitter",
        docsUrl: "https://developer.x.com/en/docs/x-api",
      },
      linkedin: {
        envVar: "LINKEDIN_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/linkedin",
        docsUrl: "https://learn.microsoft.com/en-us/linkedin/",
      },
      reddit: {
        envVar: "REDDIT_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/reddit",
        docsUrl: "https://www.reddit.com/dev/api/",
      },
      youtube: {
        envVar: "YOUTUBE_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/youtube",
        docsUrl: "https://developers.google.com/youtube/v3",
      },
      tiktok: {
        envVar: "TIKTOK_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/tiktok",
        docsUrl: "https://developers.tiktok.com/",
      },
      instagram: {
        envVar: "INSTAGRAM_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/instagram",
        docsUrl: "https://developers.facebook.com/docs/instagram-api/",
      },
      facebook: {
        envVar: "FACEBOOK_PAGE_TOKEN",
        webhookPath: "/api/social/webhooks/facebook",
        docsUrl: "https://developers.facebook.com/docs/graph-api/webhooks/",
      },
    };

    const connections = getConnectionStatus();
    const platforms = connections.map((c) => ({
      ...c,
      ...platformInfo[c.platform],
    }));

    res.json({
      enabled: socialConfig?.enabled ?? true,
      confidenceThreshold: socialConfig?.confidenceThreshold ?? "medium",
      webhookVerifyToken: !!process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN,
      platforms,
    });
  });

  // ── PUT /brand-voice — Update the brand voice used by Social Brain ──
  router.put("/brand-voice", (req, res) => {
    try {
      if (!brandVoiceService) {
        res.status(503).json({ error: "Brand voice service not available" });
        return;
      }
      const { brandVoiceId } = req.body as { brandVoiceId?: string | null };
      const block = brandVoiceService.getVoicePromptBlockById(brandVoiceId ?? undefined);
      opts.brain.setBrandVoice(block);
      res.json({ ok: true, brandVoiceId: brandVoiceId ?? null });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[SocialAPI] Failed to update brand voice: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /analytics — Conversation analytics per platform ──
  router.get("/analytics", (req, res) => {
    try {
      const since = req.query.since ? String(req.query.since) : undefined;
      const analytics = repository.getAnalytics(since);
      res.json({ analytics });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /leads — List captured leads ──
  router.get("/leads", (req, res) => {
    try {
      const platform = req.query.platform ? String(req.query.platform) as SocialPlatform : undefined;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const leads = repository.getLeads({ platform, limit, offset });
      res.json({ leads });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Follow-Up Steps CRUD ───────────────────────────────────────────

  // GET /rules/:ruleId/follow-ups — List follow-up steps for a rule
  router.get("/rules/:ruleId/follow-ups", (req, res) => {
    try {
      const steps = repository.getFollowUpSteps(req.params.ruleId);
      res.json({ steps });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // POST /rules/:ruleId/follow-ups — Add a follow-up step
  const createFollowUpSchema = z.object({
    stepOrder: z.number().int().min(0),
    delaySeconds: z.number().int().min(1).max(604800), // max 7 days
    messageTemplate: z.string().min(1).max(5000),
  });

  router.post("/rules/:ruleId/follow-ups", (req, res) => {
    const rule = repository.getRule(req.params.ruleId);
    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    const parsed = createFollowUpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() });
      return;
    }
    try {
      const step = repository.createFollowUpStep(req.params.ruleId, parsed.data);
      res.status(201).json(step);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // DELETE /rules/:ruleId/follow-ups/:stepId — Delete a follow-up step
  router.delete("/rules/:ruleId/follow-ups/:stepId", (req, res) => {
    const deleted = repository.deleteFollowUpStep(req.params.stepId);
    if (!deleted) {
      res.status(404).json({ error: "Follow-up step not found" });
      return;
    }
    res.json({ success: true });
  });

  // ── POST /rules/generate — AI-generate a comment automation rule ──
  router.post("/rules/generate", async (req, res) => {
    if (!opts.copilot) {
      res.status(503).json({ error: "Copilot not available" });
      return;
    }

    const generateSchema = z.object({
      description: z.string().min(1).max(2000),
      platform: platformSchema.optional(),
      model: z.string().max(255).optional(),
    });
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() });
      return;
    }

    const { description, platform: targetPlatform, model: bodyModel } = parsed.data;

    const platformContext: Record<string, string> = {
      twitter: "Twitter/X: Keyword comments trigger DMs via twitter_send_dm. Comment replies via twitter_post_tweet. Max 280 char DMs.",
      instagram: "Instagram: Comment automation within Meta's 24-hour messaging window. DMs via send_dm, replies via reply_to_comment. Supports rich templates with {{username}}, {{keyword}}.",
      facebook: "Facebook: Page comment monitoring. DMs via fb_send_message, comment replies via fb_reply_to_comment. Works within Meta messaging policies.",
      linkedin: "LinkedIn: Professional context. DMs via linkedin_send_message, replies via linkedin_reply_to_comment. Keep tone professional.",
      youtube: "YouTube: Video comment monitoring via polling. Replies via yt_reply_to_comment. No DM capability — use comment replies only.",
      reddit: "Reddit: Subreddit comment monitoring. DMs via reddit_send_message, replies via reddit_reply_to_comment. Follow subreddit rules.",
      tiktok: "TikTok: Limited API — publish-only. No comment reading or DM sending yet. Rules are preparatory.",
    };

    const platformHint = targetPlatform
      ? `Target platform: ${targetPlatform}. ${platformContext[targetPlatform] ?? ""}`
      : "Choose the most appropriate platform based on the description.";

    const prompt = [
      "You are a Social Media Comment Automation expert for the OpenZigs platform.",
      "Generate a JSON object representing a comment automation rule based on the user's description.",
      "",
      "Available template variables: {{username}}, {{keyword}}, {{post_id}}, {{post_caption}}, {{post_url}}, {{comment_text}}",
      "",
      platformHint,
      "",
      "The JSON must have EXACTLY these fields:",
      '- name (string): A concise descriptive rule name',
      '- platform (string): One of twitter, instagram, facebook, linkedin, youtube, reddit, tiktok',
      '- keywords (string[]): Array of trigger keywords/phrases',
      '- dm_template (string): The DM message template with variables',
      '- comment_reply_template (string|null): Optional public comment reply',
      '- dm_delay_seconds (number): Delay before sending DM (0-3600)',
      '- max_triggers_per_user (number): Max times one user triggers this rule (1-100)',
      '- auto_tag (string|null): Tag to auto-apply to the contact',
      '- use_ai_reply (boolean): Whether to use AI-generated contextual replies instead of templates',
      '- ai_reply_context (string|null): Context/instructions for AI when use_ai_reply is true',
      "",
      "Rules for good automation:",
      "- Keywords should be specific enough to avoid false positives",
      "- DM templates should feel personal, not spammy",
      "- Comment replies should be brief and encourage DM conversation",
      "- Use auto_tag for lead categorization (e.g., 'lead', 'interested', 'pricing-inquiry')",
      "- If the user wants AI-powered replies, set use_ai_reply: true and provide detailed ai_reply_context",
      "",
      "Return ONLY valid JSON, no markdown fences, no commentary.",
      "",
      "User's description:",
      description,
    ].join("\n");

    try {
      let response = "";
      const model = bodyModel || (await getUserSelectedModel() ?? "gpt-5-mini");
      for await (const chunk of opts.copilot.chat(prompt, { model, tools: [] })) {
        response += chunk;
      }

      let content = response.trim();
      if (content.startsWith("```")) {
        content = content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }

      const rule = JSON.parse(content) as Record<string, unknown>;

      // Normalize keywords to JSON string if array
      if (Array.isArray(rule.keywords)) {
        rule.keywords = JSON.stringify(rule.keywords);
      }
      // Normalize use_ai_reply to int
      if (typeof rule.use_ai_reply === "boolean") {
        rule.use_ai_reply = rule.use_ai_reply ? 1 : 0;
      }

      res.json({ rule });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[SocialAPI] Rule generation failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /connections/:platform — Toggle platform enabled state / ingestion mode ──
  const toggleSchema = z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["webhook", "polling", "browser"]).optional(),
  }).refine((d) => d.enabled !== undefined || d.mode !== undefined, {
    message: "Request body must include at least one of { enabled, mode }",
  });

  router.patch("/connections/:platform", async (req, res) => {
    const parsed = platformSchema.safeParse(req.params.platform);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid platform" });
      return;
    }
    const body = toggleSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Request body must include { enabled?: boolean, mode?: 'webhook' | 'polling' | 'browser' }" });
      return;
    }
    const platform = parsed.data;
    const { enabled, mode } = body.data;

    try {
      const configPath = process.env.OPENZIGS_CONFIG_PATH
        ?? path.join(os.homedir(), ".openzigs", "config.json");

      // Read existing user config
      let userConfig: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        userConfig = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        if (!(e instanceof Error && "code" in e && (e as { code?: string }).code === "ENOENT")) throw e;
      }

      // Update socialBrain.connections.<platform>
      const sb = (userConfig.socialBrain && typeof userConfig.socialBrain === "object")
        ? (userConfig.socialBrain as Record<string, unknown>) : {};
      const conns = (sb.connections && typeof sb.connections === "object")
        ? (sb.connections as Record<string, unknown>) : {};
      const existing = (conns[platform] && typeof conns[platform] === "object")
        ? (conns[platform] as Record<string, unknown>) : {};
      if (enabled !== undefined) existing.enabled = enabled;
      if (mode !== undefined) existing.mode = mode;
      conns[platform] = existing;
      sb.connections = conns;
      userConfig.socialBrain = sb;

      // Write back with secure perms
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.chmod(configPath, 0o600);

      // Update in-memory config so getConnectionStatus reflects immediately
      if (socialConfig?.connections) {
        if (!socialConfig.connections[platform]) {
          socialConfig.connections[platform] = {};
        }
        if (enabled !== undefined) socialConfig.connections[platform]!.enabled = enabled;
        if (mode !== undefined) socialConfig.connections[platform]!.mode = mode;
      }

      const parts: string[] = [];
      if (enabled !== undefined) parts.push(`${enabled ? "enabled" : "disabled"}`);
      if (mode !== undefined) parts.push(`mode=${mode}`);
      logger.info(`[SocialAPI] Platform ${platform} updated: ${parts.join(", ")}`);
      res.json({ ok: true, platform, enabled, mode, needsRestart: mode !== undefined });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[SocialAPI] Failed to update platform ${platform}: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Approval Queue ─────────────────────────────────────────────────

  /** GET /approvals — List pending approval messages. */
  router.get("/approvals", (_req, res) => {
    try {
      const pending = repository.listPendingApprovals();
      const count = repository.getPendingApprovalCount();
      res.json({ data: pending, count });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /** GET /approvals/count — Just the pending count (for badge). */
  router.get("/approvals/count", (_req, res) => {
    try {
      res.json({ count: repository.getPendingApprovalCount() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /approvals/:id/approve — Approve a pending reply. */
  router.post("/approvals/:id/approve", (req, res) => {
    try {
      const message = repository.approveReply(req.params.id);
      if (!message) {
        res.status(404).json({ error: "Message not found or not pending approval" });
        return;
      }
      // Dispatch to platform and record voice example in background
      void dispatchApprovedReply(dmDispatcher, repository, message);
      void recordVoiceExample(voiceLearning, repository, message, false);
      res.json({ ok: true, message });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /approvals/:id/reject — Reject a pending reply. */
  router.post("/approvals/:id/reject", (req, res) => {
    try {
      const message = repository.rejectReply(req.params.id);
      if (!message) {
        res.status(404).json({ error: "Message not found or not pending approval" });
        return;
      }
      res.json({ ok: true, message });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /approvals/:id/edit — Edit content and approve. */
  router.post("/approvals/:id/edit", (req, res) => {
    try {
      const body = req.body as { content?: string };
      if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
        res.status(400).json({ error: "content is required" });
        return;
      }
      const message = repository.editAndApproveReply(req.params.id, body.content.trim());
      if (!message) {
        res.status(404).json({ error: "Message not found or not pending approval" });
        return;
      }
      // Dispatch to platform and record voice example (edited replies are especially valuable)
      void dispatchApprovedReply(dmDispatcher, repository, message);
      void recordVoiceExample(voiceLearning, repository, message, true);
      res.json({ ok: true, message });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Voice Learning ─────────────────────────────────────────────────

  /** GET /voice-learning/stats — Voice learning example count. */
  router.get("/voice-learning/stats", (_req, res) => {
    res.json({ count: voiceLearning.getExampleCount() });
  });

  // ── Manual Reply ──────────────────────────────────────────────────

  /** POST /contacts/:id/reply — Send a manual reply from the UI. */
  router.post("/contacts/:id/reply", (req, res) => {
    try {
      const contact = repository.getContact(req.params.id);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      const body = req.body as { content?: string };
      if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
        res.status(400).json({ error: "content is required" });
        return;
      }
      const message = repository.insertManualReply({
        contactId: contact.id,
        platform: contact.platform,
        content: body.content.trim(),
      });
      if (!message) {
        res.status(500).json({ error: "Failed to insert reply" });
        return;
      }
      // Dispatch the reply to the platform in the background
      if (dmDispatcher && contact.platform_user_id) {
        void (async () => {
          try {
            const sender = dmDispatcher.createDmSender();
            await sender(contact.platform, contact.platform_user_id!, message.content);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[SocialManualReply] Failed to send manual reply to ${contact.platform}: ${errMsg}`);
          }
        })();
      }
      res.json({ ok: true, message });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Brain Diagnostics ─────────────────────────────────────────────

  /** POST /brain/test — Test the brain pipeline with a sample message. */
  router.post("/brain/test", (req, res) => {
    void (async () => {
      try {
        const body = req.body as { text?: string; platform?: string };
        const text = body.text ?? "Hello, can you tell me about your product?";
        const platform = (body.platform ?? "twitter") as SocialPlatform;
        const result = await brain.processComment({
          platform,
          postId: "test-post",
          commentId: `test-${Date.now()}`,
          userId: "test-user",
          username: "test-user",
          text,
          timestamp: new Date().toISOString(),
        });
        res.json({ ok: true, result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[SocialBrain] Brain test failed: ${msg}`);
        res.status(500).json({ ok: false, error: msg });
      }
    })();
  });

  return router;
};
