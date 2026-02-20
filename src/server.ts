import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { jwtVerify } from "jose";
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
import { VoiceService } from "./voice/index.js";
import { createVoiceRouter } from "./api/voice.js";
import { SecretVaultService } from "./vault/index.js";
import { createVaultRouter } from "./api/vault.js";
import { createDirectorRouter } from "./api/director.js";
import { createAudioRouter } from "./api/audio.js";
import { createPresenterRouter } from "./api/presenter.js";
import { PresentationRepository } from "./presenter/presentation-repository.js";
import { detectChapters, computeQuizTimestamps } from "./presenter/chapter-detector.js";
import { generateThumbnail } from "./presenter/thumbnail-generator.js";
import { TeacherAgent } from "./presenter/teacher-agent.js";
import { QuizGenerator } from "./presenter/quiz-generator.js";
import { RenderOrchestrator } from "./video/render-orchestrator.js";
import { RoomManager } from "./presenter/room-manager.js";
import { ExpressPeerServer } from "peer";

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
  audioSidecarUrl: resolveSidecarUrl("audio", "AUDIO_SIDECAR_URL", 5006),
  copilot,
});

// ── Secret Vault Service ──
const vaultConfig = config.vault;
const vaultService = new SecretVaultService({
  vaultPath: vaultConfig?.vaultPath,
});

// ── Voice Service (Google Cloud TTS or Local Audio Sidecar) ──
const voiceConfig = config.voice;
const voiceService = new VoiceService({
  enabled: voiceConfig?.enabled ?? false,
  provider: voiceConfig?.provider ?? "google",
  voiceName: voiceConfig?.voiceName ?? "en-US-Standard-C",
  speakingRate: voiceConfig?.speakingRate ?? 1.0,
  pitch: voiceConfig?.pitch ?? 0.0,
  cacheDir: voiceConfig?.cacheDir ?? "~/.openzigs/voice-cache",
  maxCacheSizeMb: voiceConfig?.maxCacheSizeMb ?? 500,
  maxTextLength: voiceConfig?.maxTextLength ?? 5000,
  sidecarUrl: voiceConfig?.sidecarUrl ?? resolveSidecarUrl("audio", "AUDIO_SIDECAR_URL", 5006),
});

if (voiceService.getConfig().enabled) {
  const provider = voiceService.getConfig().provider;
  if (provider === "local") {
    // Local provider: initialize immediately (sidecar may start later)
    void voiceService.initialize().catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.warn(`Voice service startup skipped: ${details}`);
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    void voiceService.initialize().catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.warn(`Voice service startup skipped: ${details}`);
    });
  }
}

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
  vaultService,
  voiceService,
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

// Vault API routes
const vaultRouter = createVaultRouter({ vaultService });
app.use("/api/admin/vault", vaultRouter);

// Director Mode API routes
const directorConfig = (config as Record<string, unknown>).director as {
  enabled?: boolean;
  outputDir?: string;
  defaultTemplate?: string;
  assets?: {
    localLibraryPath?: string;
    downloadCachePath?: string;
    pixabayApiKey?: string;
    jamendoClientId?: string;
    pexelsApiKey?: string;
  };
} | undefined;

/** Expand leading ~ to the user's home directory (Node fs APIs don't do this). */
function expandTilde(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

const renderOrchestrator = new RenderOrchestrator({
  rendersDir: expandTilde(directorConfig?.outputDir ?? "~/.openzigs/renders"),
  maxConcurrent: 1,
});

const directorRouter = createDirectorRouter({
  copilot,
  voiceService,
  renderOrchestrator,
  config: {
    enabled: directorConfig?.enabled ?? true,
    outputDir: expandTilde(directorConfig?.outputDir ?? "~/.openzigs/video-output"),
    defaultTemplate: directorConfig?.defaultTemplate ?? "Minimalist",
    assets: {
      localLibraryPath: expandTilde(directorConfig?.assets?.localLibraryPath ?? "~/.openzigs/media-library"),
      downloadCachePath: expandTilde(directorConfig?.assets?.downloadCachePath ?? "~/.openzigs/asset-cache"),
      pixabayApiKey: directorConfig?.assets?.pixabayApiKey ?? "",
      jamendoClientId: directorConfig?.assets?.jamendoClientId ?? "",
      pexelsApiKey: directorConfig?.assets?.pexelsApiKey ?? "",
    },
  },
});
app.use("/api/admin/director", directorRouter);

// ── Audio / Voice Lab Router (Issue #269, #272) ──
const audioRouterInstance = createAudioRouter({
  db: getDatabase(),
  sidecarUrl: config.voice?.sidecarUrl ?? "http://127.0.0.1:5006",
});
app.use("/api/admin/audio", audioRouterInstance);

// ── Presenter Mode Router (Issue #275) ──
const presentationRepo = new PresentationRepository(db);
const teacherAgent = new TeacherAgent({ copilotWrapper: copilot, presentationRepo, knowledgeService });
const quizGenerator = new QuizGenerator({ copilotWrapper: copilot, presentationRepo });

// Resolve invite secret: use config value, or auto-generate and persist
let presenterInviteSecret = (config as Record<string, unknown> & { presenter?: { inviteSecret?: string } }).presenter?.inviteSecret ?? "";
if (!presenterInviteSecret) {
  presenterInviteSecret = randomBytes(32).toString("hex");
  logger.info("Auto-generated presenter invite secret — persisting to config");
  // Persist so the secret survives restarts and can be shared with the UI
  const cfgPath = process.env.OPENZIGS_CONFIG_PATH ?? path.join(os.homedir(), ".openzigs", "config.json");
  (async () => {
    try {
      await fs.mkdir(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
      let userCfg: Record<string, unknown> = {};
      try { userCfg = JSON.parse(await fs.readFile(cfgPath, "utf-8")); } catch { /* new file */ }
      const presenter = (userCfg.presenter && typeof userCfg.presenter === "object")
        ? (userCfg.presenter as Record<string, unknown>) : {};
      presenter.inviteSecret = presenterInviteSecret;
      userCfg.presenter = presenter;
      await fs.writeFile(cfgPath, JSON.stringify(userCfg, null, 2), { encoding: "utf-8", mode: 0o600 });
      logger.info("Persisted presenter invite secret to config");
    } catch (err) {
      logger.warn(`Failed to persist invite secret: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

const presenterBaseUrl = (config as Record<string, unknown> & { presenter?: { baseUrl?: string } }).presenter?.baseUrl || uiOrigin;
const presenterRouter = createPresenterRouter({
  presentationRepo,
  teacherAgent,
  quizGenerator,
  voiceService,
  db,
  copilotWrapper: copilot,
  knowledgeService,
  inviteSecret: presenterInviteSecret,
  baseUrl: presenterBaseUrl,
});
app.use("/api/presentations", presenterRouter);

// ── Public Invite Redeem Route (no auth required) — Issue #283 ──
app.get("/api/invite/redeem", async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Missing token parameter" });
    return;
  }

  try {
    const secretKey = new TextEncoder().encode(presenterInviteSecret);
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });

    const presentationId = payload.presentationId as string | undefined;
    if (!presentationId || payload.role !== "guest") {
      res.status(401).json({ error: "Invalid invite token" });
      return;
    }

    // Compute max-age from JWT exp
    const exp = payload.exp ?? 0;
    const maxAge = Math.max(exp - Math.floor(Date.now() / 1000), 0);

    // Set HttpOnly cookie for auth
    res.cookie("guest_token", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: maxAge * 1000,
      secure: req.protocol === "https",
    });

    // Set non-HttpOnly cookie for client-side guest detection
    res.cookie("is_guest", "true", {
      httpOnly: false,
      sameSite: "strict",
      path: "/",
      maxAge: maxAge * 1000,
      secure: req.protocol === "https",
    });

    res.json({ presentationId });
  } catch (err) {
    // Clear stale cookies on verification failure
    res.clearCookie("guest_token", { path: "/" });
    res.clearCookie("is_guest", { path: "/" });
    res.status(401).json({ error: "Invalid or expired invite link" });
  }
});

// ── Post-Render Ingestion Hook (Presenter Mode) ──
// When Director Mode finishes rendering, auto-index the presentation into SQLite.
renderOrchestrator.on("render:complete", (result: { jobId: string; outputPath: string | null; durationSec: number | null }) => {
  const job = renderOrchestrator.getJob(result.jobId);
  if (!job || !result.outputPath) return;

  void (async () => {
    try {
      const manifest = job.manifest;
      const chapters = detectChapters(manifest);
      const mode = manifest.metadata?.productionMode ?? "presentation";
      const quizEnabled = !!manifest.metadata?.presenterQuizEnabled;
      const fps = manifest.composition.fps || 30;
      const durationSec = result.durationSec ?? 0;

      // Generate thumbnail
      const thumbnailPath = await generateThumbnail(result.outputPath!, result.jobId, durationSec);

      // Build script segments from image_scene voiceovers in the timeline
      const scriptSegments = manifest.timeline
        .filter((e) => e.type === "image_scene" || e.type === "title_card")
        .map((e) => ({
          text: e.type === "title_card" ? e.title : ((e as { scriptText?: string }).scriptText ?? ""),
          startTime: e.startAtFrame / fps,
          endTime: (e.startAtFrame + e.duration) / fps,
        }));

      // Compute quiz config if applicable
      const quizConfig = chapters.length > 1 ? computeQuizTimestamps(chapters) : null;

      const inserted = presentationRepo.insert({
        title: manifest.projectTitle || "Untitled Presentation",
        video_path: result.outputPath!,
        thumbnail_path: thumbnailPath,
        duration_seconds: durationSec,
        fps,
        script_json: JSON.stringify(scriptSegments),
        chapters: JSON.stringify(chapters),
        voice_id: null,
        quiz_enabled: quizEnabled,
        quiz_config: quizConfig,
        director_manifest_path: null,
        mode,
      });

      if (quizEnabled) {
        void quizGenerator.generate(inserted.id).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn(`[PresenterIngestion] Quiz pre-generation failed for ${inserted.id}: ${msg}`);
        });
      }

      // Index the transcript into the RAG knowledge base so the teacher agent
      // can retrieve precise passage text via the knowledge tool.
      const transcriptText = scriptSegments
        .map((s) => s.text)
        .filter(Boolean)
        .join(" ");
      if (transcriptText.trim()) {
        void knowledgeService.ingestText(inserted.id, inserted.title, transcriptText).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn(`[PresenterIngestion] Knowledge ingest failed for ${inserted.id}: ${msg}`);
        });
      }

      logger.info(`[PresenterIngestion] Indexed presentation "${manifest.projectTitle}" (${result.jobId})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[PresenterIngestion] Failed to index presentation: ${msg}`);
    }
  })();
});

// Start the Knowledge Ingestion Service in the background
void knowledgeService.start()
  .then(() => {
    logger.info("Knowledge Ingestion Service started");
  })
  .catch((error) => {
    const details = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start Knowledge Ingestion Service: ${details}`);
  });

// ── Voice Router (Google Cloud TTS + Local Audio Sidecar) ──
const voiceRouter = createVoiceRouter({ voiceService });
app.use("/api/voice", voiceRouter);

// Webhook trigger routes (public-facing)
const webhookRouter = createWebhookRouter({ webhookManager, taskEngine, promptManager });
app.use("/api/webhooks/trigger", webhookRouter);

// Tasks API routes
const tasksRouter = createTasksRouter({ taskEngine, taskRepository });
app.use("/api/tasks", tasksRouter);

// Files API routes (Workbench file management)
const filesBaseAllowedDirs = allowedDirs.length > 0
  ? allowedDirs
  : [process.cwd(), os.tmpdir(), os.homedir(), "/tmp", "/private/tmp"];

// Always include OpenZigs render/output roots so Presenter video playback can
// stream rendered assets, even when OPENZIGS_ALLOWED_DIRS is narrowed.
const effectiveAllowedDirs = Array.from(new Set([
  ...filesBaseAllowedDirs,
  expandTilde("~/.openzigs"),
  expandTilde(directorConfig?.outputDir ?? "~/.openzigs/video-output"),
  expandTilde("~/.openzigs/renders"),
]));
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

// ── Multiplayer Room Manager (Issue #284) ──
const roomManager = new RoomManager();

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: uiOrigin,
    credentials: true
  }
});

// ── PeerJS Signaling Server (Issue #286) ──
// Mount PeerJS at /peerjs — path option controls both WS upgrade filtering
// and HTTP route prefix, so we use app.use() without a mount path to avoid
// double-prefixing.
const peerServer = ExpressPeerServer(httpServer, {
  path: "/peerjs",
  proxied: true,
  alive_timeout: 60000,
  key: "openzigs",
  allow_discovery: false,
});
app.use(peerServer);

io.on("connection", (socket) => {
  socket.emit("status:update", { connected: true });

  // ── Presenter Mode: Teacher Agent Q&A (Issue #279, #285) ──
  // Refactored into a named function so it can be called from both
  // the Socket.IO event handler and the audio-chunk STT handler (#287).
  const handlePresenterAsk = async (
    emitter: import("socket.io").Socket,
    ioServer: SocketIOServer,
    data: { presentationId: string; question: string; chapterIndex?: number; timestamp?: number },
  ) => {
    const roomId = data.presentationId;
    const room = roomManager.getRoom(roomId);
    const broadcast = room && room.members.has(emitter.id);

    // Determine emit target: room broadcast or single socket
    const emit = (event: string, payload: unknown) => {
      if (broadcast) {
        ioServer.to(roomId).emit(event, payload);
      } else {
        emitter.emit(event, payload);
      }
    };

    try {
      if (broadcast) {
        roomManager.setFsmState(roomId, "PAUSED_USER_Q");
        ioServer.to(roomId).emit("room:fsm_state", { fsmState: "PAUSED_USER_Q" });
      }

      emit("presenter:answer:start", {
        presentationId: roomId,
        askedBy: emitter.id,
        question: data.question,
      });

      let fullAnswer = "";
      for await (const token of teacherAgent.ask({
        presentationId: roomId,
        question: data.question,
        chapterIndex: data.chapterIndex ?? 0,
        timestamp: data.timestamp ?? 0,
      })) {
        fullAnswer += token;
        emit("presenter:answer:token", { token });
      }

      // Auto-save note
      try {
        presentationRepo.insertNote({
          presentation_id: roomId,
          question: data.question,
          answer: fullAnswer,
          chapter_index: data.chapterIndex ?? 0,
          timestamp_seconds: data.timestamp ?? 0,
        });
        emit("presenter:note:saved", { presentationId: roomId });
      } catch (noteErr) {
        logger.warn(`Failed to save presenter note: ${noteErr instanceof Error ? noteErr.message : String(noteErr)}`);
      }

      emit("presenter:answer:done", { presentationId: roomId });

      if (broadcast) {
        roomManager.setFsmState(roomId, "PLAYING");
        ioServer.to(roomId).emit("room:fsm_state", { fsmState: "PLAYING" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      emit("presenter:answer:error", { error: msg });

      if (broadcast) {
        roomManager.setFsmState(roomId, "PLAYING");
        ioServer.to(roomId).emit("room:fsm_state", { fsmState: "PLAYING" });
      }
    }
  };

  socket.on("presenter:ask", (data: { presentationId?: string; question?: string; chapterIndex?: number; timestamp?: number }) => {
    if (!data.presentationId || !data.question || typeof data.question !== "string") return;
    void handlePresenterAsk(socket, io, {
      presentationId: data.presentationId,
      question: data.question,
      chapterIndex: data.chapterIndex ?? 0,
      timestamp: data.timestamp ?? 0,
    });
  });

  // ── Room Management (Issue #284) ──
  // ── Server-side role enforcement for room:join ──
  // Parse guest JWT from cookies to determine actual role.
  // If guest_token cookie exists → force guest role, validate presentationId matches JWT claim.
  // No guest_token → admin user, allow host role.
  const resolveRoomRole = (
    rawCookie: string | undefined,
    requestedPresentationId: string,
  ): { role: "host" | "guest"; allowed: boolean } => {
    if (!rawCookie) return { role: "host", allowed: true };

    // Parse cookies from raw header
    const cookies: Record<string, string> = {};
    for (const pair of rawCookie.split(";")) {
      const [k, ...v] = pair.split("=");
      if (k) cookies[k.trim()] = v.join("=").trim();
    }
    const guestToken = cookies["guest_token"];
    if (!guestToken) return { role: "host", allowed: true };

    // Decode JWT payload (no crypto — verified at redeem time)
    try {
      const parts = guestToken.split(".");
      if (parts.length !== 3) return { role: "guest", allowed: false };
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
        presentationId?: string;
        role?: string;
        exp?: number;
      };
      // Check expiry
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return { role: "guest", allowed: false };
      }
      // Guest can ONLY join the room for their specific presentation
      if (payload.presentationId && payload.presentationId !== requestedPresentationId) {
        logger.warn(`Guest socket tried to join room ${requestedPresentationId} but JWT scoped to ${payload.presentationId}`);
        return { role: "guest", allowed: false };
      }
      return { role: "guest", allowed: true };
    } catch {
      return { role: "guest", allowed: false };
    }
  };

  socket.on("room:join", (data: { presentationId?: string; role?: "host" | "guest" }) => {
    if (!data.presentationId) return;

    const rawCookie = socket.handshake.headers.cookie;
    const { role, allowed } = resolveRoomRole(rawCookie, data.presentationId);
    if (!allowed) {
      socket.emit("room:error", { error: "Not authorized to join this room" });
      return;
    }

    const room = roomManager.createOrJoin(data.presentationId, socket.id, role);
    socket.join(data.presentationId);

    // Notify all room members
    io.to(data.presentationId).emit("room:member_joined", {
      socketId: socket.id,
      role,
      memberCount: room.members.size,
    });

    // Send current room state + server-assigned role to the joining socket
    socket.emit("room:state", {
      currentTimeSeconds: room.currentTimeSeconds,
      isPlaying: room.isPlaying,
      fsmState: room.fsmState,
      assignedRole: role,
    });
  });

  socket.on("room:leave", (data: { presentationId?: string }) => {
    if (!data.presentationId) return;
    const pid = roomManager.leave(socket.id);
    if (pid) {
      socket.leave(pid);
      io.to(pid).emit("room:member_left", {
        socketId: socket.id,
        memberCount: roomManager.getMemberCount(pid),
      });
      // Broadcast updated peer list
      io.to(pid).emit("room:peers_updated", { peerIds: roomManager.getPeerIds(pid) });
    }
  });

  // ── Playback Sync — any room member can play/pause/seek ──
  // Validates room membership, not host-only. Any participant can control playback.
  const handleMemberPlayback = (
    eventName: string,
    data: { presentationId?: string; currentTimeSeconds?: number },
    isPlayingOverride?: boolean,
  ) => {
    if (!data.presentationId || !roomManager.isMemberOf(socket.id, data.presentationId)) {
      if (data.presentationId && !roomManager.isMember(socket.id)) {
        logger.warn(`Non-member socket ${socket.id} attempted ${eventName}`);
      }
      return;
    }
    const patch: Partial<{ currentTimeSeconds: number; isPlaying: boolean }> = {
      currentTimeSeconds: data.currentTimeSeconds ?? 0,
    };
    if (isPlayingOverride !== undefined) patch.isPlaying = isPlayingOverride;
    roomManager.updatePlayback(data.presentationId, patch);

    io.to(data.presentationId).emit("room:sync_playback", {
      isPlaying: isPlayingOverride ?? (roomManager.getRoom(data.presentationId)?.isPlaying ?? false),
      currentTimeSeconds: data.currentTimeSeconds ?? 0,
      originSocketId: socket.id,
    });
  };

  socket.on("member:play", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("member:play", data, true);
  });

  socket.on("member:pause", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("member:pause", data, false);
  });

  socket.on("member:seek", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("member:seek", data);
  });

  // Legacy aliases for backward compat — same logic as member events
  socket.on("host:play", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("host:play", data, true);
  });
  socket.on("host:pause", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("host:pause", data, false);
  });
  socket.on("host:seek", (data: { presentationId?: string; currentTimeSeconds?: number }) => {
    handleMemberPlayback("host:seek", data);
  });

  // ── Peer Discovery (Issue #286) ──
  socket.on("room:announce_peer", (data: { presentationId?: string; peerId?: string }) => {
    if (!data.presentationId || !data.peerId) return;
    roomManager.setPeerId(socket.id, data.peerId);
    io.to(data.presentationId).emit("room:peers_updated", {
      peerIds: roomManager.getPeerIds(data.presentationId),
    });
  });

  // ── P2P Audio STT Relay (Issue #287) ──
  const pendingTranscriptions = new Set<string>();

  socket.on("room:audio_chunk", async (data: { presentationId?: string; blob?: ArrayBuffer }) => {
    if (!data.presentationId || !data.blob) return;

    const room = roomManager.getRoom(data.presentationId);
    if (!room || !room.members.has(socket.id)) return;

    // Size guard: max 2MB
    if (data.blob.byteLength > 2 * 1024 * 1024) {
      logger.warn(`Audio chunk from ${socket.id} exceeds 2MB limit (${data.blob.byteLength} bytes)`);
      return;
    }

    // Rate limit: one transcription in-flight per socket
    if (pendingTranscriptions.has(socket.id)) return;
    pendingTranscriptions.add(socket.id);

    try {
      const audioSidecarUrl = config.voice?.sidecarUrl ?? "http://127.0.0.1:5006";
      const formData = new FormData();
      formData.append("audio", new Blob([data.blob], { type: "audio/webm" }), "chunk.webm");

      const response = await fetch(`${audioSidecarUrl}/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        logger.warn(`STT transcription failed: ${response.status}`);
        return;
      }

      const { text } = (await response.json()) as { text: string };
      if (!text?.trim()) return;

      // Show the speaker what was transcribed so they can review & confirm
      socket.emit("room:transcription_preview", { text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Audio chunk transcription error: ${msg}`);
    } finally {
      pendingTranscriptions.delete(socket.id);
    }
  });

  // ── Disconnect Cleanup ──
  socket.on("disconnect", () => {
    const pid = roomManager.leave(socket.id);
    if (pid) {
      io.to(pid).emit("room:member_left", {
        socketId: socket.id,
        memberCount: roomManager.getMemberCount(pid),
      });
      io.to(pid).emit("room:peers_updated", { peerIds: roomManager.getPeerIds(pid) });
    }
  });
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
    vaultService,
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
  const shouldAutoApproveVaultPrompt = (request: { question: string; choices?: string[] }): boolean => {
    const question = request.question.toLowerCase();
    const choices = (request.choices ?? []).map((c) => c.toLowerCase());

    const mentionsVaultAuthIntent =
      /(vault|secret|credential|password)/i.test(question) && /(login|log in|sign in|facebook|account)/i.test(question);

    // Only auto-approve when there's an obvious affirmative option and no risky freeform requirement.
    const hasAffirmativeChoice = choices.some((c) => /^(yes|allow|approve)/.test(c) || /(recommended)/.test(c));

    return mentionsVaultAuthIntent && hasAffirmativeChoice;
  };

  const pickAffirmativeChoice = (choices: string[] = []): string => {
    const scored = choices
      .map((choice) => {
        const lower = choice.toLowerCase();
        let score = 0;
        if (/(recommended)/.test(lower)) score += 10;
        if (/^(yes|allow|approve)/.test(lower)) score += 8;
        if (/(use|continue|proceed|confirm)/.test(lower)) score += 4;
        if (/(no|deny|cancel|don't|do not)/.test(lower)) score -= 10;
        return { choice, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.choice ?? "";
  };

  const router = createRouter(undefined, async (request, sessionId) => {
    if (shouldAutoApproveVaultPrompt(request)) {
      return {
        answer: pickAffirmativeChoice(request.choices ?? []),
        wasFreeform: false,
      };
    }

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
  vaultService.lock();
  void Promise.all([
    sentinel.stop(),
    taskWorker.stop(),
    sidecarManager.stopAll(),
    localServerManager.stopAll(),
    knowledgeService.stop(),
    voiceService.shutdown(),
  ]).finally(() => process.exit(0));
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

export { app, httpServer };
