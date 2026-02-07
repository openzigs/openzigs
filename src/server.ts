import "dotenv/config";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { createApp } from "./app.js";
import { ChannelManager, DiscordChannel, TelegramChannel, WebChatChannel } from "./channels/index.js";
import type { MessageChannel } from "./channels/index.js";
import { loadConfig } from "./config/index.js";
import type { AccessControlConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import type { Logger } from "winston";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";
import { CopilotWrapperService } from "./copilot/index.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerMcpTools } from "./mcp/index.js";
import { MessageRouter } from "./routing/index.js";
import { SessionManager } from "./sessions/index.js";
import { CloudflareTunnel } from "./tunnel/index.js";
import { createModelsRouter } from "./api/models.js";
import { createAdminRouter } from "./api/admin.js";
import { launchChrome, killChrome } from "./browser/chrome-launcher.js";

const config = await loadConfig();
const auditLogger = new AuditLogger();
const approvalQueue = new ApprovalQueue({ auditLogger });
const toolRegistry = new ToolRegistry({
  statePath: path.resolve(process.cwd(), "config", "tools.json")
});
const allowedDirsRaw = process.env.OPENZIGS_ALLOWED_DIRS ?? "";
const allowedDirs = allowedDirsRaw
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const chromeDebugPort = process.env.CHROME_DEBUG_PORT
  ? Number(process.env.CHROME_DEBUG_PORT)
  : undefined;

// Auto-launch Chrome with remote debugging (set CHROME_AUTO_LAUNCH=false to disable)
const chromeAutoLaunch = process.env.CHROME_AUTO_LAUNCH !== "false";
if (chromeAutoLaunch && process.env.CHROME_DEBUG_HOST) {
  await launchChrome({
    host: process.env.CHROME_DEBUG_HOST,
    port: chromeDebugPort ?? 9222,
    reuseExisting: true
  });
}

registerMcpTools(toolRegistry, {
  allowedDirs: allowedDirs.length > 0 ? allowedDirs : [process.cwd()],
  braveApiKey: process.env.BRAVE_API_KEY,
  chromeDebugHost: process.env.CHROME_DEBUG_HOST,
  chromeDebugPort,
  auditLogger,
  approvalQueue
});
const app = createApp(config, { auditLogger, approvalQueue, toolRegistry });
const port = Number(process.env.PORT ?? 3000);
const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3000";
const channelManager = new ChannelManager();
const sessionManager = new SessionManager();
const copilot = new CopilotWrapperService({ toolRegistry });

// Serve static chat UI
app.use(express.static(path.resolve(process.cwd(), "public")));

// Friendly admin route
app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "public", "admin.html"));
});

// Model API routes
const modelsRouter = createModelsRouter({ copilot });
app.use("/api/models", modelsRouter);

// Admin API routes (no auth for local dev; gate behind auth in prod)
const adminRouter = createAdminRouter({ toolRegistry });
app.use("/api/admin", adminRouter);

const tunnelConfig = config.tunnel;
const tunnel = tunnelConfig?.enabled
  ? new CloudflareTunnel({
      mode: tunnelConfig.mode,
      namedTunnel: tunnelConfig.namedTunnel,
      logger
    })
  : null;

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: uiOrigin,
    credentials: true
  }
});

io.on("connection", (socket) => {
  socket.emit("status:update", { connected: true });
});

approvalQueue.on("approval:created", (approval) => {
  io.emit("approval:request", approval);
});

approvalQueue.on("approval:decided", (approval) => {
  io.emit("approval:decided", {
    id: approval.id,
    approved: approval.status === "approved",
    decidedVia: approval.decidedVia,
    status: approval.status
  });
});

toolRegistry.on("tool:toggled", (payload) => {
  io.emit("tool:toggled", payload);
});

const normalizeTelegramAllowlist = (ids: string[]) => {
  return ids.map((id) => (id.startsWith("telegram:")) ? id : `telegram:${id}`);
};

const defaultAccessControl = {
  mode: "open" as const,
  allowedUsers: [],
  blockedUsers: []
};

  const setupChannelRouting = (
    channel: MessageChannel,
    router: MessageRouter,
    approvalQueue: ApprovalQueue,
    sessionManager: SessionManager,
    logger: Logger,
    model?: string
  ) => {
    const channelType = channel.type;
  
    channel.onMessage((message) => {
      void router.route(message, { model }).catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        logger.error(`${channelType} message routing failed: ${details}`);
      });
    });

  channel.onApprovalResponse((response) => {
    approvalQueue.handleDecision(response.approvalId, {
      approved: response.approved,
      decidedBy: response.decidedBy,
      decidedVia: channelType
    });
  });

  approvalQueue.on("approval:created", async (approval) => {
    if (approval.channelType !== channelType || !approval.sessionId) {
      return;
    }
    try {
      const session = await sessionManager.getSession(approval.sessionId);
      const chatId = typeof session.metadata.chatId === "string"
        ? session.metadata.chatId
        : undefined;
      if (!chatId) {
        logger.warn(`Missing chatId for ${channelType} approval ${approval.id}`);
        return;
      }
      await channel.sendApprovalRequest(chatId, {
        id: approval.id,
        tool: approval.tool,
        args: approval.args,
        riskLevel: approval.riskLevel,
        explanation: approval.explanation,
        preview: approval.preview
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send ${channelType} approval: ${details}`);
    }
  });
}

const createRouter = (accessControlOverride?: AccessControlConfig) => {
  return new MessageRouter({
    channelManager,
    sessionManager,
    copilot,
    accessControl: accessControlOverride ?? (config.messaging?.accessControl ?? defaultAccessControl)
  });
};

const telegramConfig = config.channels?.telegram;
if (telegramConfig?.enabled && telegramConfig.token) {
  const telegramChannel = new TelegramChannel({
    config: {
      botToken: telegramConfig.token,
      webhookUrl: telegramConfig.webhookUrl,
      webhookSecret: telegramConfig.webhookSecret,
      adminUserId: telegramConfig.adminUserId
    },
    toolRegistry,
    logger
  });

  const accessControl = telegramConfig.allowedUsers.length > 0
    ? {
        mode: "allowlist" as const,
        allowedUsers: normalizeTelegramAllowlist(telegramConfig.allowedUsers),
        blockedUsers: []
      }
    : undefined;

  const router = createRouter(accessControl);

  await telegramChannel.connect();
  channelManager.register(telegramChannel);

  if (telegramConfig.webhookUrl) {
    logger.info(`Telegram webhook URL: ${telegramConfig.webhookUrl}`);
  }

  // Mount webhook with optional secret token validation
  const telegramWebhookSecret = telegramConfig.webhookSecret;
  const webhookHandler = telegramChannel.getWebhookCallback();
  if (telegramWebhookSecret && typeof telegramWebhookSecret === "string" && telegramWebhookSecret.length > 0) {
    app.post("/telegram/webhook", (req, res, next) => {
      const header = (req.get("x-telegram-bot-api-secret-token") || "").toString();
      if (!header || header !== telegramWebhookSecret) {
        res.status(403).send("Forbidden");
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (webhookHandler as any)(req, res, next);
    });
  } else {
    app.use("/telegram/webhook", webhookHandler);
  }

  setupChannelRouting(telegramChannel, router, approvalQueue, sessionManager, logger, telegramConfig.model);
}

const discordConfig = config.channels?.discord;
if (discordConfig?.enabled && discordConfig.token) {
  const discordChannel = new DiscordChannel({
    config: {
      botToken: discordConfig.token,
      allowedGuilds: discordConfig.allowedGuilds
    },
    logger
  });

  const router = createRouter();

  await discordChannel.connect();
  channelManager.register(discordChannel);

  setupChannelRouting(discordChannel, router, approvalQueue, sessionManager, logger);
}

// ── Web Chat Channel ──
const webConfig = config.channels?.web;
if (webConfig?.enabled !== false) {
  const webChatChannel = new WebChatChannel({ io });
  const router = createRouter();

  await webChatChannel.connect();
  channelManager.register(webChatChannel);

  // Streaming-aware routing for web chat
  webChatChannel.onMessage((message) => {
    const messageId = nanoid();

    void router
      .route(message, {
        onChunk: (chunk) => {
          void webChatChannel.sendStreamChunk(message.chatId, chunk, messageId);
        },
        model: message.model // Model is picked per-request via the UI; already read from user config by the model selector
      })
      .then(() => {
        void webChatChannel.sendStreamEnd(message.chatId, messageId);
      })
      .catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        logger.error(`web chat message routing failed: ${details}`);
        const userMessage = /SDK|CLI|unavailable|timed out/i.test(details)
          ? details
          : "Something went wrong";
        void webChatChannel.sendError(message.chatId, userMessage);
      });
  });

  webChatChannel.onApprovalResponse((response) => {
    approvalQueue.handleDecision(response.approvalId, {
      approved: response.approved,
      decidedBy: response.decidedBy,
      decidedVia: "web"
    });
  });

  approvalQueue.on("approval:created", async (approval) => {
    if (approval.channelType !== "web" || !approval.sessionId) {
      return;
    }
    try {
      const session = await sessionManager.getSession(approval.sessionId);
      const chatId = typeof session.metadata.chatId === "string" ? session.metadata.chatId : undefined;
      if (!chatId) {
        logger.warn(`Missing chatId for web approval ${approval.id}`);
        return;
      }
      await webChatChannel.sendApprovalRequest(chatId, {
        id: approval.id,
        tool: approval.tool,
        args: approval.args,
        riskLevel: approval.riskLevel,
        explanation: approval.explanation,
        preview: approval.preview
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send web approval: ${details}`);
    }
  });
}

httpServer.listen(port, () => {
  logger.info(`OpenZigs server listening on port ${port}`);
  void auditLogger.log({
    level: "info",
    category: "system",
    event: "server_started",
    details: { port }
  });

  if (tunnel) {
    tunnel.on("connected", (publicUrl) => {
      logger.info(`Public URL: ${publicUrl}`);
    });
    tunnel.on("disconnected", () => {
      logger.warn("Cloudflare tunnel disconnected");
    });
    void tunnel.start(port).catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Cloudflare tunnel failed: ${details}`);
    });
  }
});

// Clean up Chrome on process exit
process.on("SIGINT", () => {
  killChrome();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killChrome();
  process.exit(0);
});

export { app, httpServer };
