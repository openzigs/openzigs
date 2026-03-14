import { Router } from "express";
import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OutboxRepository, OutboxPlatform, OutboxAssetType } from "../outbox/outbox-repository.js";

// ── Validation schemas ──────────────────────────────────────

const VALID_PLATFORMS = ["twitter", "pinterest", "linkedin", "facebook", "youtube", "reddit", "instagram"] as const;
const VALID_ASSET_TYPES = ["image", "video", "audio", "document", "text"] as const;

const attachmentSchema = z.object({
  filePath: z.string(),
  filename: z.string(),
  assetType: z.enum(VALID_ASSET_TYPES).optional(),
});

const createOutboxSchema = z.object({
  title: z.string().nullable().optional(),
  asset_id: z.string().nullable().optional(),
  asset_url: z.string().nullable().optional(),
  asset_type: z.enum(VALID_ASSET_TYPES).optional().default("text"),
  content_body: z.string().nullable().optional(),
  attachments: z.array(attachmentSchema).optional().default([]),
  platform: z.enum(VALID_PLATFORMS),
  scheduled_time: z.string().refine((v) => !isNaN(Date.parse(v)), "Invalid ISO 8601 timestamp"),
  agent_context: z.string().min(1, "Agent context is required"),
  platform_metadata: z.record(z.unknown()).optional().default({}),
  max_retries: z.number().min(0).max(10).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(["pending", "processing", "published", "failed", "canceled"]).optional(),
  platform: z.enum(VALID_PLATFORMS).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ── Router factory ──────────────────────────────────────────

export type OutboxRouterOptions = {
  outboxRepo: OutboxRepository;
};

export const createOutboxRouter = ({ outboxRepo }: OutboxRouterOptions): Router => {
  const router = Router();

  // GET /api/admin/outbox — List outbox items with optional filters
  router.get("/", (req, res) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
      }
      const items = outboxRepo.list(parsed.data);
      return res.json({ items, total: items.length });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/stats — Counts grouped by status
  router.get("/stats", (_req, res) => {
    try {
      const stats = outboxRepo.getStats();
      return res.json(stats);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/browse — Browse local files for attachment selection
  router.get("/browse", async (req, res) => {
    try {
      const dirParam = typeof req.query.dir === "string" ? req.query.dir : os.homedir();
      const resolved = path.resolve(dirParam);

      // Security: only allow paths under the user's home directory
      const home = os.homedir();
      if (!resolved.startsWith(home)) {
        return res.status(403).json({ error: "Access denied: path must be under home directory" });
      }

      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return res.json({ dir: resolved, parent: path.dirname(resolved), items });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // GET /api/admin/outbox/:id — Single item detail
  router.get("/:id", (req, res) => {
    try {
      const item = outboxRepo.getById(req.params.id);
      if (!item) return res.status(404).json({ error: "Not found" });
      return res.json(item);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox — Create a new outbox item
  router.post("/", (req, res) => {
    try {
      const parsed = createOutboxSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
      }
      const data = parsed.data;
      const item = outboxRepo.insert({
        title: data.title ?? null,
        assetId: data.asset_id ?? null,
        assetUrl: data.asset_url ?? null,
        assetType: data.asset_type as OutboxAssetType,
        contentBody: data.content_body ?? null,
        attachments: data.attachments,
        platform: data.platform as OutboxPlatform,
        scheduledTime: new Date(data.scheduled_time),
        agentContext: data.agent_context,
        platformMetadata: data.platform_metadata,
        maxRetries: data.max_retries,
      });
      return res.status(201).json(item);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/:id/retry — Retry a failed item
  router.post("/:id/retry", (req, res) => {
    try {
      const item = outboxRepo.retry(req.params.id);
      if (!item) return res.status(400).json({ error: "Cannot retry: item not found or not in failed status" });
      return res.json(item);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // POST /api/admin/outbox/:id/cancel — Cancel a pending or failed item
  router.post("/:id/cancel", (req, res) => {
    try {
      const item = outboxRepo.cancel(req.params.id);
      if (!item) return res.status(400).json({ error: "Cannot cancel: item not found or not in pending/failed status" });
      return res.json(item);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // DELETE /api/admin/outbox/:id — Delete an item
  router.delete("/:id", (req, res) => {
    try {
      const deleted = outboxRepo.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Not found" });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  return router;
};
