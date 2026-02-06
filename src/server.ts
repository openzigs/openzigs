import "dotenv/config";
import { createServer } from "node:http";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { ChannelManager, DiscordChannel, TelegramChannel } from "./channels/index.js";
import type { MessageChannel } from "./channels/index.js";
import { loadConfig } from "./config/index.js";
import type { AccessControlConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import type { Logger } from "winston";
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
  return ids.map((id) => (id.startsWith("telegram:")) ? id : `telegram:${id}`);
};

const defaultAccessControl = {
  mode: "open" as const,
  allowedUsers: [],
  blockedUsers: []
};

function setupChannelRouting(
  channel: MessageChannel,
  router: MessageRouter,
  approvalQueue: ApprovalQueue,
  sessionManager: SessionManager,
  logger: Logger
) {
  const channelType = channel.type;

  channel.onMessage((message) => {
    void router.route(message).catch((error) => {
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
  app.use("/telegram/webhook", telegramChannel.getWebhookCallback());

  setupChannelRouting(telegramChannel, router, approvalQueue, sessionManager, logger);
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
