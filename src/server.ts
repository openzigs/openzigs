import "dotenv/config";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { createApp } from "./app.js";
import { ChannelManager, DiscordChannel, TelegramChannel, WebChatChannel } from "./channels/index.js";
import type { MessageChannel } from "./channels/index.js";
import { loadConfig } from "./config/index.js";
import type { AccessControlConfig } from "./config/index.js";
import type { CustomAgentConfig, NativeMcpServerConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import type { Logger } from "winston";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";
import { CopilotWrapperService } from "./copilot/index.js";
import { createHooksConfig } from "./copilot/hooks.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerMcpTools } from "./mcp/index.js";
import { MessageRouter } from "./routing/index.js";
import { SessionManager } from "./sessions/index.js";
import { CloudflareTunnel } from "./tunnel/index.js";
import { createModelsRouter } from "./api/models.js";
import { createAdminRouter } from "./api/admin.js";
import { createTasksRouter } from "./api/tasks.js";
import { createFilesRouter } from "./api/files.js";
import { launchChrome, killChrome } from "./browser/chrome-launcher.js";
import { TaskRepository, TaskEngine, TaskWorker, NotificationDispatcher } from "./tasks/index.js";
import { getDatabase, closeDatabase } from "./productivity/database.js";
import { WebhookManager } from "./webhooks/webhook-manager.js";
import { createWebhookRouter } from "./webhooks/webhook-routes.js";
import { PromptManager } from "./productivity/prompt-manager.js";
import { Scheduler } from "./productivity/scheduler.js";
import { PersonalityManager } from "./personality/personality-manager.js";
import { DockerSidecarManager } from "./mcp/docker-sidecar-manager.js";
import { LocalMcpServerManager } from "./mcp/local-mcp-server-manager.js";
import { registerBuiltinPostActions } from "./tasks/post-actions.js";
import { CustomPostActionManager } from "./tasks/custom-post-actions.js";
import { SentinelService, SentinelConfigSchema } from "./sentinel/index.js";
import { KnowledgeIngestionService } from "./knowledge/index.js";
import { createKnowledgeRouter } from "./api/knowledge.js";

// Register built-in post-action types (create-github-issues, send-webhook, etc.)
registerBuiltinPostActions();

// Load user-created custom post-action types from disk and register them
const customPostActionManager = new CustomPostActionManager();
await customPostActionManager.initialize();

const config = await loadConfig();

// ── Load default agent archetypes from config/agents.json ──
let defaultAgents: CustomAgentConfig[] = [];
try {
  const agentsPath = path.resolve(process.cwd(), "config", "agents.json");
  const raw = await fs.readFile(agentsPath, "utf-8");
  const parsed = JSON.parse(raw) as { agents?: unknown };
  const agentsArray = Array.isArray(parsed.agents) ? parsed.agents : (Array.isArray(parsed) ? parsed : []);
  if (agentsArray.length > 0) {
    defaultAgents = agentsArray as CustomAgentConfig[];
  }
} catch {
  // agents.json is optional — continue without default archetypes
}

// Merge: user config agents override defaults by name; remaining defaults are kept
const userAgents: CustomAgentConfig[] = config.copilot?.customAgents ?? [];
const mergedAgentMap = new Map<string, CustomAgentConfig>();
for (const agent of defaultAgents) mergedAgentMap.set(agent.name, agent);
for (const agent of userAgents) mergedAgentMap.set(agent.name, agent);
const resolvedCustomAgents = [...mergedAgentMap.values()];

// Native MCP servers from config (no default file — purely user-configured)
const resolvedNativeMcpServers: Record<string, NativeMcpServerConfig> = config.copilot?.nativeMcpServers ?? {};

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

// ── Productivity: SQLite + Prompts + Scheduler + Tasks ──
const db = getDatabase();
const promptManager = new PromptManager({ db });
const personalityManager = new PersonalityManager({ db });
const taskRepository = new TaskRepository(db);
const taskEngine = new TaskEngine({ repository: taskRepository });
const scheduler = new Scheduler({
  db,
  promptResolver: (name, variables) => promptManager.resolveWithStages(name, variables ?? {}),
  onExecute: async (job) => {
    if (job.actionType === "prompt") {
      const promptName = (job.actionPayload as Record<string, unknown>).promptName as string | undefined;
      if (!promptName) {
        throw new Error("Job payload missing promptName");
      }
      const variables = ((job.actionPayload as Record<string, unknown>).variables ?? {}) as Record<string, string>;
      const resolved = promptManager.resolve(promptName, variables);
      if (resolved === null) {
        throw new Error(`Saved prompt not found: ${promptName}`);
      }
      logger.info(`Scheduler executing prompt "${promptName}" for job "${job.name}"`);
      const chatModel = job.model ?? undefined;
      let result = "";
      for await (const chunk of copilot.chat(resolved, { model: chatModel })) {
        result += chunk;
      }
      return result || `Prompt "${promptName}" executed (no response)`;
    }

    if (job.actionType === "shell") {
      const command = (job.actionPayload as Record<string, unknown>).command as string | undefined;
      if (!command) {
        throw new Error("Job payload missing command");
      }
      logger.info(`Scheduler executing shell command for job "${job.name}": ${command}`);
      return `Shell job "${job.name}" executed: ${command}`;
    }

    logger.info(`Scheduler executed custom job "${job.name}" (${job.id})`);
    return `Custom job "${job.name}" executed`;
  },
});
scheduler.setTaskEngine(taskEngine);
scheduler.startAll();

// ── MCP Sidecar Auto-Provisioning ──
const mcpServersConfig = config.mcpServers;
const sidecarManager = new DockerSidecarManager({
  skipUnconfigured: mcpServersConfig?.skipUnconfigured ?? true,
  healthRetries: mcpServersConfig?.healthRetries ?? 3,
  healthRetryDelay: mcpServersConfig?.healthRetryDelay ?? 2000,
});

let sidecarUrls = new Map<string, string>();

if (mcpServersConfig?.autoProvision !== false) {
  const dockerAvailable = await sidecarManager.isDockerAvailable();
  if (dockerAvailable) {
    logger.info("Docker detected — auto-provisioning MCP sidecars...");
    sidecarUrls = await sidecarManager.startAll();
    const started = Array.from(sidecarUrls.keys());
    if (started.length > 0) {
      logger.info(`MCP sidecars ready: ${started.join(", ")}`);
    } else {
      logger.info("No MCP sidecars started (check API credentials in .env)");
    }
  } else {
    logger.info("Docker not available — using env-var sidecar URLs (manual mode)");
  }
}

// Resolve sidecar URLs: auto-provisioned URLs take priority, env vars as fallback
const resolveSidecarUrl = (name: string, envVar: string, defaultPort: number): string | undefined => {
  const autoUrl = sidecarUrls.get(name);
  if (autoUrl) return autoUrl;
  const envUrl = process.env[envVar];
  if (envUrl) return envUrl;
  // Only return default if sidecar is explicitly configured but not auto-provisioned
  if (mcpServersConfig?.sidecars?.[name]?.enabled === false) return undefined;
  if (mcpServersConfig?.autoProvision !== false && sidecarUrls.size > 0) return undefined;
  return `http://localhost:${defaultPort}`;
};

// ── Local MCP Servers (subprocess-based: Word/Office, Google Calendar, etc.) ──
const localServerManager = new LocalMcpServerManager({
  skipUnconfigured: mcpServersConfig?.skipUnconfigured ?? true,
});

try {
  logger.info("Starting local MCP servers (subprocess-based)...");
  await localServerManager.startAll();
  const running = localServerManager.getAllStatuses().filter((s) => s.running);
  if (running.length > 0) {
    logger.info(`Local MCP servers ready: ${running.map((s) => `${s.name} (${s.toolCount} tools)`).join(", ")}`);
  } else {
    logger.info("No local MCP servers started (check runtime availability and credentials)");
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  logger.warn(`Local MCP server startup error: ${msg}`);
}

const app = createApp(config, { auditLogger, approvalQueue, toolRegistry, promptManager, scheduler, personalityManager });
const port = Number(process.env.PORT ?? 3000);
const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3001";
const channelManager = new ChannelManager();
const sessionManager = new SessionManager();

// Lazy ref for disabled native MCP tools — populated after copilot wrapper is created.
// The hooks closure reads from this at call-time, not at construction time.
let copilotRef: CopilotWrapperService | null = null;
const getDisabledNativeMcpToolNames = (): Set<string> => {
  if (!copilotRef) return new Set();
  const servers = copilotRef.getNativeMcpServers();
  const disabled = new Set<string>();
  for (const def of Object.values(servers)) {
    if (def.disabledTools) {
      for (const t of def.disabledTools) disabled.add(t);
    }
  }
  return disabled;
};

const copilot = new CopilotWrapperService({
  toolRegistry,
  maxToolsPerRequest: config.session?.maxToolsPerRequest ?? 30,
  infiniteSessions: config.session?.infiniteSessions,
  hooks: createHooksConfig({ toolRegistry, approvalQueue, auditLogger, sessionManager, getDisabledNativeMcpToolNames }),
  defaultReasoningEffort: config.copilot?.defaultReasoningEffort ?? undefined,
  provider: config.copilot?.provider ?? undefined,
  defaultWorkingDirectory: config.copilot?.defaultWorkingDirectory ?? undefined,
  customAgents: resolvedCustomAgents,
  nativeMcpServers: resolvedNativeMcpServers,
});
copilotRef = copilot;

// ── Knowledge Ingestion Service ──
const knowledgeConfig = config.knowledge;
const knowledgeService = new KnowledgeIngestionService({
  config: {
    enabled: knowledgeConfig?.enabled !== false,
    directory: knowledgeConfig?.directory,
    chunkSize: knowledgeConfig?.chunkSize,
    chunkOverlap: knowledgeConfig?.chunkOverlap,
    maxResults: knowledgeConfig?.maxResults,
    watchEnabled: knowledgeConfig?.watchEnabled !== false,
    mediaModel: knowledgeConfig?.mediaModel,
  } as Partial<import("./knowledge/types.js").KnowledgeConfig>,
});

registerMcpTools(toolRegistry, {
  allowedDirs: allowedDirs.length > 0 ? allowedDirs : [process.cwd(), os.tmpdir(), os.homedir(), "/tmp", "/private/tmp"],
  shellAllowlist: (process.env.OPENZIGS_SHELL_ALLOWLIST ?? "git,find,ls,cat,head,tail,grep,wc,echo,pwd,mkdir,cp,mv,rm,which,date,curl,bash,sh,java,javac,python3,node").split(",").map(s => s.trim()).filter(Boolean),
  braveApiKey: process.env.BRAVE_API_KEY,
  chromeDebugHost: process.env.CHROME_DEBUG_HOST,
  chromeDebugPort,
  auditLogger,
  approvalQueue,
  promptManager,
  scheduler,
  personalityManager,
  taskEngine,
  copilot,
  linkedinSidecarUrl: resolveSidecarUrl("linkedin", "MCP_LINKEDIN_URL", 5101),
  twitterSidecarUrl: resolveSidecarUrl("twitter", "MCP_TWITTER_URL", 5102),
  facebookSidecarUrl: resolveSidecarUrl("facebook", "MCP_FACEBOOK_URL", 5103),
  pinterestSidecarUrl: resolveSidecarUrl("pinterest", "MCP_PINTEREST_URL", 5104),
  markitdownSidecarUrl: resolveSidecarUrl("markitdown", "MCP_MARKITDOWN_URL", 5301),
  gmailSidecarUrl: resolveSidecarUrl("gmail", "MCP_GMAIL_URL", 5302),
  databaseSidecarUrl: resolveSidecarUrl("database", "MCP_DATABASE_URL", 5303),
  githubSidecarUrl: resolveSidecarUrl("github", "MCP_GITHUB_URL", 5304),
  githubToken: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
  localServerManager,
  knowledgeService,
});

// ── Task Background Worker ──
const maxConcurrent = config.tasks?.maxConcurrent ?? 2;
const taskWorker = new TaskWorker({ engine: taskEngine, copilot, maxConcurrent, taskRepository });
taskWorker.start();

// ── Sentinel: Autonomous System Monitor ──
const sentinelConfigRaw = config.sentinel ?? {};
const sentinelConfig = SentinelConfigSchema.parse(sentinelConfigRaw);
const sentinel = new SentinelService({
  taskRepo: taskRepository,
  copilot,
  sessionManager,
  config: sentinelConfig,
  channelManager,
});

// ── Webhook Manager ──
const webhookManager = new WebhookManager();

// Model API routes
const modelsRouter = createModelsRouter({ copilot });
app.use("/api/models", modelsRouter);

// Admin API routes (no auth for local dev; gate behind auth in prod)
const adminRouter = createAdminRouter({ toolRegistry, sidecarManager, localServerManager, promptManager, scheduler, personalityManager, sessionManager, copilot, taskWorker, taskEngine, webhookManager, customPostActionManager, sentinel, knowledgeService });
app.use("/api/admin", adminRouter);

// Knowledge Base API routes
const knowledgeRouter = createKnowledgeRouter({ knowledgeService });
app.use("/api/admin/knowledge", knowledgeRouter);

// Start the Knowledge Ingestion Service in the background
void knowledgeService.start()
  .then(() => {
    logger.info("Knowledge Ingestion Service started");
  })
  .catch((error) => {
    const details = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start Knowledge Ingestion Service: ${details}`);
  });

// Webhook trigger routes (public-facing)
const webhookRouter = createWebhookRouter({ webhookManager, taskEngine, promptManager });
app.use("/api/webhooks/trigger", webhookRouter);

// Tasks API routes
const tasksRouter = createTasksRouter({ taskEngine, taskRepository });
app.use("/api/tasks", tasksRouter);

// Files API routes (Workbench file management)
const effectiveAllowedDirs = allowedDirs.length > 0
  ? allowedDirs
  : [process.cwd(), os.tmpdir(), os.homedir(), "/tmp", "/private/tmp"];
const filesRouter = createFilesRouter({
  allowedDirs: effectiveAllowedDirs,
  markitdownUrl: process.env.MCP_MARKITDOWN_URL,
});
app.use("/api/files", filesRouter);

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

// Wire Sentinel Socket.IO event forwarding
sentinel.setIO(io);
if (sentinelConfig.enabled) {
  void sentinel.start()
    .then(() => {
      logger.info("Sentinel autonomous monitor started");
    })
    .catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start Sentinel autonomous monitor: ${details}`);
    });
}

// Wire Knowledge Base Socket.IO event forwarding
for (const event of [
  "document:indexed",
  "document:failed",
  "document:deleted",
  "indexing:started",
  "indexing:completed",
  "watcher:ready",
  "watcher:error",
] as const) {
  knowledgeService.on(event, (data: unknown) => {
    io.emit(`knowledge:${event}`, data);
  });
}

// Wire NotificationDispatcher now that we have the Socket.IO server
// (side-effect: registers event listeners on TaskEngine)
new NotificationDispatcher({
  engine: taskEngine,
  channelManager,
  sessionManager,
  io,
});

// Forward ALL task lifecycle events to Socket.IO for real-time graph updates
for (const event of ["task:queued", "task:running", "task:completed", "task:failed", "task:cancelled"] as const) {
  taskEngine.on(event, (task: import("./tasks/types.js").AgentTask) => {
    io.emit("task:status", {
      event,
      task: {
        id: task.id,
        parentTaskId: task.parentTaskId,
        status: task.status,
        goal: task.goal,
        trigger: task.trigger,
        depth: task.depth,
        model: task.model,
        result: task.result,
        error: task.error,
        spawnedBy: task.spawnedBy,
        sessionId: task.sessionId,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
      },
    });
  });
}

approvalQueue.on("approval:created", (approval) => {
  io.emit("approval:request", approval);
});

// Forward real-time token usage and context compaction events to connected clients
copilot.on("token:usage", (event: import("./copilot/copilot-wrapper.js").TokenUsageEvent) => {
  io.emit("context:usage", event);
});

copilot.on("context:compaction", (event: import("./copilot/copilot-wrapper.js").CompactionEvent) => {
  io.emit("context:compaction", event);
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

scheduler.on("job:executed", (result) => {
  io.emit("job:executed", result);
});

sidecarManager.on("sidecar:started", (status) => {
  io.emit("sidecar:status", status);
});

sidecarManager.on("sidecar:stopped", (status) => {
  io.emit("sidecar:status", status);
});

sidecarManager.on("sidecar:healthy", (status) => {
  io.emit("sidecar:status", status);
});

sidecarManager.on("sidecar:unhealthy", (status) => {
  io.emit("sidecar:status", status);
});

localServerManager.on("server:started", (status) => {
  io.emit("local-server:status", status);
});

localServerManager.on("server:stopped", (status) => {
  io.emit("local-server:status", status);
});

localServerManager.on("server:error", (name, error) => {
  io.emit("local-server:error", { name, error: error.message });
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
      void router.route(message, { model, allowedTools: message.tools }).catch((error) => {
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

const createRouter = (accessControlOverride?: AccessControlConfig, onUserInputRequest?: import("./copilot/copilot-wrapper.js").UserInputHandler) => {
  return new MessageRouter({
    channelManager,
    sessionManager,
    copilot,
    accessControl: accessControlOverride ?? (config.messaging?.accessControl ?? defaultAccessControl),
    personalityManager,
    taskEngine,
    onUserInputRequest,
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
  const webChatChannel = new WebChatChannel({ io, sessionManager });
  const router = createRouter(undefined, async (request, sessionId) => {
    // Route interactive questions through the web chat channel.
    // Resolve the chatId for this session so we send the prompt to the right socket.
    try {
      const session = await sessionManager.getSession(sessionId);
      const chatId = typeof session.metadata?.chatId === "string" ? session.metadata.chatId : undefined;
      if (!chatId) {
        return { answer: "", wasFreeform: false };
      }
      return webChatChannel.sendUserInputRequest(chatId, request);
    } catch {
      return { answer: "", wasFreeform: false };
    }
  });

  await webChatChannel.connect();
  channelManager.register(webChatChannel);

  // When a user clears their chat, invalidate the router's cached session
  // so the next message creates a brand new session.
  webChatChannel.onClear(({ userId }) => {
    router.clearUserSession("web", userId);
  });

  // Streaming-aware routing for web chat
  webChatChannel.onMessage((message) => {
    const messageId = nanoid();

    void router
      .route(message, {
        onChunk: (chunk) => {
          void webChatChannel.sendStreamChunk(message.chatId, chunk, messageId);
        },
        onToolCall: (tool) => {
          void webChatChannel.sendToolProgress(message.chatId, tool);
        },
        model: message.model, // Model is picked per-request via the UI; already read from user config by the model selector
        allowedTools: message.tools,
        attachments: message.files,
        workingDirectory: message.workingDirectory,
      })
      .then(() => {
        void webChatChannel.sendStreamEnd(message.chatId, messageId);
      })
      .catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        logger.error(`web chat message routing failed: ${details}`);
        const userMessage = /SDK|CLI|unavailable|timed out|rate.?limit/i.test(details)
          ? details
          : "Something went wrong — check server logs for details.";
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

// Clean up Chrome + Scheduler + Tasks + Database + Sidecars + Local MCP servers on process exit
const gracefulShutdown = () => {
  scheduler.stopAll();
  closeDatabase();
  killChrome();
  void Promise.all([
    sentinel.stop(),
    taskWorker.stop(),
    sidecarManager.stopAll(),
    localServerManager.stopAll(),
    knowledgeService.stop(),
  ]).finally(() => process.exit(0));
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

export { app, httpServer };
