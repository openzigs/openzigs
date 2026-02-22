/**
 * Social Brain API routes.
 *
 * Mounted at /api/social — provides endpoints for the Social Brain CRM,
 * automation rules, activity log, connections, stats, and handoff management.
 */

import { Router } from "express";
import { z } from "zod";
import { logger } from "../logging/logger.js";
import type { SocialRepository } from "../channels/social/social-repository.js";
import type { SocialIngestionService } from "../channels/social/social-ingestion.js";
import type { SocialBrain } from "../channels/social/social-brain.js";
import type { HandoffManager } from "../channels/social/handoff-manager.js";
import type { CommentRuleEngine } from "../channels/social/comment-rule-engine.js";
import type { SocialPlatform } from "../channels/social/types.js";
import type { SocialBrainAppConfig } from "../config/index.js";

export type SocialRouterOptions = {
  repository: SocialRepository;
  ingestion: SocialIngestionService;
  brain: SocialBrain;
  handoff: HandoffManager;
  ruleEngine: CommentRuleEngine;
  config?: SocialBrainAppConfig;
};

const platformSchema = z.enum(["instagram", "reddit", "youtube", "tiktok", "twitter", "facebook", "linkedin"]);

export const createSocialRouter = (opts: SocialRouterOptions): Router => {
  const { repository, ingestion, handoff, config: socialConfig } = opts;
  const router = Router();

  /** Build connection info with real credential status. */
  const getConnectionStatus = () => {
    const platforms: SocialPlatform[] = ["instagram", "twitter", "facebook", "linkedin", "reddit", "youtube", "tiktok"];
    const registered = new Set(ingestion.getRegisteredPlatforms());
    return platforms.map((p) => {
      const conn = socialConfig?.connections?.[p];
      const hasToken = !!(conn?.accessToken || (p === "instagram" && process.env.INSTAGRAM_ACCESS_TOKEN));
      return {
        platform: p,
        connected: registered.has(p) && hasToken,
        configured: hasToken,
        enabled: conn?.enabled ?? false,
        mode: conn?.mode ?? "webhook",
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

      const result = repository.listContacts({
        platform: platform as SocialPlatform | undefined,
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
  router.patch("/contacts/:id", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const contact = repository.getContact(req.params.id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (typeof body.tags === "string") updates.tags = body.tags;
    if (typeof body.notes === "string") updates.notes = body.notes;

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
    dm_template: z.string().min(1),
    dm_delay_seconds: z.number().int().min(0).max(3600).default(0),
    max_triggers_per_user: z.number().int().min(1).max(100).default(1),
    max_triggers_total: z.number().int().min(1).nullable().default(null),
    auto_tag: z.string().nullable().default(null),
  });

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
  router.patch("/rules/:id", (req, res) => {
    const rule = repository.getRule(req.params.id);
    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    try {
      const updated = repository.updateRule(req.params.id, req.body as Record<string, unknown>);
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

  // ── GET /rules/log — Automation execution log ──
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
      res.status(200).send(challenge);
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
      res.status(500).json({ error: msg });
    }
  });

  // ── Connections — list platform connection status ──
  router.get("/connections", (_req, res) => {
    res.json({ connections: getConnectionStatus() });
  });

  // ── Config — platform setup requirements ──
  router.get("/config", (_req, res) => {
    const platformInfo: Record<string, { envVar: string; webhookPath: string; docsUrl: string }> = {
      instagram: {
        envVar: "INSTAGRAM_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/instagram",
        docsUrl: "https://developers.facebook.com/docs/instagram-platform/webhooks",
      },
      twitter: {
        envVar: "TWITTER_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/twitter",
        docsUrl: "https://developer.x.com/en/docs/x-api",
      },
      facebook: {
        envVar: "FACEBOOK_ACCESS_TOKEN",
        webhookPath: "/api/social/webhooks/facebook",
        docsUrl: "https://developers.facebook.com/docs/graph-api/webhooks",
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

  return router;
};
