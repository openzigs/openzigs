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

type CreateAppOptions = {
  auditLogger?: AuditLogger;
};

const isAuditCategory = (value: string): value is AuditCategory => {
  return AUDIT_CATEGORIES.includes(value as AuditCategory);
};

const isAuditLevel = (value: string): value is AuditLevel => {
  return AUDIT_LEVELS.includes(value as AuditLevel);
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

  app.post("/api/tools/:name/toggle", authMiddleware, checkRole("admin"), (req, res) => {
    res.status(200).json({ ok: true, tool: req.params.name });
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
