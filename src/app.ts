import express from "express";
import helmet from "helmet";
import cors from "cors";
import { getHealth } from "./health.js";
import { createAuthMiddleware, checkRole } from "./auth/auth.js";
import type { AppConfig } from "./config/index.js";
import {
  AuditLogger,
  AUDIT_CATEGORIES,
  AUDIT_LEVELS,
  type AuditCategory,
  type AuditLevel
} from "./logging/audit-logger.js";
import {
  ApprovalQueue,
  type ApprovalChannel,
  type ApprovalStatus
} from "./approvals/index.js";
import type { ToolRegistry } from "./mcp/tool-registry.js";

type CreateAppOptions = {
  auditLogger?: AuditLogger;
  approvalQueue?: ApprovalQueue;
  toolRegistry?: ToolRegistry;
};

const isAuditCategory = (value: string): value is AuditCategory => {
  return AUDIT_CATEGORIES.includes(value as AuditCategory);
};

const isAuditLevel = (value: string): value is AuditLevel => {
  return AUDIT_LEVELS.includes(value as AuditLevel);
};

const isApprovalStatus = (value: string): value is ApprovalStatus => {
  return value === "pending" || value === "approved" || value === "rejected" || value === "expired";
};

const isApprovalChannel = (value: string): value is ApprovalChannel => {
  return value === "web" || value === "telegram" || value === "discord";
};

const parseDate = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

export const createApp = (config: AppConfig, options: CreateAppOptions = {}) => {
  const app = express();
  const auditLogger = options.auditLogger ?? new AuditLogger();
  const approvalQueue = options.approvalQueue ?? new ApprovalQueue({ auditLogger });
  const toolRegistry = options.toolRegistry;

  app.set("trust proxy", true);

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  const authMiddleware = createAuthMiddleware(config.auth);

  app.get("/health", (_req, res) => {
    res.status(200).json(getHealth());
  });

  app.get("/api/health", authMiddleware, (_req, res) => {
    res.status(200).json(getHealth());
  });

  app.post("/api/tools/:name/toggle", authMiddleware, checkRole("admin"), async (req, res) => {
    if (!toolRegistry) {
      return res.status(503).json({ error: "Tool registry not configured" });
    }
    const { name } = req.params;
    const enabled = (req.body as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Invalid enabled flag" });
    }

    try {
      await toolRegistry.setEnabled(name, enabled);
      return res.status(200).json({ ok: true, tool: name, enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  app.get("/api/tools", authMiddleware, checkRole("operator"), (_req, res) => {
    if (!toolRegistry) {
      return res.status(503).json({ error: "Tool registry not configured" });
    }
    return res.status(200).json({ tools: toolRegistry.getAllTools() });
  });

  app.get("/api/approvals", authMiddleware, checkRole("operator"), (req, res) => {
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusRaw && statusRaw !== "all" && !isApprovalStatus(statusRaw)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const approvals = approvalQueue.list({ status: statusRaw === "all" ? "all" : statusRaw });
    return res.status(200).json({ approvals });
  });

  app.post("/api/approvals/:id/decision", authMiddleware, checkRole("operator"), (req, res) => {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const approved = body.approved;
    const decidedBy = typeof body.decidedBy === "string" ? body.decidedBy : undefined;
    const decidedViaRaw = typeof body.decidedVia === "string" ? body.decidedVia : "web";

    if (typeof approved !== "boolean") {
      return res.status(400).json({ error: "Invalid approved flag" });
    }
    if (!isApprovalChannel(decidedViaRaw)) {
      return res.status(400).json({ error: "Invalid decidedVia" });
    }

    const existing = approvalQueue.get(id);
    if (!existing) {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (existing.status !== "pending") {
      return res.status(409).json({ error: "Approval already decided" });
    }

    approvalQueue.handleDecision(id, { approved, decidedBy, decidedVia: decidedViaRaw });
    const updated = approvalQueue.get(id);
    return res.status(200).json({ approval: updated });
  });

  app.get("/api/logs", authMiddleware, async (req, res) => {
    const categoryRaw = typeof req.query.category === "string" ? req.query.category : undefined;
    const levelRaw = typeof req.query.level === "string" ? req.query.level : undefined;
    const sinceRaw = typeof req.query.since === "string" ? req.query.since : undefined;
    const untilRaw = typeof req.query.until === "string" ? req.query.until : undefined;
    const limitRaw = typeof req.query.limit === "string" ? req.query.limit : undefined;

    if (categoryRaw && !isAuditCategory(categoryRaw)) {
      return res.status(400).json({ error: "Invalid category" });
    }
    if (levelRaw && !isAuditLevel(levelRaw)) {
      return res.status(400).json({ error: "Invalid level" });
    }

    const since = parseDate(sinceRaw);
    if (since === null) {
      return res.status(400).json({ error: "Invalid since timestamp" });
    }
    const until = parseDate(untilRaw);
    if (until === null) {
      return res.status(400).json({ error: "Invalid until timestamp" });
    }

    const limit = limitRaw ? Number(limitRaw) : 100;
    const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100;

    const entries = await auditLogger.query({
      category: categoryRaw,
      level: levelRaw,
      since: since ?? undefined,
      until: until ?? undefined,
      limit: boundedLimit
    });

    return res.status(200).json({ entries });
  });

  return app;
};
