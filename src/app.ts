import express, { type Express } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import * as z from "zod";
import { getHealth } from "./health.js";
import { createAuthMiddleware, checkRole } from "./auth/auth.js";
import type { AppConfig } from "./config/index.js";
import {
  AuditLogger,
  AUDIT_CATEGORIES,
  AUDIT_LEVELS,
  type AuditCategory,
  type AuditLevel,
} from "./logging/audit-logger.js";
import {
  ApprovalQueue,
  type ApprovalChannel,
  type ApprovalStatus,
} from "./approvals/index.js";
import type { ToolRegistry } from "./mcp/tool-registry.js";
import type { PromptManager } from "./productivity/prompt-manager.js";
import type { Scheduler } from "./productivity/scheduler.js";
import type { PersonalityManager } from "./personality/personality-manager.js";

type CreateAppOptions = {
  auditLogger?: AuditLogger;
  approvalQueue?: ApprovalQueue;
  toolRegistry?: ToolRegistry;
  promptManager?: PromptManager;
  scheduler?: Scheduler;
  personalityManager?: PersonalityManager;
};

const isAuditCategory = (value: string): value is AuditCategory => {
  return AUDIT_CATEGORIES.includes(value as AuditCategory);
};

const isAuditLevel = (value: string): value is AuditLevel => {
  return AUDIT_LEVELS.includes(value as AuditLevel);
};

const isApprovalStatus = (value: string): value is ApprovalStatus => {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  );
};

const isApprovalChannel = (value: string): value is ApprovalChannel => {
  return value === "web" || value === "telegram" || value === "discord";
};

const toggleToolSchema = z.object({
  enabled: z.boolean(),
});

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

export const createApp = (
  config: AppConfig,
  options: CreateAppOptions = {},
): Express => {
  const app = express();
  const auditLogger = options.auditLogger ?? new AuditLogger();
  const approvalQueue =
    options.approvalQueue ?? new ApprovalQueue({ auditLogger });
  const toolRegistry = options.toolRegistry;

  // Only trust proxy if explicitly configured
  const trustProxy = config.server?.trustProxy;
  if (trustProxy) {
    app.set("trust proxy", trustProxy);
  }

  const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3001";
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: [
            "'self'",
            uiOrigin,
            "http://localhost:3000",
            "http://localhost:9222",
            "ws://localhost:3000",
            "ws://localhost:9222",
          ],
          fontSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }),
  );
  // CORS: restrict to explicit allowed origins
  const corsOrigins = (process.env.OPENZIGS_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const explicitOrigins = new Set([
    uiOrigin,
    "http://localhost:3000",
    "http://localhost:3001",
    ...corsOrigins,
  ]);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (curl, mobile apps, server-to-server)
        if (!origin) return callback(null, true);
        // Allow any localhost origin regardless of port (local dev servers
        // may run on non-default ports like 3101, 5173, etc.)
        try {
          const url = new URL(origin);
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
            return callback(null, true);
          }
        } catch {
          /* not a valid URL, fall through */
        }
        if (explicitOrigins.has(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  // Global rate limit: generous for local use, protects against runaway loops.
  // Authenticated requests are exempt since they've already proven identity.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5000,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later" },
      skip: (req) => req.path === "/health",
      // When trust proxy isn't configured, suppress the X-Forwarded-For
      // validation warning — the header is set by the Next.js dev proxy
      // but isn't security-relevant in local-only deployments.
      ...(!trustProxy && { validate: { xForwardedForHeader: false } }),
    }),
  );

  // /api/queue uses a higher limit (50mb) registered in server.ts for image callbacks.
  // /api/social/webhooks needs a custom parser that captures raw body for HMAC verification.
  // Skip the global 1mb parser for both prefixes so they aren't rejected or double-parsed.
  const skipGlobalParser = (p: string) =>
    p.startsWith("/api/queue") || p.startsWith("/api/social/webhooks");
  app.use((req, res, next) => {
    if (skipGlobalParser(req.path)) return next();
    express.json({ limit: "1mb" })(req, res, next);
  });
  app.use((req, res, next) => {
    if (skipGlobalParser(req.path)) return next();
    express.urlencoded({ extended: true, limit: "1mb" })(req, res, next);
  });

  const authMiddleware = createAuthMiddleware(config.auth);

  const ALLOWED_UPLOAD_MIMES = new Set([
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
    "text/xml",
    "application/json",
    "application/pdf",
    "application/xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "video/mp4",
    "video/webm",
  ]);

  const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 10,
    },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
    },
  });

  const sanitizeUploadName = (name: string): string => {
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
    return sanitized || "upload.bin";
  };

  app.get("/health", (_req, res) => {
    res.status(200).json(getHealth());
  });

  app.get("/api/health", authMiddleware, (_req, res) => {
    res.status(200).json(getHealth());
  });

  /**
   * POST /api/chat/upload
   * Upload browser-selected files to a server-local temp area for chat attachments.
   * Returns SDK attachment descriptors with absolute server paths.
   */
  app.post(
    "/api/chat/upload",
    authMiddleware,
    chatUpload.array("files", 10),
    async (req, res) => {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res
          .status(400)
          .json({
            error: "No files uploaded. Use multipart form field 'files'.",
          });
      }

      try {
        const uploadDir = path.join(
          os.homedir(),
          ".openzigs",
          "uploads",
          "chat",
        );
        await fs.mkdir(uploadDir, { recursive: true });

        const uploaded = await Promise.all(
          files.map(async (file) => {
            const safeName = sanitizeUploadName(
              file.originalname || file.fieldname || "upload.bin",
            );
            const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;
            const savedPath = path.join(uploadDir, uniqueName);
            await fs.writeFile(savedPath, file.buffer);
            return {
              type: "file" as const,
              path: savedPath,
              name: file.originalname || safeName,
            };
          }),
        );

        return res.status(200).json({ files: uploaded });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/tools/:name/toggle",
    authMiddleware,
    checkRole("admin"),
    async (req, res) => {
      if (!toolRegistry) {
        return res.status(503).json({ error: "Tool registry not configured" });
      }
      const { name } = req.params;
      const parsed = toggleToolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid enabled flag" });
      }

      try {
        await toolRegistry.setEnabled(name, parsed.data.enabled);
        return res
          .status(200)
          .json({ ok: true, tool: name, enabled: parsed.data.enabled });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    },
  );

  app.get("/api/tools", authMiddleware, checkRole("operator"), (_req, res) => {
    if (!toolRegistry) {
      return res.status(503).json({ error: "Tool registry not configured" });
    }
    return res.status(200).json({ tools: toolRegistry.getAllTools() });
  });

  app.get(
    "/api/approvals",
    authMiddleware,
    checkRole("operator"),
    (req, res) => {
      const statusRaw =
        typeof req.query.status === "string" ? req.query.status : undefined;
      if (statusRaw && statusRaw !== "all" && !isApprovalStatus(statusRaw)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const approvals = approvalQueue.list({
        status: (statusRaw === "all" ? "all" : statusRaw) as
          | ApprovalStatus
          | "all"
          | undefined,
      });
      return res.status(200).json({ approvals });
    },
  );

  app.post(
    "/api/approvals/:id/decision",
    authMiddleware,
    checkRole("operator"),
    (req, res) => {
      const { id } = req.params;
      const body = req.body as Record<string, unknown>;
      const approved = body.approved;
      const decidedBy =
        typeof body.decidedBy === "string" ? body.decidedBy : undefined;
      const decidedViaRaw =
        typeof body.decidedVia === "string" ? body.decidedVia : "web";

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

      approvalQueue.handleDecision(id, {
        approved,
        decidedBy,
        decidedVia: decidedViaRaw,
      });
      const updated = approvalQueue.get(id);
      return res.status(200).json({ approval: updated });
    },
  );

  app.get("/api/logs", authMiddleware, async (req, res) => {
    const categoryRaw =
      typeof req.query.category === "string" ? req.query.category : undefined;
    const levelRaw =
      typeof req.query.level === "string" ? req.query.level : undefined;
    const sinceRaw =
      typeof req.query.since === "string" ? req.query.since : undefined;
    const untilRaw =
      typeof req.query.until === "string" ? req.query.until : undefined;
    const limitRaw =
      typeof req.query.limit === "string" ? req.query.limit : undefined;

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
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), 1000)
      : 100;

    const entries = await auditLogger.query({
      category: categoryRaw as AuditCategory | undefined,
      level: levelRaw as AuditLevel | undefined,
      since: since ?? undefined,
      until: until ?? undefined,
      limit: boundedLimit,
    });

    return res.status(200).json({ entries });
  });

  // ── Saved Prompts API ──
  const promptManager = options.promptManager;
  if (promptManager) {
    app.get("/api/prompts", authMiddleware, (req, res) => {
      const query =
        typeof req.query.query === "string" ? req.query.query : undefined;
      const prompts = query
        ? promptManager.search(query)
        : promptManager.list();
      return res.status(200).json({ prompts });
    });

    app.get("/api/prompts/:id", authMiddleware, (req, res) => {
      const prompt = promptManager.getById(req.params.id);
      return prompt
        ? res.status(200).json(prompt)
        : res.status(404).json({ error: "Prompt not found" });
    });

    app.post("/api/prompts", authMiddleware, (req, res) => {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : "";
      const template = typeof body.template === "string" ? body.template : "";
      if (!name || !template) {
        return res
          .status(400)
          .json({ error: "name and template are required" });
      }
      const MAX_PROMPT_LENGTH = 100_000;
      if (template.length > MAX_PROMPT_LENGTH) {
        return res
          .status(400)
          .json({
            error: `Prompt template exceeds ${MAX_PROMPT_LENGTH} characters`,
          });
      }
      try {
        const prompt = promptManager.create({
          name,
          template,
          description:
            typeof body.description === "string" ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        });
        return res.status(201).json(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    app.put("/api/prompts/:id", authMiddleware, (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        const updated = promptManager.update(req.params.id, {
          name: typeof body.name === "string" ? body.name : undefined,
          template:
            typeof body.template === "string" ? body.template : undefined,
          description:
            typeof body.description === "string" ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        });
        return res.status(200).json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    app.delete("/api/prompts/:id", authMiddleware, (req, res) => {
      const deleted = promptManager.delete(req.params.id);
      return deleted
        ? res.status(200).json({ ok: true })
        : res.status(404).json({ error: "Prompt not found" });
    });
  }

  // ── Scheduled Jobs API ──
  const scheduler = options.scheduler;
  if (scheduler) {
    app.get("/api/jobs", authMiddleware, (_req, res) => {
      return res.status(200).json({ jobs: scheduler.list() });
    });

    app.get("/api/jobs/:id", authMiddleware, (req, res) => {
      const job = scheduler.getById(req.params.id);
      return job
        ? res.status(200).json(job)
        : res.status(404).json({ error: "Job not found" });
    });

    app.post("/api/jobs", authMiddleware, (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        const job = scheduler.create({
          name: body.name as string,
          cronExpression: body.cronExpression as string,
          timezone:
            typeof body.timezone === "string" ? body.timezone : undefined,
          actionPayload: (body.actionPayload ?? {}) as Record<string, unknown>,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        return res.status(201).json(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    app.patch("/api/jobs/:id", authMiddleware, (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        const updated = scheduler.update(req.params.id, {
          name: typeof body.name === "string" ? body.name : undefined,
          cronExpression:
            typeof body.cronExpression === "string"
              ? body.cronExpression
              : undefined,
          timezone:
            typeof body.timezone === "string" ? body.timezone : undefined,
          actionPayload: body.actionPayload as
            | Record<string, unknown>
            | undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        return res.status(200).json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    app.delete("/api/jobs/:id", authMiddleware, (req, res) => {
      const deleted = scheduler.delete(req.params.id);
      return deleted
        ? res.status(200).json({ ok: true })
        : res.status(404).json({ error: "Job not found" });
    });

    app.post("/api/jobs/:id/toggle", authMiddleware, (req, res) => {
      const body = req.body as Record<string, unknown>;
      const enabled =
        typeof body.enabled === "boolean" ? body.enabled : undefined;
      if (enabled === undefined) {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      try {
        const updated = scheduler.setEnabled(req.params.id, enabled);
        return res.status(200).json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });
  }

  // Global error handler — redact internal paths from error responses
  const redactPaths = (message: string): string =>
    message
      .replace(/\/Users\/[^/\s]+/g, "~")
      .replace(/\/home\/[^/\s]+/g, "~")
      .replace(/C:\\\\Users\\\\[^\\\\\s]+/g, "~");

  app.use(
    (
      err: Error & { statusCode?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const statusCode = err.statusCode ?? 500;
      const message =
        statusCode === 500 ? "Internal server error" : redactPaths(err.message);
      res.status(statusCode).json({ error: message });
    },
  );

  return app;
};
