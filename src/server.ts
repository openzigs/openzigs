import "dotenv/config";
import { createServer } from "node:http";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { ChannelManager, TelegramChannel } from "./channels/index.js";
import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";
import { CopilotWrapperService } from "./copilot/index.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerToolCatalog } from "./mcp/tool-catalog.js";
import { MessageRouter } from "./routing/index.js";
import { SessionManager } from "./sessions/index.js";

const config = await loadConfig();
const auditLogger = new AuditLogger();
const toolRegistry = new ToolRegistry({
  statePath: path.resolve(process.cwd(), "config", "tools.json")
});
registerToolCatalog(toolRegistry);
const approvalQueue = new ApprovalQueue({ auditLogger });
const app = createApp(config, { auditLogger, approvalQueue, toolRegistry });
const port = Number(process.env.PORT ?? 3000);
const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3000";
const channelManager = new ChannelManager();
const sessionManager = new SessionManager();
const copilot = new CopilotWrapperService({ toolRegistry });

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
  return ids.map((id) => (id.includes(":")) ? id : `telegram:${id}`);
};

const telegramConfig = config.channels?.telegram;
if (telegramConfig?.enabled && telegramConfig.token) {
  const telegramChannel = new TelegramChannel({
    config: {
      botToken: telegramConfig.token,
      webhookUrl: telegramConfig.webhookUrl || undefined,
      adminUserId: telegramConfig.adminUserId || undefined
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
    : (config.messaging?.accessControl ?? {
        mode: "open" as const,
        allowedUsers: [],
        blockedUsers: []
      });

  const router = new MessageRouter({
    channelManager,
    sessionManager,
    copilot,
    accessControl
  });

  await telegramChannel.connect();
  channelManager.register(telegramChannel);
  app.use("/telegram/webhook", telegramChannel.getWebhookCallback());

  telegramChannel.onMessage((message) => {
    void router.route(message).catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Telegram message routing failed: ${details}`);
    });
  });

  telegramChannel.onApprovalResponse((response) => {
    approvalQueue.handleDecision(response.approvalId, {
      approved: response.approved,
      decidedBy: response.decidedBy,
      decidedVia: "telegram"
    });
  });

  approvalQueue.on("approval:created", async (approval) => {
    if (approval.channelType !== "telegram" || !approval.sessionId) {
      return;
    }
    try {
      const session = await sessionManager.getSession(approval.sessionId);
      const chatId = typeof session.metadata.chatId === "string"
        ? session.metadata.chatId
        : undefined;
      if (!chatId) {
        logger.warn(`Missing chatId for Telegram approval ${approval.id}`);
        return;
      }
      await telegramChannel.sendApprovalRequest(chatId, {
        id: approval.id,
        tool: approval.tool,
        args: approval.args,
        riskLevel: approval.riskLevel,
        explanation: approval.explanation,
        preview: approval.preview
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send Telegram approval: ${details}`);
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
});

export { app, httpServer };
