import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { jwtVerify } from "jose";
import { createApp } from "./app.js";
import {
  ChannelManager,
  DiscordChannel,
  TelegramChannel,
  WebChatChannel,
} from "./channels/index.js";
import type { MessageChannel } from "./channels/index.js";
import { loadConfig } from "./config/index.js";
import type { AccessControlConfig } from "./config/index.js";
import type {
  CustomAgentConfig,
  NativeMcpServerConfig,
} from "./config/index.js";
import { logger } from "./logging/logger.js";
import type { Logger } from "winston";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";
import { CopilotWrapperService } from "./copilot/index.js";
import { SubagentEventRelay } from "./copilot/subagent-event-relay.js";
import { createHooksConfig } from "./copilot/hooks.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerMcpTools } from "./mcp/index.js";
import { MessageRouter } from "./routing/index.js";
import { SessionManager } from "./sessions/index.js";
import { CloudflareTunnel } from "./tunnel/index.js";
import { createModelsRouter } from "./api/models.js";
import { createSystemRouter } from "./api/system.js";
import {
  createAdminRouter,
  pinterestOAuthStates,
  exchangePinterestCode,
  refreshPinterestToken,
  linkedinOAuthStates,
  exchangeLinkedInCode,
  refreshLinkedInToken,
  tiktokOAuthStates,
  exchangeTikTokCode,
  youtubeOAuthStates,
  exchangeYouTubeCode,
  refreshYouTubeToken,
  ensurePinterestScheduledJob,
  setAdminIO,
  setTunnelPublicUrl,
  setAdminMessageRouter,
} from "./api/admin.js";
import { createTasksRouter } from "./api/tasks.js";
import { createSeoRouter } from "./api/seo.js";
import { createFilesRouter } from "./api/files.js";
import { createVllmAdminRouter } from "./api/admin/vllm.js";
import { createLocalLlmRouter, ensureVllmApiKey } from "./api/local-llm.js";
import { LocalEndpointHealthMonitor } from "./sentinel/local-endpoint-health.js";
import { GpuCoordinator } from "./gpu/gpu-coordinator.js";
import { GpuDispatcher, setActiveGpuDispatcher } from "./gpu/gpu-dispatcher.js";
import { createGpuDispatcherAdminRouter } from "./api/admin/gpu-dispatcher.js";
import { createSessionCostsRouter } from "./api/session-costs.js";
import { CostMeter } from "./costs/cost-meter.js";
import { fetchPricingTable } from "./costs/copilot-pricing.js";
import { getGpuProfile } from "./system/gpu-profile.js";
import { autoRegisterIfDetected } from "./llm/vllm-detect.js";
import { launchChrome, killChrome } from "./browser/chrome-launcher.js";
import {
  TaskRepository,
  TaskEngine,
  TaskWorker,
  NotificationDispatcher,
  TaskEventStreamer,
  ResultInjector,
} from "./tasks/index.js";
import { getDatabase, closeDatabase } from "./productivity/database.js";
import { WebhookManager } from "./webhooks/webhook-manager.js";
import { WebhookRepository } from "./webhooks/webhook-repository.js";
import { createWebhookRouter } from "./webhooks/webhook-routes.js";
import { PromptManager } from "./productivity/prompt-manager.js";
import { Scheduler } from "./productivity/scheduler.js";
import { PersonalityManager } from "./personality/personality-manager.js";
import { DockerSidecarManager } from "./mcp/docker-sidecar-manager.js";
import { LocalMcpServerManager } from "./mcp/local-mcp-server-manager.js";
import { getFirecrawlClient } from "./browser/firecrawl-client.js";
import {
  FirecrawlWebhookHandler,
  createFirecrawlWebhookRouter,
  generateWebhookSecret,
} from "./browser/firecrawl-webhooks.js";
import {
  secureDirOptions,
  secureWriteOptions,
} from "./config/file-permissions.js";
import { getPlatformCapabilities } from "./config/platform.js";
import { registerBuiltinPostActions } from "./tasks/post-actions.js";
import { CustomPostActionManager } from "./tasks/custom-post-actions.js";
import { SentinelService, SentinelConfigSchema } from "./sentinel/index.js";
import { KnowledgeIngestionService } from "./knowledge/index.js";
import type {
  KnowledgeCategory,
  KnowledgeVisibility,
} from "./knowledge/index.js";
import { createKnowledgeRouter } from "./api/knowledge.js";
import { VoiceService } from "./voice/index.js";
import { createVoiceRouter } from "./api/voice.js";
import { SecretVaultService } from "./vault/index.js";
import { createVaultRouter } from "./api/vault.js";
import { createIntegrationsRouter } from "./api/integrations.js";
import {
  MemoryManager,
  createGitHubApiClient,
} from "./memory/memory-manager.js";
import { createMemoryRouter } from "./api/memory.js";
import { createAuthMiddleware } from "./auth/auth.js";
import { createDirectorRouter, setDirectorIO } from "./api/director.js";
import { createPitchRouter, setPitchIO } from "./api/pitch.js";
import { PitchRepository } from "./pitch/pitch-repository.js";
import { ShareTokenRepository } from "./pitch/share-token-repository.js";
import { registerImageCompletionListener } from "./pitch/pitch-image-service.js";
import { ensureSidecarsRunning } from "./queue/sidecar-autostart.js";
import { createPublicShareRouter } from "./api/public-share.js";
import { createAudioRouter } from "./api/audio.js";
import { createPresenterRouter } from "./api/presenter.js";
import { createSocialRouter, dispatchApprovedReply } from "./api/social.js";
import { createSocialAnalyticsRouter } from "./api/social-analytics.js";
import { createPinterestRouter } from "./api/pinterest.js";
import { SocialRepository } from "./channels/social/social-repository.js";
import {
  SocialIngestionService,
  TwitterAdapter,
  LinkedInAdapter,
  InstagramAdapter,
  FacebookAdapter,
  GenericPollAdapter,
} from "./channels/social/social-ingestion.js";
import { SocialBrain } from "./channels/social/social-brain.js";
import { HandoffManager } from "./channels/social/handoff-manager.js";
import { CommentRuleEngine } from "./channels/social/comment-rule-engine.js";
import {
  PostContextService,
  TwitterApiClient,
  YouTubeApiClient,
  LinkedInApiClient,
  TikTokApiClient,
  RedditApiClient,
  InstagramApiClient,
  FacebookApiClient,
} from "./channels/social/platform-api-client.js";
import { DmDispatcher } from "./channels/social/dm-dispatcher.js";
import { verifyWebhookSignature } from "./channels/social/webhook-signature.js";
import { createRedditPollFn } from "./channels/social/reddit-poll.js";
import { createYouTubePollFn } from "./channels/social/youtube-poll.js";
import { createRedditBrowserPollFn } from "./channels/social/reddit-browser-poll.js";
import { createYouTubeBrowserPollFn } from "./channels/social/youtube-browser-poll.js";
import { createTwitterPollFn } from "./channels/social/twitter-poll.js";
import { createFacebookPollFn } from "./channels/social/facebook-poll.js";
import { createInstagramPollFn } from "./channels/social/instagram-poll.js";
import { createLinkedInPollFn } from "./channels/social/linkedin-poll.js";
import { BrandVoiceRepository } from "./personality/brand-voice-repository.js";
import { BrandVoiceService } from "./personality/brand-voice-service.js";
import { PipelineTemplateManager } from "./productivity/pipeline-template-manager.js";
import { PresentationRepository } from "./presenter/presentation-repository.js";
import {
  detectChapters,
  computeQuizTimestamps,
} from "./presenter/chapter-detector.js";
import { generateThumbnail } from "./presenter/thumbnail-generator.js";
import { TeacherAgent } from "./presenter/teacher-agent.js";
import { QuizGenerator } from "./presenter/quiz-generator.js";
import { RenderOrchestrator } from "./video/render-orchestrator.js";
import { TrimWorker } from "./video/trim-worker.js";
import { AnalyzeWorker } from "./video/analyze-worker.js";
import { ClipExtractor } from "./video/clip-extractor.js";
import { ReframeWorker } from "./video/reframe-worker.js";
import { AudioCleaner } from "./video/audio-cleaner.js";
import { BRollPipeline } from "./video/broll-pipeline.js";
import { BrandTemplateRepository } from "./video/brand-templates.js";
import {
  AnalyticsCache,
  AnalyticsAggregator,
} from "./analytics/analytics-aggregator.js";
import { RoomManager } from "./presenter/room-manager.js";
import { ExpressPeerServer } from "peer";
import { MediaQueueRepository } from "./queue/media-queue-repository.js";
import { OutboxRepository } from "./outbox/outbox-repository.js";
import { OutboxPoller } from "./outbox/outbox-poller.js";
import { createOutboxRouter } from "./api/outbox.js";
import { BrandKitRepository } from "./video/brand-kit.js";
import { PostTemplateRepository } from "./creative/post-template-repository.js";
import { QueueMaster } from "./queue/queue-master.js";
import { MediaNotificationService } from "./queue/media-notification-service.js";
import { createQueueRouter, createQueueCallbackRouter } from "./api/queue.js";
import { createGalleryRouter } from "./api/gallery.js";
import { createStudioRouter } from "./api/studio.js";
import { createVideoPipelineRouter } from "./api/video-pipeline.js";
import { createCalendarRouter } from "./api/calendar.js";
import { createAnalyticsRouter } from "./api/analytics.js";
import { createCreativeRouter } from "./api/creative.js";
import { createTemplatesRouter } from "./api/templates.js";
import { createBrandTemplateRouter } from "./api/brand-templates.js";
import {
  createCharacterRouter,
  setCharacterIO,
  setCharacterChannelManager,
  resumeStaleTrainingPolls,
} from "./api/characters.js";
import { TemplateRepository, TemplateService } from "./orchestration/index.js";
import { createOrchestrationRouter } from "./api/orchestration.js";
import setupRouter from "./api/setup.js";
import { CharacterRepository } from "./characters/character-repository.js";
import { PROJECT_ROOT } from "./project-root.js";

// Register built-in post-action types (create-github-issues, send-webhook, etc.)
registerBuiltinPostActions();

// Load user-created custom post-action types from disk and register them
const customPostActionManager = new CustomPostActionManager();
await customPostActionManager.initialize();

const config = await loadConfig();

// vLLM BYOK auto-config (Epic #888 / Issue #920) — if a local vLLM server
// is reachable and the user hasn't configured a provider for that base URL,
// generate an API key and write a `copilot.provider` block to config.json.
// Disabled by default; opt in via llm.localVllm.enabled=true.
try {
  const vllmCfg = (
    config as unknown as {
      llm?: {
        localVllm?: {
          enabled?: boolean;
          baseUrl?: string;
          autoRegister?: boolean;
        };
      };
    }
  ).llm?.localVllm;
  if (vllmCfg?.enabled && vllmCfg.autoRegister !== false) {
    const result = await autoRegisterIfDetected({
      baseUrl: vllmCfg.baseUrl,
      logger: {
        info: (msg, details) => logger.info(msg, details ?? {}),
        warn: (msg, details) => logger.warn(msg, details ?? {}),
      },
    });
    logger.info("vLLM auto-register check complete", { status: result.status });
  }
} catch (err) {
  logger.warn("vLLM auto-register failed (non-fatal)", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Load default agent archetypes from config/agents.json ──
let defaultAgents: CustomAgentConfig[] = [];
try {
  const agentsPath = path.resolve(PROJECT_ROOT, "config", "agents.json");
  const raw = await fs.readFile(agentsPath, "utf-8");
  const parsed = JSON.parse(raw) as { agents?: unknown };
  const agentsArray = Array.isArray(parsed.agents)
    ? parsed.agents
    : Array.isArray(parsed)
      ? parsed
      : [];
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
const resolvedCustomAgents = [...mergedAgentMap.values()].map((a) => ({
  ...a,
  displayName: a.displayName ?? a.name,
  prompt: a.prompt ?? "",
}));

// Native MCP servers from config (no default file — purely user-configured)
const resolvedNativeMcpServers: Record<string, NativeMcpServerConfig> =
  config.copilot?.nativeMcpServers ?? {};

const auditLogger = new AuditLogger();
const approvalQueue = new ApprovalQueue({ auditLogger });
const toolRegistry = new ToolRegistry({
  statePath: path.resolve(PROJECT_ROOT, "config", "tools.json"),
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
    reuseExisting: true,
  });
}

// ── Productivity: SQLite + Prompts + Scheduler + Tasks ──
const db = getDatabase();
const gpuCoordinator = new GpuCoordinator({
  db,
  warn: (msg, details) => logger.warn(msg, details ?? {}),
});

// ── GPU dispatcher (Issue #1056) ──────────────────────────────────────────
// Per-GPU job queue with mutual exclusion. Detects GPU count up-front and
// surfaces lane state via /api/system/gpu + /api/admin/gpu/dispatcher and
// over Socket.IO (`gpu:dispatcher:state`).
//
// Issue #1071: on Apple Silicon there is one unified-memory Metal device.
// We register it as a single lane so LLM/image/video workloads serialize
// instead of double-binding the GPU — same mutex semantics, single lane.
const _bootGpuProfile = await getGpuProfile().catch(() => null);
const _gpuCount =
  _bootGpuProfile?.gpus && _bootGpuProfile.gpus.length > 0
    ? _bootGpuProfile.gpus.length
    : _bootGpuProfile?.apple_silicon
      ? 1
      : 0;
const _gpuDispatcherCfg = config.gpu?.dispatcher;
const gpuDispatcher = new GpuDispatcher({
  gpuCount: _gpuCount,
  pinning: _gpuDispatcherCfg?.pinning,
  mutualExclusion: _gpuDispatcherCfg?.mutualExclusion ?? true,
  defaultAllowFallback: _gpuDispatcherCfg?.allowFallback ?? false,
  audit: (event, details) => {
    void auditLogger.log({
      level:
        event.endsWith("_failed") || event.includes("error") ? "warn" : "info",
      category: "system",
      event,
      details,
    });
  },
});
setActiveGpuDispatcher(gpuDispatcher);

const promptManager = new PromptManager({ db });
const personalityManager = new PersonalityManager({ db });
const brandVoiceRepo = new BrandVoiceRepository(db);
const taskRepository = new TaskRepository(db);
const taskEngine = new TaskEngine({
  repository: taskRepository,
  backgroundTaskDefaultModel:
    config.tasks?.backgroundTaskDefaultModel ?? undefined,
});

// ── Orchestration Templates ──
const orchTemplateRepo = new TemplateRepository(db);
orchTemplateRepo.migrate();
const orchTemplateService = new TemplateService({
  repository: orchTemplateRepo,
  taskEngine,
});
orchTemplateService.seedBuiltIns();

// ── Media Queue: Push-Based Distributed Queue ──
const mediaQueueRepo = new MediaQueueRepository(db);
mediaQueueRepo.migrate();

// ── Video Generation Presets (#757) ──
const { VideoPresetsRepository } = await import("./queue/video-presets.js");
const videoPresetsRepo = new VideoPresetsRepository(db);
videoPresetsRepo.migrate();

// ── Outbox Publishing Queue (Epic #458) ──
const outboxRepo = new OutboxRepository(db);
outboxRepo.migrate();
const brandKitRepo = new BrandKitRepository(db);
brandKitRepo.migrate();
// Epic #951 (Studio Pitch) sub-issue #956: pitch decks/slides/assets repo.
const pitchRepo = new PitchRepository(db);
pitchRepo.migrate();
// Epic #990 (Pitch Pro) sub-issue #1000: public share-link tokens.
const shareTokenRepo = new ShareTokenRepository(db);
shareTokenRepo.migrate();
// Epic #951 (Studio Pitch) sub-issue #953: seed 8 starter Brand Kits.
// Idempotent — only inserts kits whose id is not already in the DB.
{
  const { seedStarterBrandKits } =
    await import("./pitch/starter-brand-kits.js");
  seedStarterBrandKits(brandKitRepo);
}
const postTemplateRepo = new PostTemplateRepository(db);
postTemplateRepo.migrate();
const outboxPoller = new OutboxPoller({
  outboxRepo,
  taskEngine,
  mediaQueueRepo,
});
outboxPoller.start();

// Read user config for imageGen, videoGen, and musicGen network mode
let imageGenNodeUrl =
  process.env.MAC_MINI_WORKER_URL ?? "http://localhost:5005";
let imageGenNodeToken: string | undefined = process.env.MAC_MINI_WORKER_TOKEN;
let videoGenNodeUrl = process.env.M2_PRO_WORKER_URL ?? "http://localhost:5007";
let videoGenNodeToken = process.env.M2_PRO_WORKER_TOKEN;
try {
  const cfgPath = path.join(os.homedir(), ".openzigs", "config.json");
  const raw = await fs.readFile(cfgPath, "utf-8");
  const userCfg = JSON.parse(raw) as Record<string, unknown>;
  const ig = userCfg.imageGen as Record<string, unknown> | undefined;
  if (
    ig?.mode === "network" &&
    typeof ig.networkNodeUrl === "string" &&
    ig.networkNodeUrl
  ) {
    imageGenNodeUrl = ig.networkNodeUrl;
    if (typeof ig.networkNodeToken === "string" && ig.networkNodeToken) {
      imageGenNodeToken = ig.networkNodeToken;
    }
  }
  const vg = userCfg.videoGen as Record<string, unknown> | undefined;
  if (
    vg?.mode === "network" &&
    typeof vg.networkNodeUrl === "string" &&
    vg.networkNodeUrl
  ) {
    videoGenNodeUrl = vg.networkNodeUrl;
    if (typeof vg.networkNodeToken === "string" && vg.networkNodeToken) {
      videoGenNodeToken = vg.networkNodeToken;
    }
  }
} catch {
  /* no user config or parse error — use defaults */
}

// Resolve the primary machine's LAN IP so the remote FluxQ/worker node can
// POST callbacks back to us.  Falls back to localhost when no external
// interface is found (single-machine dev setup).
function getLanIp(): string {
  const candidates: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal)
        candidates.push(addr.address);
    }
  }
  if (candidates.length === 0) return "localhost";
  // Prefer common LAN subnets (192.168.x.x, 10.x.x.x) over virtual interfaces
  // like Docker bridges (172.x.x.x) or macOS VM networks (192.168.64.x).
  const preferred = candidates.find(
    (ip) =>
      (ip.startsWith("192.168.") && !ip.startsWith("192.168.64.")) ||
      ip.startsWith("10."),
  );
  return preferred ?? candidates[0];
}

const queueMaster = new QueueMaster(mediaQueueRepo, {
  pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS ?? 3000),
  imageGen: {
    url: imageGenNodeUrl,
    token: imageGenNodeToken,
  },
  m2Pro: {
    url: videoGenNodeUrl,
    token: videoGenNodeToken,
  },
  callbackUrl:
    process.env.QUEUE_CALLBACK_URL ??
    `http://${getLanIp()}:${process.env.PORT ?? 3000}/api/queue/complete`,
  galleryDir: path.join(os.homedir(), ".openzigs", "gallery"),
});

const scheduler = new Scheduler({
  db,
  outboxRepo,
  promptResolver: (name, variables) =>
    promptManager.resolveWithStages(name, variables ?? {}),
  skillResolver: async (skillName) => {
    for (const dir of resolvedSkillDirectories) {
      const skillMdPath = path.join(dir, "SKILL.md");
      try {
        const raw = await fs.readFile(skillMdPath, "utf-8");
        const dirName = path.basename(dir);
        // Parse frontmatter to get name and allowed-tools
        const trimmed = raw.trimStart();
        let fmName = dirName;
        let allowedToolsStr = "";
        let body = raw;
        if (trimmed.startsWith("---")) {
          const endIdx = trimmed.indexOf("---", 3);
          if (endIdx !== -1) {
            const yamlBlock = trimmed.slice(3, endIdx).trim();
            body = trimmed.slice(endIdx + 3).trim();
            for (const line of yamlBlock.split("\n")) {
              const colonIdx = line.indexOf(":");
              if (colonIdx === -1) continue;
              const key = line.slice(0, colonIdx).trim();
              const val = line.slice(colonIdx + 1).trim();
              if (key === "name") fmName = val;
              else if (key === "allowed-tools") allowedToolsStr = val;
            }
          }
        }
        if (fmName === skillName || dirName === skillName) {
          const allowedTools = allowedToolsStr.split(/\s+/).filter(Boolean);
          return { body, allowedTools };
        }
      } catch {
        continue;
      }
    }
    return null;
  },
  allSkillNames: () => {
    return resolvedSkillDirectories.map((dir) => path.basename(dir));
  },
  onExecute: async (job) => {
    if (job.actionType === "prompt") {
      const promptName = (job.actionPayload as Record<string, unknown>)
        .promptName as string | undefined;
      if (!promptName) {
        throw new Error("Job payload missing promptName");
      }
      const variables = ((job.actionPayload as Record<string, unknown>)
        .variables ?? {}) as Record<string, string>;
      const resolved = promptManager.resolve(promptName, variables);
      if (resolved === null) {
        throw new Error(`Saved prompt not found: ${promptName}`);
      }
      logger.info(
        `Scheduler executing prompt "${promptName}" for job "${job.name}"`,
      );
      const chatModel = job.model ?? undefined;
      let result = "";
      for await (const chunk of copilot.chat(resolved, { model: chatModel })) {
        result += chunk;
      }
      return result || `Prompt "${promptName}" executed (no response)`;
    }

    if (job.actionType === "shell") {
      const command = (job.actionPayload as Record<string, unknown>).command as
        | string
        | undefined;
      if (!command) {
        throw new Error("Job payload missing command");
      }
      logger.info(
        `Scheduler executing shell command for job "${job.name}": ${command}`,
      );
      return `Shell job "${job.name}" executed: ${command}`;
    }

    logger.info(`Scheduler executed custom job "${job.name}" (${job.id})`);
    return `Custom job "${job.name}" executed`;
  },
});
scheduler.setTaskEngine(taskEngine);
scheduler.startAll();

// Auto-create the daily Pinterest job if a token is already configured
if ((process.env.PINTEREST_ACCESS_TOKEN ?? "").trim()) {
  ensurePinterestScheduledJob(scheduler, promptManager);
}

// ── Platform Capabilities ──
const platformCaps = getPlatformCapabilities();
logger.info(
  `Platform: ${platformCaps.os}/${platformCaps.arch} | Docker: ${platformCaps.dockerAvailable} | Sidecars: ${platformCaps.sidecarsSupported}`,
);
if (!platformCaps.sidecarsSupported) {
  logger.info(
    "Native sidecars (image-gen, audio, music) are only available on macOS ARM — skipping on this platform",
  );
}

// ── MCP Sidecar Auto-Provisioning ──
const mcpServersConfig = config.mcpServers;
const sidecarManager = new DockerSidecarManager({
  skipUnconfigured: mcpServersConfig?.skipUnconfigured ?? true,
  healthRetries: mcpServersConfig?.healthRetries ?? 3,
  healthRetryDelay: mcpServersConfig?.healthRetryDelay ?? 2000,
});

let sidecarUrls = new Map<string, string>();

if (!platformCaps.sidecarsSupported) {
  logger.info(
    "Skipping Docker sidecar provisioning — sidecars are only supported on macOS ARM",
  );
} else if (mcpServersConfig?.autoProvision !== false) {
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
    logger.info(
      "Docker not available — using env-var sidecar URLs (manual mode)",
    );
  }
}

// Resolve sidecar URLs: auto-provisioned URLs take priority, env vars as fallback
const resolveSidecarUrl = (
  name: string,
  envVar: string,
  defaultPort: number,
): string | undefined => {
  const autoUrl = sidecarUrls.get(name);
  if (autoUrl) return autoUrl;
  const envUrl = process.env[envVar];
  if (envUrl) return envUrl;
  // Only return default if sidecar is explicitly configured but not auto-provisioned
  if (mcpServersConfig?.sidecars?.[name]?.enabled === false) return undefined;
  if (mcpServersConfig?.autoProvision !== false && sidecarUrls.size > 0)
    return undefined;
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
    logger.info(
      `Local MCP servers ready: ${running.map((s) => `${s.name} (${s.toolCount} tools)`).join(", ")}`,
    );
  } else {
    logger.info(
      "No local MCP servers started (check runtime availability and credentials)",
    );
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  logger.warn(`Local MCP server startup error: ${msg}`);
}

const app = createApp(config, {
  auditLogger,
  approvalQueue,
  toolRegistry,
  promptManager,
  scheduler,
  personalityManager,
});
const authMiddleware = createAuthMiddleware(config.auth);
const port = Number(process.env.PORT ?? 3000);
const uiOrigin = process.env.OPENZIGS_UI_ORIGIN ?? "http://localhost:3001";
const channelManager = new ChannelManager();
const sessionManager = new SessionManager();

// Wire deferred dependencies into the scheduler (channelManager created after scheduler)
scheduler.setChannelManager(channelManager, {
  telegram: config.channels?.telegram?.adminUserId || undefined,
  discord: config.channels?.discord?.allowedGuilds?.[0] || undefined,
});

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

// Discover skill directories — each subdirectory of src/skills/ that contains a SKILL.md
const resolvedSkillDirectories: string[] = [];
try {
  const skillsRoot = path.resolve(PROJECT_ROOT, "src", "skills");
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillMdPath = path.join(skillsRoot, entry.name, "SKILL.md");
      try {
        await fs.access(skillMdPath);
        resolvedSkillDirectories.push(path.join(skillsRoot, entry.name));
      } catch {
        // No SKILL.md in this directory — skip
      }
    }
  }
  if (resolvedSkillDirectories.length > 0) {
    logger.info(`Loaded ${resolvedSkillDirectories.length} skill directories`);
  }
} catch {
  // src/skills/ doesn't exist — no skills configured
}

const copilot = new CopilotWrapperService({
  toolRegistry,
  maxToolsPerRequest: config.session?.maxToolsPerRequest ?? 30,
  startTimeoutMs: config.copilot?.startTimeoutMs,
  infiniteSessions: config.session?.infiniteSessions,
  hooks: createHooksConfig({
    toolRegistry,
    approvalQueue,
    auditLogger,
    sessionManager,
    getDisabledNativeMcpToolNames,
  }),
  defaultReasoningEffort: config.copilot?.defaultReasoningEffort ?? undefined,
  provider: config.copilot?.provider ?? undefined,
  defaultWorkingDirectory: config.copilot?.defaultWorkingDirectory ?? undefined,
  customAgents: resolvedCustomAgents,
  nativeMcpServers: resolvedNativeMcpServers,
  skillDirectories: resolvedSkillDirectories,
});
copilotRef = copilot;
orchTemplateService.setCopilot(copilot);

// ── Brand Voice Service ──
const brandVoiceService = new BrandVoiceService({
  repository: brandVoiceRepo,
  copilot,
});

// ── Knowledge Ingestion Service ──
const knowledgeConfig = config.knowledge;
const vectorStoreConfig = knowledgeConfig?.vectorStore;
const knowledgeVectorStore = vectorStoreConfig
  ? (await import("./knowledge/vector-store/factory.js")).createVectorStore({
      provider: vectorStoreConfig.provider ?? "lancedb",
      dbPath: path.join(os.homedir(), ".openzigs", "knowledge-db"),
      options: vectorStoreConfig.options,
    })
  : undefined;
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
  vectorStore: knowledgeVectorStore,
});

// ── Memory Manager ──
const memoryConfig = config.memory;
const ghToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "";
const memoryManager = new MemoryManager(
  {
    enabled: memoryConfig?.enabled ?? false,
    owner: memoryConfig?.owner ?? "",
    repo: memoryConfig?.repo ?? "openzigs-memory",
    cacheTtlMs: memoryConfig?.cacheTtlMs ?? 300000,
  },
  ghToken ? createGitHubApiClient(ghToken) : createGitHubApiClient(""),
);

// Wire memory context into Copilot sessions
copilot.setMemoryContextProvider(() => memoryManager.buildSessionContext());

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
  sidecarUrl:
    voiceConfig?.sidecarUrl ??
    resolveSidecarUrl("audio", "AUDIO_SIDECAR_URL", 5006),
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

// ── Social Brain: CRM, Ingestion, Auto-Reply, Handoff, Comment Automation ──
const socialRepository = new SocialRepository(db);
socialRepository.migrate();

const socialBrainConfig = (config as Record<string, unknown>).socialBrain as
  | import("./config/index.js").SocialBrainAppConfig
  | undefined;

const postContextService = new PostContextService(socialRepository);

const twitterBearerToken = process.env.TWITTER_BEARER_TOKEN ?? "";
if (twitterBearerToken) {
  postContextService.registerClient(new TwitterApiClient(twitterBearerToken));
}

const youtubeApiKey = process.env.YOUTUBE_API_KEY ?? "";
if (youtubeApiKey) {
  postContextService.registerClient(new YouTubeApiClient(youtubeApiKey));
}

const linkedinAccessToken = process.env.LINKEDIN_ACCESS_TOKEN ?? "";
if (linkedinAccessToken) {
  postContextService.registerClient(new LinkedInApiClient(linkedinAccessToken));
}

const tikNeuronApiKey = process.env.TIKNEURON_MCP_API_KEY ?? "";
if (tikNeuronApiKey) {
  postContextService.registerClient(new TikTokApiClient(tikNeuronApiKey));
}

const redditClientId = process.env.REDDIT_CLIENT_ID ?? "";
if (redditClientId && localServerManager) {
  postContextService.registerClient(new RedditApiClient(localServerManager));
}

const instagramAccessToken = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
if (instagramAccessToken) {
  postContextService.registerClient(
    new InstagramApiClient(instagramAccessToken),
  );
}

const facebookPageToken = process.env.FACEBOOK_PAGE_TOKEN ?? "";
if (facebookPageToken) {
  postContextService.registerClient(new FacebookApiClient(facebookPageToken));
}

// Only register platform adapters when credentials are actually configured
const socialAdapters: import("./channels/social/social-ingestion.js").SocialPlatformAdapter[] =
  [];
const twitterMode = socialBrainConfig?.connections?.twitter?.mode ?? "webhook";
if (twitterBearerToken) {
  if (twitterMode === "polling" && localServerManager) {
    socialAdapters.push(
      new GenericPollAdapter(
        "twitter",
        createTwitterPollFn(localServerManager),
      ),
    );
  } else {
    socialAdapters.push(new TwitterAdapter());
  }
}
if (linkedinAccessToken) {
  const linkedinMode =
    socialBrainConfig?.connections?.linkedin?.mode ?? "polling";
  if (linkedinMode === "polling" && localServerManager) {
    socialAdapters.push(
      new GenericPollAdapter(
        "linkedin",
        createLinkedInPollFn(localServerManager),
      ),
    );
  } else {
    socialAdapters.push(new LinkedInAdapter());
  }
}
if (redditClientId && localServerManager) {
  socialAdapters.push(
    new GenericPollAdapter("reddit", createRedditPollFn(localServerManager)),
  );
} else if (socialBrainConfig?.connections?.reddit?.mode === "browser") {
  const chromeHost = process.env.CHROME_DEBUG_HOST ?? "";
  const chromePort = parseInt(process.env.CHROME_DEBUG_PORT ?? "9222", 10);
  if (chromeHost) {
    logger.info(
      "[SocialBrain] Reddit using browser mode (beta) — no API credentials required",
    );
    socialAdapters.push(
      new GenericPollAdapter(
        "reddit",
        createRedditBrowserPollFn({ host: chromeHost, port: chromePort }),
      ),
    );
  } else {
    logger.warn(
      "[SocialBrain] Reddit browser mode requires CHROME_DEBUG_HOST to be set",
    );
  }
}
if (youtubeApiKey && localServerManager) {
  socialAdapters.push(
    new GenericPollAdapter("youtube", createYouTubePollFn(localServerManager)),
  );
} else if (socialBrainConfig?.connections?.youtube?.mode === "browser") {
  const chromeHost = process.env.CHROME_DEBUG_HOST ?? "";
  const chromePort = parseInt(process.env.CHROME_DEBUG_PORT ?? "9222", 10);
  const ytChannelUrl = process.env.YOUTUBE_CHANNEL_URL ?? "";
  if (chromeHost && ytChannelUrl) {
    logger.info(
      "[SocialBrain] YouTube using browser mode (beta) — no API key required",
    );
    socialAdapters.push(
      new GenericPollAdapter(
        "youtube",
        createYouTubeBrowserPollFn({
          host: chromeHost,
          port: chromePort,
          channelUrl: ytChannelUrl,
        }),
      ),
    );
  } else {
    logger.warn(
      "[SocialBrain] YouTube browser mode requires CHROME_DEBUG_HOST and YOUTUBE_CHANNEL_URL to be set",
    );
  }
}
if (instagramAccessToken) {
  const instagramMode =
    socialBrainConfig?.connections?.instagram?.mode ?? "polling";
  if (instagramMode === "polling" && localServerManager) {
    socialAdapters.push(
      new GenericPollAdapter(
        "instagram",
        createInstagramPollFn(localServerManager),
      ),
    );
  } else {
    socialAdapters.push(new InstagramAdapter());
  }
}
if (facebookPageToken) {
  const facebookMode =
    socialBrainConfig?.connections?.facebook?.mode ?? "polling";
  if (facebookMode === "polling" && localServerManager) {
    socialAdapters.push(
      new GenericPollAdapter(
        "facebook",
        createFacebookPollFn(localServerManager),
      ),
    );
  } else {
    socialAdapters.push(new FacebookAdapter());
  }
}

const socialIngestion = new SocialIngestionService({
  repository: socialRepository,
  adapters: socialAdapters,
  postContextService,
});

const socialBrain = new SocialBrain({
  repository: socialRepository,
  copilot,
  knowledgeService,
  confidenceThreshold: socialBrainConfig?.confidenceThreshold,
  brandVoiceBlock: brandVoiceService.getActiveVoicePromptBlock(),
  approvalRequired: socialBrainConfig?.approvalRequired,
  model: socialBrainConfig?.model,
  responseStyle: socialBrainConfig?.responseStyle,
});

const socialHandoff = new HandoffManager({
  repository: socialRepository,
  preferredChannel: socialBrainConfig?.handoff?.preferredChannel,
});

const commentRuleEngine = new CommentRuleEngine({
  repository: socialRepository,
});

// Wire DM dispatcher into comment rule engine
const dmDispatcher = localServerManager
  ? new DmDispatcher({ localServerManager })
  : undefined;
if (dmDispatcher) {
  commentRuleEngine.setSendDm(dmDispatcher.createDmSender());
  commentRuleEngine.setReplyToComment(dmDispatcher.createCommentReplier());
}

// Wire ingestion → brain → handoff pipeline
socialIngestion.on("message", ({ message, contact, raw }) => {
  void (async () => {
    try {
      const result = await socialBrain.process(contact, message, raw);
      if (result?.shouldEscalate) {
        await socialHandoff.escalate(
          contact,
          {
            brainConfidence: result.confidence,
            brainIntent: result.intent,
            ragChunksUsed: result.ragChunksUsed,
            conversationHistory: socialRepository.getMessages(contact.id, 5),
            triggerReason: "low_confidence",
          },
          raw,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SocialBrain] Message processing pipeline failed: ${msg}`);
      io.emit("social:brain_error", {
        error: msg,
        platform: raw.platform,
        contactId: contact.id,
      });
    }
  })();
});

socialIngestion.on("comment", (comment) => {
  void (async () => {
    try {
      const matchedRuleIds = await commentRuleEngine.evaluate(comment);
      // If no keyword rules matched and comment-brain is enabled, route through Brain
      if (
        matchedRuleIds.length === 0 &&
        socialBrainConfig?.commentBrainEnabled
      ) {
        await socialBrain.processComment(comment);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SocialBrain] Comment processing pipeline failed: ${msg}`);
      io.emit("social:brain_error", {
        error: msg,
        platform: comment.platform,
        commentId: comment.commentId,
      });
    }
  })();
});

// Start polling for poll-based and browser-based platform adapters
if (socialBrainConfig?.connections) {
  for (const [platform, conn] of Object.entries(
    socialBrainConfig.connections,
  )) {
    if (
      conn?.enabled &&
      (conn?.mode === "polling" || conn?.mode === "browser") &&
      socialIngestion
        .getRegisteredPlatforms()
        .includes(
          platform as import("./channels/social/types.js").SocialPlatform,
        )
    ) {
      // YouTube has a very tight daily quota (10,000 units); default to 1-hour
      // polling to stay well under budget.  Browser mode uses 30 minutes for
      // anti-detection.  All other API platforms default to 2 minutes.
      const defaultInterval =
        conn.mode === "browser" ? 1800 : platform === "youtube" ? 3600 : 120;
      const interval = conn.pollIntervalSeconds ?? defaultInterval;
      socialIngestion.startPolling(
        platform as import("./channels/social/types.js").SocialPlatform,
        interval,
      );
    }
  }
}

// Forward new user messages to active handoff threads
socialBrain.on(
  "escalated_message",
  ({
    contact,
    raw,
  }: {
    contact: import("./channels/social/types.js").Contact;
    raw: { text: string };
  }) => {
    void socialHandoff.forwardToThread(contact, raw.text).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SocialBrain] Failed to forward escalated message: ${msg}`);
    });
  },
);

const trimWorker = new TrimWorker();
const analyzeWorker = new AnalyzeWorker({
  chat: (prompt, options) => {
    return copilot.chat(prompt, {
      tools: [],
      attachments: options?.attachments,
      model: options?.model,
    });
  },
  audioSidecarUrl:
    process.env.OPENZIGS_AUDIO_SIDECAR_URL ?? "http://localhost:5006",
});

// ── Video Pipeline Modules (Epic #817) ──
const clipExtractor = new ClipExtractor({
  chat: (prompt, options) => {
    return copilot.chat(prompt, {
      tools: [],
      attachments: options?.attachments,
      model: options?.model,
    });
  },
  audioSidecarUrl:
    process.env.OPENZIGS_AUDIO_SIDECAR_URL ?? "http://localhost:5006",
});
const reframeWorker = new ReframeWorker({
  chat: (prompt, options) => {
    return copilot.chat(prompt, {
      tools: [],
      attachments: options?.attachments,
      model: options?.model,
    });
  },
});
const audioCleaner = new AudioCleaner({
  audioSidecarUrl:
    process.env.OPENZIGS_AUDIO_SIDECAR_URL ?? "http://localhost:5006",
});
const brollPipeline = new BRollPipeline({
  chat: (prompt, options) => {
    return copilot.chat(prompt, {
      tools: [],
      model: options?.model,
    });
  },
  audioSidecarUrl:
    process.env.OPENZIGS_AUDIO_SIDECAR_URL ?? "http://localhost:5006",
});
const brandTemplateRepo = new BrandTemplateRepository(db);
brandTemplateRepo.migrate();
const analyticsCache = new AnalyticsCache(db);
analyticsCache.migrate();
const analyticsAggregator = new AnalyticsAggregator(analyticsCache);

// Always include ~/.openzigs/seo-reports so the write-file tool can save
// enhanced reports even when OPENZIGS_ALLOWED_DIRS is restricted.
const mcpAllowedDirs = Array.from(
  new Set([
    ...(allowedDirs.length > 0
      ? allowedDirs
      : [PROJECT_ROOT, os.tmpdir(), os.homedir(), "/tmp", "/private/tmp"]),
    expandTilde("~/.openzigs/seo-reports"),
  ]),
);

registerMcpTools(toolRegistry, {
  allowedDirs: mcpAllowedDirs,
  shellAllowlist: (
    process.env.OPENZIGS_SHELL_ALLOWLIST ??
    "git,find,ls,cat,head,tail,grep,wc,echo,pwd,mkdir,cp,mv,rm,which,date,curl,bash,sh,java,javac,python3,node,pip,brew"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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
  markitdownSidecarUrl: resolveSidecarUrl(
    "markitdown",
    "MCP_MARKITDOWN_URL",
    5301,
  ),
  gmailSidecarUrl: resolveSidecarUrl("gmail", "MCP_GMAIL_URL", 5302),
  databaseSidecarUrl: resolveSidecarUrl("database", "MCP_DATABASE_URL", 5303),
  githubSidecarUrl: resolveSidecarUrl("github", "MCP_GITHUB_URL", 5304),
  githubToken: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
  localServerManager,
  knowledgeService,
  vaultService,
  voiceService,
  socialRepository,
  socialHandoffManager: socialHandoff,
  mediaQueueRepo,
  queueMaster,
  channelManager,
  notificationChatId: config.channels?.telegram?.adminUserId || undefined,
  discordNotificationChannelId:
    config.channels?.discord?.notificationChannelId || undefined,
  audioSidecarUrl: resolveSidecarUrl("audio", "AUDIO_SIDECAR_URL", 5006),
  trimWorker,
  analyzeWorker,
  memoryManager,
  outboxRepo,
  tasksConfig: config.tasks,
  imageProcessingSidecarUrl: resolveSidecarUrl(
    "image-processing",
    "IMAGE_PROCESSING_SIDECAR_URL",
    5010,
  ),
  brandKitRepo,
  postTemplateRepo,
  clipExtractor,
  reframeWorker,
  audioCleaner,
  brollPipeline,
});

// ── Task Background Worker ──
const maxConcurrent = config.tasks?.maxConcurrent ?? 2;
const taskWorker = new TaskWorker({
  engine: taskEngine,
  copilot,
  maxConcurrent,
  taskRepository,
  customAgentsConfig: resolvedCustomAgents,
});
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
  knowledgeService,
});

// ── Webhook Manager (SQLite-backed) ──
const webhookRepo = new WebhookRepository(db);
webhookRepo.migrate();
const webhookManager = new WebhookManager(webhookRepo);

// Model API routes
const modelsRouter = createModelsRouter({ copilot });
app.use("/api/models", authMiddleware, modelsRouter);

// System info routes (GPU profile, recommended model tier, coordinator state)
app.use(
  "/api/system",
  authMiddleware,
  createSystemRouter({
    coordinator: gpuCoordinator,
    dispatcher: gpuDispatcher,
  }),
);

// Setup API routes — no auth required (needed before auth is configured)
app.use("/api/setup", setupRouter);

// Pipeline Template Manager
const pipelineTemplateManager = new PipelineTemplateManager(
  path.join(import.meta.dirname, "..", "config", "pipeline-templates.json"),
);
await pipelineTemplateManager.load();

// Admin API routes — gated behind auth
const adminRouter = createAdminRouter({
  toolRegistry,
  sidecarManager,
  localServerManager,
  promptManager,
  scheduler,
  personalityManager,
  sessionManager,
  copilot,
  taskWorker,
  taskEngine,
  webhookManager,
  customPostActionManager,
  sentinel,
  knowledgeService,
  brandVoiceService,
  pipelineTemplateManager,
  socialBrain,
  videoPresetsRepo,
});

// Bug #1064-#6a: the cost-summary route must be mounted BEFORE the main
// adminRouter. adminRouter declares `/sessions/:id` which would otherwise
// swallow `cost-summary` as a session id and return
// `{"error":"Session not found: cost-summary"}` (404). Keeping this mount
// ahead of adminRouter preserves the public `/api/admin/sessions/cost-summary`
// URL the UI depends on. The wrapper hookup + bootstrap happens later, where
// the rest of the local-llm wiring lives.
const costMeter = new CostMeter({ db, auditLogger });
app.use("/api/admin", authMiddleware, createSessionCostsRouter({ costMeter }));
app.use("/api/admin", authMiddleware, adminRouter);

// vLLM admin routes (Epic #888 / Issue #922) — kept out of admin.ts.
const vllmAdminRouter = createVllmAdminRouter({ coordinator: gpuCoordinator });
app.use("/api/admin/gpu/vllm", authMiddleware, vllmAdminRouter);

// GPU dispatcher admin routes (Epic #1053 / Issue #1056, #1060) — cancel
// in-flight jobs + clear poisoned lanes from the admin UI.
app.use(
  "/api/admin/gpu/dispatcher",
  authMiddleware,
  createGpuDispatcherAdminRouter({
    dispatcher: gpuDispatcher,
    auditLogger,
  }),
);

// Local LLM admin routes (Epic #1053 / Issues #1057, #1058) — kept out of admin.ts.
const localLlmConfigPath =
  process.env.OPENZIGS_CONFIG_PATH ??
  path.join(os.homedir(), ".openzigs", "config.json");
// First-launch: idempotently generate a vLLM API key with 0o600 perms.
ensureVllmApiKey(localLlmConfigPath).catch((err) => {
  logger.warn("Failed to ensure vLLM API key on startup", {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Local-endpoint health monitor (#1055) — only spun up when a local-copilot
// provider is configured. We instantiate lazily in the router by checking
// config on each /status read; a long-running poller is started here only if
// the user already has a provider on disk so /status is meaningful from t=0.
let localEndpointHealthMonitor: LocalEndpointHealthMonitor | undefined;
try {
  const cfgRaw = await fs
    .readFile(localLlmConfigPath, "utf-8")
    .catch(() => "{}");
  const cfgParsed = JSON.parse(cfgRaw) as {
    localLlm?: {
      provider?: { endpoint?: string; apiKey?: string } | null;
      privacyMode?: { globalLockdown?: boolean };
    };
    sentinel?: {
      localLlmHealth?: {
        enabled?: boolean;
        intervalMs?: number;
        failoverThreshold?: number;
        failoverWindowMs?: number;
        failbackSuccesses?: number;
        probeTimeoutMs?: number;
      };
    };
  };
  const provider = cfgParsed.localLlm?.provider;
  const healthCfg = cfgParsed.sentinel?.localLlmHealth ?? {};
  if (provider?.endpoint && healthCfg.enabled !== false) {
    localEndpointHealthMonitor = new LocalEndpointHealthMonitor({
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      intervalMs: healthCfg.intervalMs,
      failoverThreshold: healthCfg.failoverThreshold,
      failoverWindowMs: healthCfg.failoverWindowMs,
      failbackSuccesses: healthCfg.failbackSuccesses,
      probeTimeoutMs: healthCfg.probeTimeoutMs,
      auditLogger,
      isPrivacyLocked: () =>
        Boolean(cfgParsed.localLlm?.privacyMode?.globalLockdown),
    });
    localEndpointHealthMonitor.start();
    localEndpointHealthMonitor.on("failover", (info) => {
      io.emit("sentinel:local-endpoint-failover", info);
    });
    localEndpointHealthMonitor.on("failback", (info) => {
      io.emit("sentinel:local-endpoint-failback", info);
    });
  }
} catch (err) {
  logger.warn("Failed to bootstrap LocalEndpointHealthMonitor", {
    error: err instanceof Error ? err.message : String(err),
  });
}

const localLlmRouter = createLocalLlmRouter({
  configPath: localLlmConfigPath,
  auditLogger,
  healthMonitor: localEndpointHealthMonitor,
  // Phase 3.5: keep the wrapper's smart-router runtime config in sync with
  // POST /api/admin/local-llm/router so admin toggle/threshold changes apply
  // without a server restart.
  onSmartRouterChanged: (cfg) => {
    copilot.setSmartRouterConfig(cfg);
  },
});
app.use("/api/admin/local-llm", authMiddleware, localLlmRouter);

// Per-session cost meter (Epic #1053 / Issue #1059) — tracks model spend +
// "would have cost" against the GitHub Copilot pricing table. The meter
// fetches the live pricing table at startup with a hardcoded fallback for
// air-gapped installs. The instance is created earlier so the
// /sessions/cost-summary route can be mounted before adminRouter; here we
// just wire it into the copilot wrapper.
// Phase 3.5: hand the meter + audit logger to the wrapper so every call's
// router decision and cost row is recorded automatically.
copilot.setCostMeter(costMeter);
copilot.setAuditLogger(auditLogger);
// Bootstrap dual-provider state from disk so smart-router routing kicks in
// immediately if the user has a local provider configured + a cloud provider
// in copilot config.
try {
  const cfgRaw = await fs
    .readFile(localLlmConfigPath, "utf-8")
    .catch(() => "{}");
  const cfgParsed = JSON.parse(cfgRaw) as {
    localLlm?: {
      provider?: {
        type?: string;
        endpoint?: string;
        model?: string;
        apiKey?: string;
        timeoutMs?: number;
      } | null;
      privacyMode?: { globalLockdown?: boolean };
      smartRouter?: { enabled?: boolean; cloudThresholdTokens?: number };
    };
  };
  const localProvider = cfgParsed.localLlm?.provider;
  if (localProvider?.endpoint && localProvider.model) {
    copilot.setLocalProvider({
      type: "local-copilot",
      endpoint: localProvider.endpoint,
      model: localProvider.model,
      apiKey: localProvider.apiKey,
      timeoutMs: localProvider.timeoutMs,
    });
  }
  // The configured `provider` field on the wrapper acts as the cloud counterpart.
  // (config.copilot.provider's type union excludes local-copilot at the schema layer.)
  if (config.copilot?.provider) {
    copilot.setCloudProvider(config.copilot.provider);
  }
  if (cfgParsed.localLlm?.privacyMode?.globalLockdown) {
    copilot.setPrivacyMode("global");
  }
  const sr = cfgParsed.localLlm?.smartRouter;
  if (sr) {
    copilot.setSmartRouterConfig({
      enabled: sr.enabled ?? true,
      cloudThresholdTokens: sr.cloudThresholdTokens ?? 4096,
    });
  }
} catch (err) {
  logger.warn("Smart router bootstrap from local-llm config failed", {
    error: err instanceof Error ? err.message : String(err),
  });
}
// Best-effort live pricing fetch on startup; failure is silent and the meter
// keeps the bundled fallback. Re-fetched periodically by the meter is left
// for a follow-up — startup-only is enough for v1.
void (async () => {
  try {
    const cfgRaw = await fs
      .readFile(localLlmConfigPath, "utf-8")
      .catch(() => "{}");
    const cfgParsed = JSON.parse(cfgRaw) as {
      localLlm?: {
        costMeter?: {
          enabled?: boolean;
          fetchLivePricing?: boolean;
          pricingUrl?: string;
        };
      };
    };
    const costCfg = cfgParsed.localLlm?.costMeter ?? {};
    if (costCfg.enabled === false || costCfg.fetchLivePricing === false) return;
    const table = await fetchPricingTable({ url: costCfg.pricingUrl });
    costMeter.setPricing(table);
    logger.info("Copilot pricing table loaded", {
      source: table.source,
      version: table.version,
      fetchedAt: table.fetchedAt,
    });
  } catch (err) {
    logger.warn("Cost meter pricing init failed; using bundled fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
})();
// Note: createSessionCostsRouter is mounted earlier (before adminRouter) to
// avoid the `/sessions/:id` route in adminRouter swallowing `cost-summary`.
// See Bug #1064-#6a above.

// Knowledge Base API routes
const knowledgeRouter = createKnowledgeRouter({ knowledgeService });
app.use("/api/admin/knowledge", authMiddleware, knowledgeRouter);

// Orchestration Template API routes
const orchestrationRouter = createOrchestrationRouter({
  templateService: orchTemplateService,
});
app.use("/api/admin/orchestration", authMiddleware, orchestrationRouter);

// Social Brain API routes
const socialRouter = createSocialRouter({
  repository: socialRepository,
  ingestion: socialIngestion,
  brain: socialBrain,
  handoff: socialHandoff,
  ruleEngine: commentRuleEngine,
  config: socialBrainConfig,
  brandVoiceService,
  copilot,
  dmDispatcher,
});

// Social webhook routes are PUBLIC — no auth middleware.
// External platforms (Twitter CRC, Meta hub challenge) call these without auth headers.
// MUST be registered before the auth-gated /api/social mount.
// Raw body capture for HMAC signature verification (global parser skips this prefix).
app.use(
  "/api/social/webhooks",
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  }),
);

const webhookSecrets = {
  twitter:
    (
      process.env.TWITTER_API_SECRET ??
      process.env.TWITTER_CONSUMER_SECRET ??
      ""
    ).trim() || undefined,
  meta: (process.env.FACEBOOK_APP_SECRET ?? "").trim() || undefined,
};

app.get("/api/social/webhooks/:platform", (req, res) => {
  const { platform } = req.params;

  // Twitter CRC check: GET ?crc_token=NONCE → JSON { response_token: "sha256=HMAC" }
  const crcToken = req.query.crc_token;
  if (typeof crcToken === "string") {
    const apiSecret =
      process.env.TWITTER_API_SECRET ?? process.env.TWITTER_CONSUMER_SECRET;
    if (!apiSecret) {
      logger.warn(
        "[Social] Twitter CRC received but TWITTER_API_SECRET not configured",
      );
      res.status(503).json({ error: "Webhook not configured" });
      return;
    }
    const hmac = createHmac("sha256", apiSecret)
      .update(crcToken)
      .digest("base64");
    logger.info(`[Social] Twitter CRC verification for ${platform}`);
    res.status(200).json({ response_token: `sha256=${hmac}` });
    return;
  }

  // Meta hub challenge (Instagram, Facebook): GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN;
  if (
    mode === "subscribe" &&
    token &&
    challenge &&
    verifyToken &&
    token === verifyToken
  ) {
    logger.info(`[Social] Meta webhook verification for ${platform}`);
    res.type("text/plain").status(200).send(String(challenge));
    return;
  }

  res.status(403).send("Forbidden");
});

app.post("/api/social/webhooks/:platform", (req, res) => {
  const platform = req.params.platform as Parameters<
    typeof socialIngestion.handleWebhook
  >[0];
  const rawBody = (req as unknown as Record<string, unknown>).rawBody as
    | Buffer
    | undefined;

  // Verify webhook payload signature when a secret is configured for this platform.
  if (rawBody) {
    const result = verifyWebhookSignature(
      platform,
      rawBody,
      req.headers,
      webhookSecrets,
    );
    if (result === false) {
      logger.warn(
        `[Social] Webhook signature verification failed for ${platform}`,
      );
      res.status(403).json({ error: "Invalid webhook signature" });
      return;
    }
    // result === null means no secret configured — allow through with a one-time warning
    // result === true means signature verified
  }

  try {
    void socialIngestion.handleWebhook(
      platform,
      req.body as Record<string, unknown>,
      req.headers as Record<string, string>,
    );
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error(
      `[Social] Webhook error (${platform}): ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

app.use("/api/social", authMiddleware, socialRouter);

// Social analytics (advanced aggregation + time-series + CSV export)
const socialAnalyticsRouter = createSocialAnalyticsRouter({
  socialRepo: socialRepository,
  db,
});
app.use("/api/social/analytics/v2", authMiddleware, socialAnalyticsRouter);

// Pinterest OAuth callback — no auth middleware (redirected from Pinterest)
// MUST be registered before the /api/pinterest router mount to avoid auth middleware intercept
app.get("/api/pinterest/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    logger.warn(`Pinterest OAuth denied: ${error}`);
    return res.redirect(
      `${uiOrigin}/admin?pinterest_oauth=error&message=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !state) {
    return res.redirect(
      `${uiOrigin}/admin?pinterest_oauth=error&message=${encodeURIComponent("Missing code or state")}`,
    );
  }

  // Validate CSRF state
  if (!pinterestOAuthStates.has(state)) {
    logger.warn("Pinterest OAuth state mismatch — possible CSRF");
    return res.redirect(
      `${uiOrigin}/admin?pinterest_oauth=error&message=${encodeURIComponent("Invalid state parameter")}`,
    );
  }
  pinterestOAuthStates.delete(state);

  const result = await exchangePinterestCode(code);
  if (!result.ok) {
    logger.error(`Pinterest OAuth token exchange failed: ${result.error}`);
    return res.redirect(
      `${uiOrigin}/admin?pinterest_oauth=error&message=${encodeURIComponent(result.error ?? "Token exchange failed")}`,
    );
  }

  // Auto-create the daily Pinterest job now that we have a token
  ensurePinterestScheduledJob(scheduler, promptManager);

  logger.info("Pinterest OAuth flow completed successfully");
  return res.redirect(`${uiOrigin}/admin?pinterest_oauth=success`);
});

// LinkedIn OAuth callback — no auth middleware (redirected from LinkedIn)
app.get("/api/linkedin/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    const desc =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : error;
    logger.warn(`LinkedIn OAuth denied: ${desc}`);
    return res.redirect(
      `${uiOrigin}/admin?linkedin_oauth=error&message=${encodeURIComponent(desc)}`,
    );
  }

  if (!code || !state) {
    return res.redirect(
      `${uiOrigin}/admin?linkedin_oauth=error&message=${encodeURIComponent("Missing code or state")}`,
    );
  }

  // Validate CSRF state
  if (!linkedinOAuthStates.has(state)) {
    logger.warn("LinkedIn OAuth state mismatch — possible CSRF");
    return res.redirect(
      `${uiOrigin}/admin?linkedin_oauth=error&message=${encodeURIComponent("Invalid state parameter")}`,
    );
  }
  linkedinOAuthStates.delete(state);

  const result = await exchangeLinkedInCode(code);
  if (!result.ok) {
    logger.error(`LinkedIn OAuth token exchange failed: ${result.error}`);
    return res.redirect(
      `${uiOrigin}/admin?linkedin_oauth=error&message=${encodeURIComponent(result.error ?? "Token exchange failed")}`,
    );
  }

  logger.info("LinkedIn OAuth flow completed successfully");
  return res.redirect(`${uiOrigin}/admin?linkedin_oauth=success`);
});

// YouTube/Google OAuth callback — no auth middleware (redirected from Google)
app.get("/api/youtube/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    const desc =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : error;
    logger.warn(`YouTube OAuth denied: ${desc}`);
    return res.redirect(
      `${uiOrigin}/admin?youtube_oauth=error&message=${encodeURIComponent(desc)}`,
    );
  }

  if (!code || !state) {
    return res.redirect(
      `${uiOrigin}/admin?youtube_oauth=error&message=${encodeURIComponent("Missing code or state")}`,
    );
  }

  // Validate CSRF state
  if (!youtubeOAuthStates.has(state)) {
    logger.warn("YouTube OAuth state mismatch — possible CSRF");
    return res.redirect(
      `${uiOrigin}/admin?youtube_oauth=error&message=${encodeURIComponent("Invalid state parameter")}`,
    );
  }
  youtubeOAuthStates.delete(state);

  const result = await exchangeYouTubeCode(code);
  if (!result.ok) {
    logger.error(`YouTube OAuth token exchange failed: ${result.error}`);
    return res.redirect(
      `${uiOrigin}/admin?youtube_oauth=error&message=${encodeURIComponent(result.error ?? "Token exchange failed")}`,
    );
  }

  logger.info("YouTube OAuth flow completed successfully");

  // Restart the YouTube MCP subprocess so it picks up the new YOUTUBE_OAUTH_TOKEN.
  // The Python process reads env vars at spawn time — updating process.env alone is not enough.
  if (localServerManager) {
    localServerManager.restartServer("youtube").catch((err: unknown) => {
      logger.warn(
        `Failed to restart YouTube MCP server after OAuth: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  return res.redirect(`${uiOrigin}/admin?youtube_oauth=success`);
});

// TikTok OAuth callback — no auth middleware (redirected from TikTok)
app.get("/api/tiktok/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    const desc =
      typeof req.query.error_description === "string"
        ? req.query.error_description
        : error;
    logger.warn(`TikTok OAuth denied: ${desc}`);
    return res.redirect(
      `${uiOrigin}/admin?tiktok_oauth=error&message=${encodeURIComponent(desc)}`,
    );
  }

  if (!code || !state) {
    return res.redirect(
      `${uiOrigin}/admin?tiktok_oauth=error&message=${encodeURIComponent("Missing code or state")}`,
    );
  }

  // Validate CSRF state and retrieve PKCE code_verifier
  const oauthEntry = tiktokOAuthStates.get(state);
  if (!oauthEntry) {
    logger.warn("TikTok OAuth state mismatch — possible CSRF");
    return res.redirect(
      `${uiOrigin}/admin?tiktok_oauth=error&message=${encodeURIComponent("Invalid state parameter")}`,
    );
  }
  const { codeVerifier } = oauthEntry;
  tiktokOAuthStates.delete(state);

  const result = await exchangeTikTokCode(code, codeVerifier);
  if (!result.ok) {
    logger.error(`TikTok OAuth token exchange failed: ${result.error}`);
    return res.redirect(
      `${uiOrigin}/admin?tiktok_oauth=error&message=${encodeURIComponent(result.error ?? "Token exchange failed")}`,
    );
  }

  logger.info("TikTok OAuth flow completed successfully");
  return res.redirect(`${uiOrigin}/admin?tiktok_oauth=success`);
});

// Pinterest Reports API routes (after callback so it doesn't intercept the OAuth redirect)
const pinterestRouter = createPinterestRouter({ copilotWrapper: copilot });
app.use("/api/pinterest", authMiddleware, pinterestRouter);

// Vault API routes
const vaultRouter = createVaultRouter({ vaultService });
app.use("/api/admin/vault", authMiddleware, vaultRouter);

// Integrations API routes
const integrationsRouter = createIntegrationsRouter({ vaultService });
app.use("/api/admin/integrations", authMiddleware, integrationsRouter);

// Outbox API routes
const outboxRouter = createOutboxRouter({
  outboxRepo,
  copilotWrapper: copilot,
  mediaQueueRepo,
  taskEngine,
});
app.use("/api/admin/outbox", authMiddleware, outboxRouter);

// Memory API routes
const memoryRouter = createMemoryRouter({ memoryManager });
app.use("/api/admin/memory", authMiddleware, memoryRouter);

// Director Mode API routes
const directorConfig = (config as Record<string, unknown>).director as
  | {
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
    }
  | undefined;

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
  brandVoiceService,
  toolRegistry,
  config: {
    enabled: directorConfig?.enabled ?? true,
    outputDir: expandTilde(
      directorConfig?.outputDir ?? "~/.openzigs/video-output",
    ),
    defaultTemplate: directorConfig?.defaultTemplate ?? "Minimalist",
    assets: {
      localLibraryPath: expandTilde(
        directorConfig?.assets?.localLibraryPath ?? "~/.openzigs/media-library",
      ),
      downloadCachePath: expandTilde(
        directorConfig?.assets?.downloadCachePath ?? "~/.openzigs/asset-cache",
      ),
      pixabayApiKey: directorConfig?.assets?.pixabayApiKey ?? "",
      jamendoClientId: directorConfig?.assets?.jamendoClientId ?? "",
      pexelsApiKey: directorConfig?.assets?.pexelsApiKey ?? "",
    },
  },
});
app.use("/api/admin/director", authMiddleware, directorRouter);

// Epic #951 (Studio Pitch) Phase 3 — REST router for decks/slides/brand kits.
const pitchRouter = createPitchRouter({
  pitchRepo,
  brandKitRepo,
  copilot,
  taskEngine,
  mediaQueueRepo,
  shareTokenRepo,
  auditLogger,
});
app.use("/api/admin/pitch", authMiddleware, pitchRouter);

// Epic #990 sub-issue #1000 — PUBLIC share-link router. Mounted OUTSIDE the
// admin auth chain so unauthenticated visitors can hit `/p/:token`. The
// router applies its own per-IP rate limit and returns generic 404s for
// every failure mode to prevent token enumeration.
const publicShareRouter = createPublicShareRouter({
  pitchRepo,
  brandKitRepo,
  shareTokenRepo,
  auditLogger,
});
app.use("/p", publicShareRouter);

// ── Render → Knowledge ingestion hook + DB persistence ──
// After each successful render: persist the output path so it survives
// restarts, then ingest the narration text into the knowledge base.
if (renderOrchestrator) {
  renderOrchestrator.on(
    "render:complete",
    async (result: { jobId: string; outputPath: string | null }) => {
      try {
        const db = getDatabase();
        const now = new Date().toISOString();

        // Persist output_path to director_renders so it survives server restarts.
        if (result.outputPath) {
          db.prepare(
            `UPDATE director_renders SET output_path = ?, status = 'complete', updated_at = ? WHERE job_id = ?`,
          ).run(result.outputPath, now, result.jobId);

          // Register the rendered video in the media gallery so it shows up under Videos.
          let directorAssetId: string | undefined;
          try {
            const alreadyIndexed = mediaQueueRepo
              .listAssets({ type: "video", source: "director" })
              .some((a) => a.file_path === result.outputPath);
            if (!alreadyIndexed) {
              const fileStat = statSync(result.outputPath);
              const filename = path.basename(result.outputPath);
              const draftRow = db
                .prepare(
                  `SELECT d.title FROM director_renders r JOIN director_drafts d ON d.id = r.draft_id WHERE r.job_id = ?`,
                )
                .get(result.jobId) as { title: string } | undefined;
              directorAssetId = mediaQueueRepo.createAsset({
                type: "video",
                filename,
                filePath: result.outputPath,
                mimeType: "video/mp4",
                fileSizeBytes: fileStat.size,
                prompt: draftRow?.title,
                source: "director",
                jobId: result.jobId,
              });
              logger.info(
                `[Director] Registered render ${result.jobId} in gallery (${filename}, asset ${directorAssetId})`,
              );
            }
          } catch (galleryErr) {
            logger.warn(
              `[Director] Failed to register render in gallery: ${galleryErr instanceof Error ? galleryErr.message : String(galleryErr)}`,
            );
          }

          // If gallery asset was created, use ingestAsset for full AI analysis
          // (Whisper transcription + vision keyframes). Otherwise fall back to narration text.
          if (directorAssetId) {
            const draftRow = db
              .prepare(
                `SELECT d.title FROM director_renders r JOIN director_drafts d ON d.id = r.draft_id WHERE r.job_id = ?`,
              )
              .get(result.jobId) as { title: string } | undefined;
            void knowledgeService
              .ingestAsset({
                id: directorAssetId,
                type: "video",
                filename: path.basename(result.outputPath),
                filePath: result.outputPath,
                prompt: draftRow?.title,
                source: "director",
                tags: ["director"],
                visibility: "internal",
                category: "media",
              })
              .catch((err) => {
                logger.warn(
                  `[Director] Knowledge ingest via asset failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            logger.info(
              `[Director] Ingested render via gallery asset for ${result.jobId}`,
            );
            return;
          }
        }

        const row = db
          .prepare(
            `SELECT d.id, d.title, d.manifest
           FROM director_renders r
           JOIN director_drafts d ON d.id = r.draft_id
           WHERE r.job_id = ?`,
          )
          .get(result.jobId) as
          | { id: string; title: string; manifest: string }
          | undefined;

        if (!row) return;

        const manifest = JSON.parse(row.manifest) as {
          projectTitle?: string;
          timeline?: Array<{ narration?: string; title?: string }>;
        };

        const narrationLines = (manifest.timeline ?? [])
          .map((s) => s.narration ?? s.title ?? "")
          .filter(Boolean);

        if (narrationLines.length === 0) return;

        const text = `Video: ${row.title}\n\n${narrationLines.join("\n\n")}`;
        await knowledgeService.ingestText(`render:${row.id}`, row.title, text, {
          visibility: "internal",
          category: "media",
        });
        logger.info(
          `[Director] Ingested render knowledge for draft "${row.title}"`,
        );
      } catch (err) {
        logger.warn(
          `[Director] Failed to ingest render knowledge: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  renderOrchestrator.on(
    "render:failed",
    (evt: { jobId: string; error: string }) => {
      try {
        const db = getDatabase();
        db.prepare(
          `UPDATE director_renders SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?`,
        ).run(evt.error, new Date().toISOString(), evt.jobId);
        logger.info(`[Director] Render ${evt.jobId} marked failed in DB`);
      } catch (err) {
        logger.warn(
          `[Director] Failed to persist render failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

const audioRouterInstance = createAudioRouter({
  db: getDatabase(),
  sidecarUrl: config.voice?.sidecarUrl ?? "http://127.0.0.1:5006",
});
app.use("/api/admin/audio", authMiddleware, audioRouterInstance);

// ── Presenter Mode Router (Issue #275) ──
const presentationRepo = new PresentationRepository(db);
const teacherAgent = new TeacherAgent({
  copilotWrapper: copilot,
  presentationRepo,
  knowledgeService,
});
const quizGenerator = new QuizGenerator({
  copilotWrapper: copilot,
  presentationRepo,
});

// Resolve invite secret: use config value, or auto-generate and persist
let presenterInviteSecret = config.presenter?.inviteSecret ?? "";
if (!presenterInviteSecret) {
  presenterInviteSecret = randomBytes(32).toString("hex");
  logger.info("Auto-generated presenter invite secret — persisting to config");
  // Persist so the secret survives restarts and can be shared with the UI
  const cfgPath =
    process.env.OPENZIGS_CONFIG_PATH ??
    path.join(os.homedir(), ".openzigs", "config.json");
  (async () => {
    try {
      await fs.mkdir(path.dirname(cfgPath), secureDirOptions());
      let userCfg: Record<string, unknown> = {};
      try {
        userCfg = JSON.parse(await fs.readFile(cfgPath, "utf-8"));
      } catch {
        /* new file */
      }
      const presenter =
        userCfg.presenter && typeof userCfg.presenter === "object"
          ? (userCfg.presenter as Record<string, unknown>)
          : {};
      presenter.inviteSecret = presenterInviteSecret;
      userCfg.presenter = presenter;
      await fs.writeFile(
        cfgPath,
        JSON.stringify(userCfg, null, 2),
        secureWriteOptions(),
      );
      logger.info("Persisted presenter invite secret to config");
    } catch (err) {
      logger.warn(
        `Failed to persist invite secret: ${err instanceof Error ? err.message : err}`,
      );
    }
  })();
}

const presenterBaseUrl = config.presenter?.baseUrl ?? uiOrigin;
const presenterRouter = createPresenterRouter({
  presentationRepo,
  teacherAgent,
  quizGenerator,
  voiceService,
  copilotWrapper: copilot,
  knowledgeService,
  inviteSecret: presenterInviteSecret,
  baseUrl: presenterBaseUrl,
});
app.use("/api/presentations", authMiddleware, presenterRouter);

// ── Public Invite Redeem Route (no auth required) — Issue #283 ──
app.get("/api/invite/redeem", async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Missing token parameter" });
    return;
  }

  try {
    const secretKey = new TextEncoder().encode(presenterInviteSecret);
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
    });

    const presentationId = payload.presentationId as string | undefined;
    if (!presentationId || payload.role !== "guest") {
      res.status(401).json({ error: "Invalid invite token" });
      return;
    }

    // Compute max-age from JWT exp
    const exp = payload.exp ?? 0;
    const maxAge = Math.max(exp - Math.floor(Date.now() / 1000), 0);

    // Detect if request arrived over HTTPS (directly or via reverse proxy)
    const isSecure =
      req.protocol === "https" || req.get("x-forwarded-proto") === "https";

    // Set HttpOnly cookie for auth
    res.cookie("guest_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: maxAge * 1000,
      secure: isSecure,
    });

    // Set non-HttpOnly cookie for client-side guest detection
    res.cookie("is_guest", "true", {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: maxAge * 1000,
      secure: isSecure,
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
// When Director Mode finishes rendering, auto-index the presentation into SQLite
// and register the rendered video in the media gallery.
renderOrchestrator.on(
  "render:complete",
  (result: {
    jobId: string;
    outputPath: string | null;
    durationSec: number | null;
  }) => {
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
        const thumbnailPath = await generateThumbnail(
          result.outputPath!,
          result.jobId,
          durationSec,
        );

        // Build script segments from image_scene voiceovers in the timeline
        const scriptSegments = manifest.timeline
          .filter((e) => e.type === "image_scene" || e.type === "title_card")
          .map((e) => ({
            text:
              e.type === "title_card"
                ? e.title
                : ((e as { scriptText?: string }).scriptText ?? ""),
            startTime: e.startAtFrame / fps,
            endTime: (e.startAtFrame + e.duration) / fps,
          }));

        // Compute quiz config if applicable
        const quizConfig =
          chapters.length > 1 ? computeQuizTimestamps(chapters) : null;

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
            logger.warn(
              `[PresenterIngestion] Quiz pre-generation failed for ${inserted.id}: ${msg}`,
            );
          });
        }

        // Register the presentation video in the media gallery (source: "director")
        let galleryAssetId: string | undefined;
        try {
          const alreadyIndexed = mediaQueueRepo
            .listAssets({ type: "video", source: "director" })
            .some((a) => a.file_path === result.outputPath);
          if (!alreadyIndexed) {
            const fileStat = statSync(result.outputPath!);
            galleryAssetId = mediaQueueRepo.createAsset({
              type: "video",
              filename: path.basename(result.outputPath!),
              filePath: result.outputPath!,
              mimeType: "video/mp4",
              fileSizeBytes: fileStat.size,
              durationSeconds: durationSec || undefined,
              prompt: inserted.title,
              source: "director",
              tags: ["presentation", mode],
            });
            logger.info(
              `[PresenterIngestion] Registered presentation "${inserted.title}" in gallery (asset ${galleryAssetId})`,
            );
          }
        } catch (galleryErr) {
          logger.warn(
            `[PresenterIngestion] Failed to register in gallery: ${galleryErr instanceof Error ? galleryErr.message : String(galleryErr)}`,
          );
        }

        // Ingest into knowledge — if we have a gallery asset, use ingestAsset for full
        // AI analysis (Whisper transcription + vision keyframes). Otherwise fall back to
        // plain transcript text.
        if (galleryAssetId) {
          void knowledgeService
            .ingestAsset({
              id: galleryAssetId,
              type: "video",
              filename: path.basename(result.outputPath!),
              filePath: result.outputPath!,
              prompt: inserted.title,
              source: "director",
              durationSeconds: durationSec || undefined,
              tags: ["presentation", mode],
              visibility: "internal",
              category: "media",
            })
            .catch((error) => {
              const msg =
                error instanceof Error ? error.message : String(error);
              logger.warn(
                `[PresenterIngestion] Knowledge ingest via asset failed for ${inserted.id}: ${msg}`,
              );
            });
        } else {
          // Fallback: ingest the script transcript directly
          const transcriptParts = [
            `## Presentation: ${inserted.title}`,
            `Duration: ${Math.round(durationSec)}s`,
            `Mode: ${mode}`,
            `Chapters: ${chapters.length}`,
            "",
            ...scriptSegments.filter((s) => s.text).map((s) => s.text),
          ];
          const transcriptText = transcriptParts.join("\n");
          if (transcriptText.trim()) {
            void knowledgeService
              .ingestText(inserted.id, inserted.title, transcriptText, {
                visibility: "internal",
                category: "presentation",
              })
              .catch((error) => {
                const msg =
                  error instanceof Error ? error.message : String(error);
                logger.warn(
                  `[PresenterIngestion] Knowledge ingest failed for ${inserted.id}: ${msg}`,
                );
              });
          }
        }

        logger.info(
          `[PresenterIngestion] Indexed presentation "${manifest.projectTitle}" (${result.jobId})`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          `[PresenterIngestion] Failed to index presentation: ${msg}`,
        );
      }
    })();
  },
);

// Start the Knowledge Ingestion Service, then back-fill existing gallery assets
void knowledgeService
  .start()
  .then(async () => {
    logger.info("Knowledge Ingestion Service started");

    // Helper: build ingestAsset args from a raw DB row.
    // Pass withFilePath=false for the fast metadata-only pass; true to trigger AI analysis.
    type RawAsset = ReturnType<typeof mediaQueueRepo.listAssets>[0];
    const buildArgs = (rawAsset: RawAsset, withFilePath: boolean) => {
      let tags: string[] = [];
      if (rawAsset.tags) {
        try {
          const parsed = JSON.parse(String(rawAsset.tags));
          tags = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          // Plain string value (e.g. "scene") — treat as single tag
          tags = [String(rawAsset.tags)];
        }
      }
      return {
        id: String(rawAsset.id),
        type: rawAsset.type as "image" | "video" | "audio" | "scene",
        filename: String(rawAsset.filename),
        filePath: withFilePath
          ? (rawAsset.file_path as string | undefined)
          : undefined,
        prompt: rawAsset.prompt as string | undefined,
        model: rawAsset.model as string | undefined,
        tags,
        source: String(rawAsset.source ?? "generated"),
        durationSeconds: rawAsset.duration_seconds as number | undefined,
        width: rawAsset.width as number | undefined,
        height: rawAsset.height as number | undefined,
        visibility: ((rawAsset.knowledge_visibility as string | undefined) ??
          "public") as KnowledgeVisibility,
        category: ((rawAsset.knowledge_category as string | undefined) ??
          "media") as KnowledgeCategory,
      };
    };

    // ── Orphan cleanup: remove knowledge docs whose gallery asset no longer exists ──
    try {
      const galleryIds = new Set(
        mediaQueueRepo.listAssets({ limit: 100_000 }).map((a) => String(a.id)),
      );
      for (const doc of knowledgeService.listDocuments()) {
        if (doc.assetId && !galleryIds.has(doc.assetId)) {
          await knowledgeService.removeAsset(doc.assetId);
          logger.info(
            `[Gallery] Removed orphaned knowledge doc for deleted asset ${doc.assetId}`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        `[Gallery] Orphan cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Classify gallery assets into work queues ──
    const allAssets = mediaQueueRepo.listAssets({ limit: 10_000 });
    const docMap = new Map(
      knowledgeService.listDocuments().map((d) => [d.id, d]),
    );
    const neverIndexed: RawAsset[] = [];
    const needsAiUpgrade: RawAsset[] = [];

    for (const rawAsset of allAssets) {
      const docId = `asset:${rawAsset.id as string}`;
      const existing = docMap.get(docId);
      const filePath = rawAsset.file_path as string | undefined;
      if (!existing) {
        neverIndexed.push(rawAsset);
      } else if (
        existing.status === "indexed" &&
        !existing.hasAiAnalysis &&
        filePath
      ) {
        needsAiUpgrade.push(rawAsset);
      }
    }

    // ── Phase 1: sync metadata-only ingest for never-indexed assets (fast, no AI) ──
    if (neverIndexed.length > 0) {
      let ingested = 0;
      for (const rawAsset of neverIndexed) {
        try {
          await knowledgeService.ingestAsset(buildArgs(rawAsset, false));
          ingested++;
        } catch (err) {
          logger.warn(
            `[Gallery] Back-fill failed for asset ${rawAsset.id as string}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      logger.info(
        `[Gallery] Back-filled ${ingested} new assets (metadata-only)`,
      );
    }

    // ── Phase 2: background AI upgrade queue (throttled, non-blocking) ──
    // Includes newly-ingested assets the converter can analyse plus previously
    // indexed entries that never received AI analysis.
    const upgradeQueue: RawAsset[] = [
      ...neverIndexed.filter(
        (a) =>
          a.file_path && knowledgeService.canConvertFile(String(a.file_path)),
      ),
      ...needsAiUpgrade,
    ];

    if (upgradeQueue.length > 0) {
      logger.info(
        `[Gallery] Queuing ${upgradeQueue.length} asset(s) for background AI analysis`,
      );
      void (async () => {
        let upgraded = 0;
        for (const rawAsset of upgradeQueue) {
          // Throttle: 2 s between converter invocations so Whisper/OCR sidecars aren't hammered
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
          try {
            await knowledgeService.ingestAsset(buildArgs(rawAsset, true));
            upgraded++;
            if (upgraded % 10 === 0 || upgraded === upgradeQueue.length) {
              logger.info(
                `[Gallery] AI upgrade progress: ${upgraded}/${upgradeQueue.length}`,
              );
            }
          } catch (err) {
            logger.warn(
              `[Gallery] AI upgrade failed for asset ${rawAsset.id as string}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        logger.info(
          `[Gallery] AI upgrade complete: ${upgraded}/${upgradeQueue.length} asset(s) upgraded`,
        );
      })();
    }
  })
  .catch((error) => {
    const details = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start Knowledge Ingestion Service: ${details}`);
  });

// ── Voice Router (Google Cloud TTS + Local Audio Sidecar) ──
const voiceRouter = createVoiceRouter({ voiceService });
app.use("/api/voice", authMiddleware, voiceRouter);

// Webhook trigger routes (public-facing) — capture raw body for HMAC verification
app.use(
  "/api/webhooks/trigger",
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as unknown as Record<string, unknown>).rawBody = buf;
    },
  }),
);
const webhookRouter = createWebhookRouter({
  webhookManager,
  taskEngine,
  promptManager,
});
app.use("/api/webhooks/trigger", webhookRouter);

// ── Firecrawl Webhook Endpoint (internal-only, for async crawl/batch callbacks) ──
let firecrawlWebhookHandler: FirecrawlWebhookHandler | null = null;
// Sub-issue #1010 \u2014 holds the disposable registration for the pitch image
// completion listener so graceful shutdown can detach the handler.
let pitchImageCompletionRegistration: { dispose(): void } | null = null;
const firecrawlConfig = (config as Record<string, unknown>).firecrawl as
  | Record<string, unknown>
  | undefined;
const firecrawlUseWebhooks = firecrawlConfig?.useWebhooks !== false;
if (firecrawlUseWebhooks) {
  const webhookSecret = generateWebhookSecret();
  firecrawlWebhookHandler = new FirecrawlWebhookHandler({
    secret: webhookSecret,
    port: config.server.port,
    enabled: true,
  });
  // Capture raw body for HMAC verification — must be registered before the router
  app.use(
    "/api/webhooks/firecrawl",
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as Record<string, unknown>).rawBody = buf;
      },
    }),
  );
  const fcWebhookRouter = createFirecrawlWebhookRouter(firecrawlWebhookHandler);
  app.use("/api/webhooks/firecrawl", fcWebhookRouter);

  // Wire up the webhook handler to the Firecrawl client singleton
  const fc = getFirecrawlClient(
    firecrawlConfig as Record<string, unknown> | undefined,
  );
  fc.setWebhookHandler(firecrawlWebhookHandler);

  // Set env vars for Docker compose (Firecrawl container needs the secret).
  // These are inherited by the child `docker compose up` process at sidecar start.
  process.env.FIRECRAWL_WEBHOOK_SECRET = webhookSecret;
  process.env.FIRECRAWL_WEBHOOK_URL = `http://host.docker.internal:${config.server.port}/api/webhooks/firecrawl`;

  logger.info("[Firecrawl] Webhook handler initialized");

  // ── Wire crawl progress events to Socket.IO (#841) ────────────────────
  // When a clientId is present on the event, scope it to that client's room
  // so crawls in one tab don't leak progress into other browser sessions.
  const emitCrawl = (
    eventName: "crawl:started" | "crawl:progress" | "crawl:completed",
    event: { clientId?: string },
  ) => {
    if (event.clientId) {
      io.to(event.clientId).emit(eventName, event);
    } else {
      io.emit(eventName, event);
    }
  };
  firecrawlWebhookHandler.on("crawl:started", (event) => {
    emitCrawl("crawl:started", event);
  });
  firecrawlWebhookHandler.on("crawl:progress", (event) => {
    emitCrawl("crawl:progress", event);
  });
  firecrawlWebhookHandler.on("crawl:completed", (event) => {
    emitCrawl("crawl:completed", event);
  });
}

// Tasks API routes
const tasksRouter = createTasksRouter({ taskEngine, taskRepository });
app.use("/api/tasks", authMiddleware, tasksRouter);

// SEO Suite API routes (#838)
const seoRouter = createSeoRouter({
  db,
  scheduler,
  firecrawlWebhookHandler: firecrawlWebhookHandler ?? undefined,
});
app.use("/api/seo", authMiddleware, seoRouter);

// Media Queue API routes (push-based distributed queue + gallery)
// Callback route is mounted WITHOUT auth — remote workers (Mac Mini, FluxQ)
// POST results to /api/queue/complete without an Authorization header.
if (!config.auth.workerSecret) {
  logger.warn(
    "⚠ auth.workerSecret is not configured. Queue callbacks will only be accepted from localhost.",
  );
}
const queueCallbackRouter = createQueueCallbackRouter({
  queueMaster,
  repo: mediaQueueRepo,
  knowledgeService,
  workerSecret: config.auth.workerSecret,
  allowLegacyBearer: config.auth.allowLegacyBearer ?? true,
  callbackRateLimit: config.auth.callbackRateLimit ?? {
    perMinute: 60,
    burst: 10,
  },
});
// Issue #1089: capture raw body for HMAC signature verification.
app.use(
  "/api/queue",
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
  queueCallbackRouter,
);

// Character repo needed early — queue router uses it for auto-LoRA injection
const characterRepo = new CharacterRepository(db);
characterRepo.migrate();

const queueRouter = createQueueRouter({
  queueMaster,
  repo: mediaQueueRepo,
  characterRepo,
  knowledgeService,
});
app.use("/api/queue", authMiddleware, queueRouter);

// Gallery API routes (AI prompt enhancement)
const galleryRouter = createGalleryRouter({ copilot, toolRegistry });
app.use("/api/gallery", authMiddleware, galleryRouter);

// Studio API routes (screen recording upload, video trimming, AI analysis)
const studioRouter = createStudioRouter({
  trimWorker,
  analyzeWorker,
  mediaQueueRepo,
});
app.use("/api/studio", authMiddleware, studioRouter);

// Video Pipeline API routes (clip extraction, reframing, audio cleaning, B-Roll, NLE export) — Epic #817
const videoPipelineRouter = createVideoPipelineRouter({
  clipExtractor,
  reframeWorker,
  audioCleaner,
  brollPipeline,
});
app.use("/api/studio/pipeline", authMiddleware, videoPipelineRouter);

// Calendar Aggregation API — #823
const calendarRouter = createCalendarRouter({ outboxRepo, scheduler });
app.use("/api/admin/calendar", authMiddleware, calendarRouter);

// Video Analytics API — #828
const analyticsRouter = createAnalyticsRouter({
  aggregator: analyticsAggregator,
});
app.use("/api/admin/video-analytics", authMiddleware, analyticsRouter);

// Creative Studio API routes (inpainting, AI image editing, sidecar tools)
const creativeRouter = createCreativeRouter({
  mediaQueueRepo,
  copilotWrapper: copilot,
  imageProcessingSidecarUrl: resolveSidecarUrl(
    "image-processing",
    "IMAGE_PROCESSING_SIDECAR_URL",
    5010,
  ),
  characterRepo,
});
// enhance-prompt accepts a base64 image in the JSON body — needs a higher limit
app.use(
  "/api/admin/creative/enhance-prompt",
  authMiddleware,
  express.json({ limit: "20mb" }),
);
app.use("/api/admin/creative", authMiddleware, creativeRouter);

// Post Template API routes (Issue #809)
const templatesRouter = createTemplatesRouter({ postTemplateRepo });
app.use("/api/admin/templates", authMiddleware, templatesRouter);

// Brand Template API routes (#827)
const brandTemplateRouter = createBrandTemplateRouter({ brandTemplateRepo });
app.use("/api/admin/brand-templates", authMiddleware, brandTemplateRouter);

// Character API routes (LoRA character profiles + training)
const characterRouter = createCharacterRouter({ characterRepo, copilot });
app.use("/api/characters", authMiddleware, characterRouter);

// Files API routes (Workbench file management)
const filesBaseAllowedDirs =
  allowedDirs.length > 0
    ? allowedDirs
    : [PROJECT_ROOT, os.tmpdir(), os.homedir(), "/tmp", "/private/tmp"];

// Always include OpenZigs render/output roots so Presenter video playback can
// stream rendered assets, even when OPENZIGS_ALLOWED_DIRS is narrowed.
const effectiveAllowedDirs = Array.from(
  new Set([
    ...filesBaseAllowedDirs,
    expandTilde("~/.openzigs"),
    expandTilde(directorConfig?.outputDir ?? "~/.openzigs/video-output"),
    expandTilde("~/.openzigs/renders"),
    expandTilde("~/.openzigs/seo-reports"),
  ]),
);
const filesRouter = createFilesRouter({
  allowedDirs: effectiveAllowedDirs,
  markitdownUrl: process.env.MCP_MARKITDOWN_URL,
});
app.use("/api/files", authMiddleware, filesRouter);

const tunnelConfig = config.tunnel;
const tunnel = tunnelConfig?.enabled
  ? new CloudflareTunnel({
      mode: tunnelConfig.mode,
      namedTunnel: tunnelConfig.namedTunnel,
      logger,
    })
  : null;

// ── Multiplayer Room Manager (Issue #284) ──
const roomManager = new RoomManager();

const httpServer = createServer(app);
// Allow both local UI and presenter subdomain (for Cloudflare tunnel guests).
// OPENZIGS_PRESENTER_ORIGIN env var takes precedence; falls back to config.presenter.baseUrl.
const presenterOrigin =
  process.env.OPENZIGS_PRESENTER_ORIGIN || config.presenter?.baseUrl;
const socketAllowedOrigins = presenterOrigin
  ? [uiOrigin, presenterOrigin]
  : [uiOrigin];
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (non-browser clients)
      if (!origin) return callback(null, true);
      // Allow any localhost origin regardless of port (dev servers on 3001, 3101, etc.)
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return callback(null, true);
        }
      } catch {
        /* not a valid URL */
      }
      if (socketAllowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  },
});

// Bind Socket.IO to Director router for real-time produce activity events
setDirectorIO(io);
// Bind Socket.IO to Pitch router (Epic #951 Phase 3) for deck/slide/brand-kit events
setPitchIO(io);
// Bind Socket.IO to Admin router for skill update events
setAdminIO(io);

// GPU dispatcher live updates — relay every state transition to admin clients
// so the GPU panel can render real-time queue depth + current job + mutex
// status without polling. Listeners are added once at boot.
gpuDispatcher.on("gpu:state-changed", (snapshot) => {
  io.emit("gpu:dispatcher:state", snapshot);
});
gpuDispatcher.on("job:started", (payload) => {
  io.emit("gpu:dispatcher:job-started", payload);
});
gpuDispatcher.on("job:completed", (payload) => {
  io.emit("gpu:dispatcher:job-completed", payload);
});
gpuDispatcher.on("job:failed", (payload) => {
  io.emit("gpu:dispatcher:job-failed", payload);
});
// Bind Socket.IO to Character router for training progress events
setCharacterIO(io);
// Wire ChannelManager into Character router for opt-in Telegram training notifications (Issue #415)
setCharacterChannelManager(
  channelManager,
  config.channels?.telegram?.adminUserId || undefined,
);
// Resume polling for any characters stuck in "training" after server restart
resumeStaleTrainingPolls(characterRepo).catch((err) => {
  logger.warn(`[Characters] Failed to resume stale training polls: ${err}`);
});

// Socket.IO auth middleware — validate Bearer token on connection
const expectedToken = config.auth.token ?? "";
io.use((socket, next) => {
  const token =
    ((socket.handshake.auth as Record<string, unknown>)?.token as
      | string
      | undefined) ??
    socket.handshake.headers?.authorization?.replace("Bearer ", "");
  if (!token || !expectedToken) {
    return next(new Error("Authentication required"));
  }
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);
  if (
    tokenBuf.length !== expectedBuf.length ||
    !timingSafeEqual(tokenBuf, expectedBuf)
  ) {
    return next(new Error("Authentication required"));
  }
  next();
});

// ── PeerJS Signaling Server (Issue #286) ──
// Mount PeerJS at /peerjs — path option controls both WS upgrade filtering
// and HTTP route prefix, so we use app.use() without a mount path to avoid
// double-prefixing.
// Use createWebSocketServer with noServer mode to prevent PeerJS's ws.Server
// from aborting Socket.IO WebSocket upgrades (the default {server, path} mode
// calls abortHandshake on ALL non-matching upgrade requests, corrupting
// Socket.IO's WebSocket connection with "Invalid frame header").
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WsServer = createRequire(import.meta.url)("ws").Server;
const peerServer = ExpressPeerServer(httpServer, {
  path: "/peerjs",
  proxied: true,
  alive_timeout: 60000,
  key: "openzigs",
  allow_discovery: false,
  createWebSocketServer: () => {
    const wss = new WsServer({ noServer: true });
    httpServer.on(
      "upgrade",
      (req: { url?: string }, socket: unknown, head: unknown) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (
          pathname === "/peerjs/peerjs" ||
          pathname.startsWith("/peerjs/peerjs/")
        ) {
          wss.handleUpgrade(req, socket, head, (ws: unknown) => {
            wss.emit("connection", ws, req);
          });
        }
        // Non-matching paths are left alone for Socket.IO to handle
      },
    );
    return wss;
  },
});
app.use(peerServer);

io.on("connection", (socket) => {
  socket.emit("status:update", { connected: true });

  // Join a per-client room so server-emitted events (e.g. SEO crawl progress)
  // can be scoped to a single browser tab via `io.to(clientId).emit(...)`.
  // The clientId is generated client-side and passed via `query.clientId`.
  const rawClientId = socket.handshake.query?.clientId;
  if (typeof rawClientId === "string" && rawClientId.length > 0) {
    socket.join(rawClientId);
  }

  // ── Presenter Mode: Teacher Agent Q&A (Issue #279, #285) ──
  // Refactored into a named function so it can be called from both
  // the Socket.IO event handler and the audio-chunk STT handler (#287).
  const handlePresenterAsk = async (
    emitter: import("socket.io").Socket,
    ioServer: SocketIOServer,
    data: {
      presentationId: string;
      question: string;
      chapterIndex?: number;
      timestamp?: number;
    },
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
        ioServer
          .to(roomId)
          .emit("room:fsm_state", { fsmState: "PAUSED_USER_Q" });
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
        logger.warn(
          `Failed to save presenter note: ${noteErr instanceof Error ? noteErr.message : String(noteErr)}`,
        );
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

  socket.on(
    "presenter:ask",
    (data: {
      presentationId?: string;
      question?: string;
      chapterIndex?: number;
      timestamp?: number;
    }) => {
      if (
        !data.presentationId ||
        !data.question ||
        typeof data.question !== "string"
      )
        return;
      void handlePresenterAsk(socket, io, {
        presentationId: data.presentationId,
        question: data.question,
        chapterIndex: data.chapterIndex ?? 0,
        timestamp: data.timestamp ?? 0,
      });
    },
  );

  // ── Room Management (Issue #284) ──
  // ── Server-side role enforcement for room:join ──
  // Parse guest JWT from cookies to determine actual role.
  // If guest_token cookie exists → force guest role, validate presentationId matches JWT claim.
  // No guest_token → admin user, allow host role.
  const resolveRoomRole = async (
    rawCookie: string | undefined,
    requestedPresentationId: string,
  ): Promise<{ role: "host" | "guest"; allowed: boolean }> => {
    if (!rawCookie) return { role: "host", allowed: true };

    // Parse cookies from raw header
    const cookies: Record<string, string> = {};
    for (const pair of rawCookie.split(";")) {
      const [k, ...v] = pair.split("=");
      if (k) cookies[k.trim()] = v.join("=").trim();
    }
    const guestToken = cookies["guest_token"];
    if (!guestToken) return { role: "host", allowed: true };

    // Cryptographically verify the JWT signature and expiry
    try {
      const secretKey = new TextEncoder().encode(presenterInviteSecret);
      const { payload } = await jwtVerify(guestToken, secretKey, {
        algorithms: ["HS256"],
      });
      // Guest can ONLY join the room for their specific presentation
      if (
        payload.presentationId &&
        payload.presentationId !== requestedPresentationId
      ) {
        logger.warn(
          `Guest socket tried to join room ${requestedPresentationId} but JWT scoped to ${payload.presentationId}`,
        );
        return { role: "guest", allowed: false };
      }
      return { role: "guest", allowed: true };
    } catch {
      return { role: "guest", allowed: false };
    }
  };

  socket.on(
    "room:join",
    async (data: { presentationId?: string; role?: "host" | "guest" }) => {
      if (!data.presentationId) return;

      const rawCookie = socket.handshake.headers.cookie;
      const { role, allowed } = await resolveRoomRole(
        rawCookie,
        data.presentationId,
      );
      if (!allowed) {
        socket.emit("room:error", {
          error: "Not authorized to join this room",
        });
        return;
      }

      const room = roomManager.createOrJoin(
        data.presentationId,
        socket.id,
        role,
      );
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
    },
  );

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
      io.to(pid).emit("room:peers_updated", {
        peerIds: roomManager.getPeerIds(pid),
      });
    }
  });

  // ── Playback Sync — any room member can play/pause/seek ──
  // Validates room membership, not host-only. Any participant can control playback.
  const handleMemberPlayback = (
    eventName: string,
    data: { presentationId?: string; currentTimeSeconds?: number },
    isPlayingOverride?: boolean,
  ) => {
    if (
      !data.presentationId ||
      !roomManager.isMemberOf(socket.id, data.presentationId)
    ) {
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
      isPlaying:
        isPlayingOverride ??
        roomManager.getRoom(data.presentationId)?.isPlaying ??
        false,
      currentTimeSeconds: data.currentTimeSeconds ?? 0,
      originSocketId: socket.id,
    });
  };

  socket.on(
    "member:play",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("member:play", data, true);
    },
  );

  socket.on(
    "member:pause",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("member:pause", data, false);
    },
  );

  socket.on(
    "member:seek",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("member:seek", data);
    },
  );

  // Legacy aliases for backward compat — same logic as member events
  socket.on(
    "host:play",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("host:play", data, true);
    },
  );
  socket.on(
    "host:pause",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("host:pause", data, false);
    },
  );
  socket.on(
    "host:seek",
    (data: { presentationId?: string; currentTimeSeconds?: number }) => {
      handleMemberPlayback("host:seek", data);
    },
  );

  // ── Peer Discovery (Issue #286) ──
  socket.on(
    "room:announce_peer",
    (data: { presentationId?: string; peerId?: string }) => {
      if (!data.presentationId || !data.peerId) return;
      roomManager.setPeerId(socket.id, data.peerId);
      io.to(data.presentationId).emit("room:peers_updated", {
        peerIds: roomManager.getPeerIds(data.presentationId),
      });
    },
  );

  // ── P2P Audio STT Relay (Issue #287) ──
  const pendingTranscriptions = new Set<string>();

  socket.on(
    "room:audio_chunk",
    async (data: { presentationId?: string; blob?: ArrayBuffer }) => {
      if (!data.presentationId || !data.blob) return;

      const room = roomManager.getRoom(data.presentationId);
      if (!room || !room.members.has(socket.id)) return;

      // Size guard: max 2MB
      if (data.blob.byteLength > 2 * 1024 * 1024) {
        logger.warn(
          `Audio chunk from ${socket.id} exceeds 2MB limit (${data.blob.byteLength} bytes)`,
        );
        return;
      }

      // Rate limit: one transcription in-flight per socket
      if (pendingTranscriptions.has(socket.id)) return;
      pendingTranscriptions.add(socket.id);

      try {
        const audioSidecarUrl =
          config.voice?.sidecarUrl ?? "http://127.0.0.1:5006";
        const formData = new FormData();
        formData.append(
          "audio",
          new Blob([data.blob], { type: "audio/webm" }),
          "chunk.webm",
        );

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
    },
  );

  // ── Disconnect Cleanup ──
  socket.on("disconnect", () => {
    const pid = roomManager.leave(socket.id);
    if (pid) {
      io.to(pid).emit("room:member_left", {
        socketId: socket.id,
        memberCount: roomManager.getMemberCount(pid),
      });
      io.to(pid).emit("room:peers_updated", {
        peerIds: roomManager.getPeerIds(pid),
      });
    }
  });
});

// Wire Sentinel Socket.IO event forwarding
sentinel.setIO(io);
if (sentinelConfig.enabled) {
  void sentinel
    .start()
    .then(() => {
      logger.info("Sentinel autonomous monitor started (enabled by default)");
    })
    .catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start Sentinel autonomous monitor: ${details}`);
    });
} else {
  logger.info("Sentinel autonomous monitor disabled by configuration");
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

// Wire Social Brain Socket.IO event forwarding (sanitize cross-channel content)
const sanitizeStringFields = (obj: unknown): unknown => {
  if (typeof obj === "string") {
    return obj.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (Array.isArray(obj)) return obj.map(sanitizeStringFields);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = sanitizeStringFields(v);
    }
    return out;
  }
  return obj;
};
socialBrain.on("reply", (data: unknown) => {
  io.emit("social:reply", sanitizeStringFields(data));

  // Ingest social replies into RAG for conversation history
  const reply = data as {
    platform?: string;
    contactName?: string;
    reply?: string;
    incomingText?: string;
  };
  if (reply.reply) {
    const text = [
      `## Social Reply — ${reply.platform ?? "unknown"} → ${reply.contactName ?? "unknown"}`,
      `Incoming: ${reply.incomingText ?? "(no text)"}`,
      `Reply: ${reply.reply}`,
    ].join("\n");
    void knowledgeService
      .ingestText(
        `social:reply:${Date.now()}`,
        `Social reply to ${reply.contactName ?? "unknown"}`,
        text,
        { visibility: "internal", category: "social" },
      )
      .catch(() => {});
  }
});
socialBrain.on("escalate", (data: unknown) =>
  io.emit("social:escalate", sanitizeStringFields(data)),
);
socialBrain.on("pending_approval", (data: unknown) =>
  io.emit("social:pending_approval", sanitizeStringFields(data)),
);
socialBrain.on("comment_reply", (data: unknown) =>
  io.emit("social:comment_reply", sanitizeStringFields(data)),
);
socialHandoff.on("escalated", (data: unknown) =>
  io.emit("social:handoff:created", sanitizeStringFields(data)),
);
socialHandoff.on("resolved", (data: unknown) =>
  io.emit("social:handoff:resolved", sanitizeStringFields(data)),
);
commentRuleEngine.on("rule_triggered", (data: unknown) =>
  io.emit("social:rule:triggered", sanitizeStringFields(data)),
);

// Forward incoming messages/comments to Socket.IO for real-time notifications
socialIngestion.on(
  "message",
  ({
    message,
    contact,
    raw,
  }: {
    message: unknown;
    contact: unknown;
    raw: unknown;
  }) => {
    io.emit(
      "social:new_message",
      sanitizeStringFields({ message, contact, raw }),
    );
  },
);
socialIngestion.on("comment", (comment: unknown) => {
  io.emit("social:new_comment", sanitizeStringFields(comment));
});

// Push notifications for incoming social messages to Telegram/Discord
const socialNotifyConfig = socialBrainConfig?.notifications;
if (socialNotifyConfig?.enabled) {
  const telegramAdminChatId =
    config.channels?.telegram?.adminUserId || undefined;
  const discordNotifChannelId =
    config.channels?.discord?.notificationChannelId || undefined;

  const pushSocialNotification = async (text: string) => {
    if (socialNotifyConfig.telegram !== false && telegramAdminChatId) {
      const tg = channelManager.getChannel("telegram");
      if (tg) {
        try {
          await tg.sendMessage(telegramAdminChatId, { text });
        } catch {
          /* best-effort */
        }
      }
    }
    if (socialNotifyConfig.discord !== false && discordNotifChannelId) {
      const dc = channelManager.getChannel("discord");
      if (dc) {
        try {
          await dc.sendMessage(discordNotifChannelId, { text });
        } catch {
          /* best-effort */
        }
      }
    }
  };

  socialIngestion.on(
    "message",
    ({
      raw,
    }: {
      raw: { platform?: string; username?: string; text?: string };
    }) => {
      const preview = (raw.text ?? "").slice(0, 100);
      void pushSocialNotification(
        `📩 New DM on ${raw.platform ?? "unknown"} from @${raw.username ?? "unknown"}: ${preview}`,
      );
    },
  );
  socialIngestion.on(
    "comment",
    (comment: { platform?: string; username?: string; text?: string }) => {
      const preview = (comment.text ?? "").slice(0, 100);
      void pushSocialNotification(
        `💬 New comment on ${comment.platform ?? "unknown"} from @${comment.username ?? "unknown"}: ${preview}`,
      );
    },
  );
  socialBrain.on(
    "pending_approval",
    (data: {
      contact?: { username?: string };
      result?: { reply?: string };
      pendingMessage?: { id?: string };
      comment?: { text?: string; platform?: string };
      raw?: { platform?: string };
    }) => {
      const platform =
        data.comment?.platform ?? data.raw?.platform ?? "unknown";
      const username = data.contact?.username ?? "unknown";
      const reply = data.result?.reply ?? "";

      // Telegram: inline Approve / Reject buttons
      if (
        socialNotifyConfig.telegram !== false &&
        telegramAdminChatId &&
        data.pendingMessage?.id
      ) {
        const tg = channelManager.getChannel("telegram");
        if (tg && "sendSocialApproval" in tg) {
          void (tg as import("./channels/telegram.js").TelegramChannel)
            .sendSocialApproval(telegramAdminChatId, {
              messageId: data.pendingMessage.id,
              username,
              platform,
              replyPreview: reply,
              originalComment: data.comment?.text,
            })
            .catch(() => {});
        }
      }
      // Discord / fallback: plain text
      if (socialNotifyConfig.discord !== false && discordNotifChannelId) {
        void pushSocialNotification(
          `⏳ Reply pending approval for @${username}: ${reply.slice(0, 100)}`,
        );
      }
    },
  );

  // Wire Telegram social approval callbacks → repository approve/reject + dispatch + voice learning
  const tgForSocial = channelManager.getChannel("telegram");
  if (tgForSocial && "onSocialApproval" in tgForSocial) {
    const voiceLearning = socialBrain.getVoiceLearning();
    (
      tgForSocial as import("./channels/telegram.js").TelegramChannel
    ).onSocialApproval((action) => {
      try {
        let message:
          | import("./channels/social/types.js").SocialMessage
          | undefined;
        if (action.action === "approve") {
          message = socialRepository.approveReply(action.messageId);
          io.emit("social:approval_resolved", {
            messageId: action.messageId,
            action: "approved",
          });
        } else {
          socialRepository.rejectReply(action.messageId);
          io.emit("social:approval_resolved", {
            messageId: action.messageId,
            action: "rejected",
          });
        }
        logger.info(
          `[SocialBrain] Telegram ${action.action} for message ${action.messageId} by ${action.decidedBy ?? "unknown"}`,
        );

        // Dispatch approved reply to platform + record voice example
        if (action.action === "approve" && message) {
          void dispatchApprovedReply(dmDispatcher, socialRepository, message);
          try {
            const meta = JSON.parse(message.metadata) as Record<
              string,
              unknown
            >;
            const originalMessage = (meta.originalMessage as string) ?? "";
            if (originalMessage) {
              const contact = socialRepository.getContact(message.contact_id);
              void voiceLearning.recordApprovedReply({
                messageId: message.id,
                platform: message.platform,
                username: contact?.username ?? "unknown",
                originalMessage,
                approvedReply: message.content,
                wasEdited: false,
              });
            }
          } catch {
            /* metadata parse failed */
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[SocialBrain] Telegram approval callback error: ${msg}`);
      }
    });
  }
}

// Wire Render Orchestrator → Socket.IO event forwarding
renderOrchestrator.on("render:progress", (data: unknown) =>
  io.emit("render:progress", data),
);
renderOrchestrator.on("render:complete", (data: unknown) =>
  io.emit("render:complete", data),
);
renderOrchestrator.on("render:failed", (data: unknown) =>
  io.emit("render:failed", data),
);

// Wire Studio Workers → Socket.IO event forwarding
trimWorker.on("trim:queued", (data: unknown) => io.emit("trim:queued", data));
trimWorker.on("trim:processing", (data: unknown) =>
  io.emit("trim:processing", data),
);
trimWorker.on("trim:complete", (data: unknown) =>
  io.emit("trim:complete", data),
);
trimWorker.on("trim:failed", (data: unknown) => io.emit("trim:failed", data));
analyzeWorker.on("analyze:queued", (data: unknown) =>
  io.emit("analyze:queued", data),
);
analyzeWorker.on("analyze:progress", (data: unknown) =>
  io.emit("analyze:progress", data),
);
analyzeWorker.on("analyze:complete", (data: unknown) =>
  io.emit("analyze:complete", data),
);
analyzeWorker.on("analyze:failed", (data: unknown) =>
  io.emit("analyze:failed", data),
);

// Wire Video Pipeline Workers → Socket.IO event forwarding (Epic #817)
clipExtractor.on("clip:queued", (data: unknown) =>
  io.emit("clip:queued", data),
);
clipExtractor.on("clip:progress", (data: unknown) =>
  io.emit("clip:progress", data),
);
clipExtractor.on("clip:complete", (data: unknown) =>
  io.emit("clip:complete", data),
);
clipExtractor.on("clip:failed", (data: unknown) =>
  io.emit("clip:failed", data),
);
reframeWorker.on("reframe:queued", (data: unknown) =>
  io.emit("reframe:queued", data),
);
reframeWorker.on("reframe:progress", (data: unknown) =>
  io.emit("reframe:progress", data),
);
reframeWorker.on("reframe:complete", (data: unknown) =>
  io.emit("reframe:complete", data),
);
reframeWorker.on("reframe:failed", (data: unknown) =>
  io.emit("reframe:failed", data),
);
audioCleaner.on("clean:queued", (data: unknown) =>
  io.emit("clean:queued", data),
);
audioCleaner.on("clean:progress", (data: unknown) =>
  io.emit("clean:progress", data),
);
audioCleaner.on("clean:complete", (data: unknown) =>
  io.emit("clean:complete", data),
);
audioCleaner.on("clean:failed", (data: unknown) =>
  io.emit("clean:failed", data),
);
brollPipeline.on("broll:queued", (data: unknown) =>
  io.emit("broll:queued", data),
);
brollPipeline.on("broll:progress", (data: unknown) =>
  io.emit("broll:progress", data),
);
brollPipeline.on("broll:complete", (data: unknown) =>
  io.emit("broll:complete", data),
);
brollPipeline.on("broll:failed", (data: unknown) =>
  io.emit("broll:failed", data),
);

// Wire NotificationDispatcher now that we have the Socket.IO server
// (side-effect: registers event listeners on TaskEngine)
new NotificationDispatcher({
  engine: taskEngine,
  channelManager,
  sessionManager,
  io,
});

// Wire MediaNotificationService — per-job opt-in Telegram notifications (Issue #414)
new MediaNotificationService({
  queueMaster,
  renderOrchestrator,
  channelManager,
  fallbackChatId: config.channels?.telegram?.adminUserId || undefined,
});

// Wire TaskEventStreamer for real-time subagent progress events (#488)
const taskEventStreamer = new TaskEventStreamer({ io });
taskWorker.setEventStreamer(taskEventStreamer);

// Wire SubagentEventRelay for SDK-native subagent events (#497)
const subagentRelay = new SubagentEventRelay({ io, copilot });

// Seed TaskWorker with valid model IDs so pipeline stage model overrides are validated
copilot
  .listModels()
  .then((models) => {
    taskWorker.setValidModels(models.map((m) => m.id));
  })
  .catch(() => {
    /* non-fatal: validation will be skipped if models can't be fetched */
  });

// Wire ResultInjector for inline result injection into parent sessions (#487)
new ResultInjector({ taskEngine, sessionManager, io });

// Forward ALL task lifecycle events to Socket.IO for real-time graph updates
for (const event of [
  "task:queued",
  "task:running",
  "task:completed",
  "task:failed",
  "task:cancelled",
] as const) {
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
        agentName: task.agentName,
        sessionId: task.sessionId,
        tokenUsage: task.tokenUsage,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
      },
    });

    // Emit task:tree-update with rootTaskId for live DAG visualization (#486)
    try {
      const rootTask = taskEngine.getRoot(task.id);
      io.emit("task:tree-update", {
        rootTaskId: rootTask.id,
        taskId: task.id,
        status: task.status,
        updatedFields: {
          status: task.status,
          result: task.result,
          error: task.error,
          startedAt: task.startedAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
          tokenUsage: task.tokenUsage,
        },
      });
    } catch (err) {
      // If getRoot fails (e.g., task already deleted), skip tree-update.
      if (!(err instanceof Error && err.message.includes("Task not found"))) {
        logger.warn(`Failed to emit task:tree-update for task ${task.id}`, {
          error: err,
        });
      }
    }
  });
}

approvalQueue.on("approval:created", (approval) => {
  io.emit("approval:request", approval);
});

// Forward real-time token usage and context compaction events to connected clients
copilot.on(
  "token:usage",
  (event: import("./copilot/copilot-wrapper.js").TokenUsageEvent) => {
    io.emit("context:usage", event);
  },
);

copilot.on(
  "context:compaction",
  (event: import("./copilot/copilot-wrapper.js").CompactionEvent) => {
    io.emit("context:compaction", event);
  },
);

approvalQueue.on("approval:decided", (approval) => {
  io.emit("approval:decided", {
    id: approval.id,
    approved: approval.status === "approved",
    decidedVia: approval.decidedVia,
    status: approval.status,
  });
});

toolRegistry.on("tool:toggled", (payload) => {
  io.emit("tool:toggled", payload);
});

scheduler.on("job:executed", (result) => {
  io.emit("job:executed", result);

  // Ingest scheduler execution results into RAG for historical retrieval
  const execResult = result as {
    jobId?: string;
    jobName?: string;
    output?: string;
    timestamp?: string;
  };
  if (execResult.jobId && execResult.output) {
    const text = [
      `## Scheduled Job Execution: ${execResult.jobName ?? execResult.jobId}`,
      `Executed: ${execResult.timestamp ?? new Date().toISOString()}`,
      "",
      execResult.output,
    ].join("\n");
    void knowledgeService
      .ingestText(
        `scheduler:${execResult.jobId}:${Date.now()}`,
        `Job: ${execResult.jobName ?? execResult.jobId}`,
        text,
        { visibility: "internal", category: "system" },
      )
      .catch((err) => {
        logger.warn(
          `[Scheduler] RAG ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
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
  return ids.map((id) => (id.startsWith("telegram:") ? id : `telegram:${id}`));
};

const defaultAccessControl = {
  mode: "open" as const,
  allowedUsers: [],
  blockedUsers: [],
};

const setupChannelRouting = (
  channel: MessageChannel,
  router: MessageRouter,
  approvalQueue: ApprovalQueue,
  sessionManager: SessionManager,
  logger: Logger,
  model?: string,
) => {
  const channelType = channel.type;

  channel.onMessage((message) => {
    void router
      .route(message, { model, allowedTools: message.tools })
      .catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        logger.error(`${channelType} message routing failed: ${details}`);
      });
  });

  channel.onApprovalResponse((response) => {
    approvalQueue.handleDecision(response.approvalId, {
      approved: response.approved,
      decidedBy: response.decidedBy,
      decidedVia: channelType,
    });
  });

  approvalQueue.on("approval:created", async (approval) => {
    if (approval.channelType !== channelType || !approval.sessionId) {
      return;
    }
    try {
      const session = await sessionManager.getSession(approval.sessionId);
      const chatId =
        typeof session.metadata.chatId === "string"
          ? session.metadata.chatId
          : undefined;
      if (!chatId) {
        logger.warn(
          `Missing chatId for ${channelType} approval ${approval.id}`,
        );
        return;
      }
      await channel.sendApprovalRequest(chatId, {
        id: approval.id,
        tool: approval.tool,
        args: approval.args,
        riskLevel: approval.riskLevel,
        explanation: approval.explanation,
        preview: approval.preview,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send ${channelType} approval: ${details}`);
    }
  });
};

const createRouter = (
  accessControlOverride?: AccessControlConfig,
  onUserInputRequest?: import("./copilot/copilot-wrapper.js").UserInputHandler,
) => {
  return new MessageRouter({
    channelManager,
    sessionManager,
    copilot,
    accessControl:
      accessControlOverride ??
      config.messaging?.accessControl ??
      defaultAccessControl,
    personalityManager,
    taskEngine,
    onUserInputRequest,
    vaultService,
    brandVoiceService,
  });
};

const telegramConfig = config.channels?.telegram;
if (telegramConfig?.enabled && telegramConfig.token) {
  const telegramChannel = new TelegramChannel({
    config: {
      botToken: telegramConfig.token,
      webhookUrl: telegramConfig.webhookUrl,
      webhookSecret: telegramConfig.webhookSecret,
      adminUserId: telegramConfig.adminUserId,
    },
    toolRegistry,
    logger,
  });

  const accessControl =
    telegramConfig.allowedUsers.length > 0
      ? {
          mode: "allowlist" as const,
          allowedUsers: normalizeTelegramAllowlist(telegramConfig.allowedUsers),
          blockedUsers: [],
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
  if (
    telegramWebhookSecret &&
    typeof telegramWebhookSecret === "string" &&
    telegramWebhookSecret.length > 0
  ) {
    app.post("/telegram/webhook", (req, res, next) => {
      const header = (
        req.get("x-telegram-bot-api-secret-token") || ""
      ).toString();
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

  setupChannelRouting(
    telegramChannel,
    router,
    approvalQueue,
    sessionManager,
    logger,
    telegramConfig.model,
  );
}

const discordConfig = config.channels?.discord;
if (discordConfig?.enabled && discordConfig.token) {
  const discordChannel = new DiscordChannel({
    config: {
      botToken: discordConfig.token,
      allowedGuilds: discordConfig.allowedGuilds,
    },
    logger,
  });

  const router = createRouter();

  await discordChannel.connect();
  channelManager.register(discordChannel);

  setupChannelRouting(
    discordChannel,
    router,
    approvalQueue,
    sessionManager,
    logger,
  );
}

// ── Web Chat Channel ──
const webConfig = config.channels?.web;
if (webConfig?.enabled !== false) {
  const webChatChannel = new WebChatChannel({ io, sessionManager });
  const shouldAutoApproveVaultPrompt = (request: {
    question: string;
    choices?: string[];
  }): boolean => {
    const question = request.question.toLowerCase();
    const choices = (request.choices ?? []).map((c) => c.toLowerCase());

    const mentionsVaultAuthIntent =
      /(vault|secret|credential|password)/i.test(question) &&
      /(login|log in|sign in|account)/i.test(question);

    // Only auto-approve when there's an obvious affirmative option and no risky freeform requirement.
    const hasAffirmativeChoice = choices.some(
      (c) => /^(yes|allow|approve)/.test(c) || /(recommended)/.test(c),
    );

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
      const chatId =
        typeof session.metadata?.chatId === "string"
          ? session.metadata.chatId
          : undefined;
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
  setAdminMessageRouter(router);
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
        const userMessage = /SDK|CLI|unavailable|timed out|rate.?limit/i.test(
          details,
        )
          ? details
          : "Something went wrong — check server logs for details.";
        void webChatChannel.sendError(message.chatId, userMessage);
      });
  });

  webChatChannel.onApprovalResponse((response) => {
    approvalQueue.handleDecision(response.approvalId, {
      approved: response.approved,
      decidedBy: response.decidedBy,
      decidedVia: "web",
    });
  });

  approvalQueue.on("approval:created", async (approval) => {
    if (approval.channelType !== "web" || !approval.sessionId) {
      return;
    }
    const approvalPayload = {
      id: approval.id,
      tool: approval.tool,
      args: approval.args,
      riskLevel: approval.riskLevel,
      explanation: approval.explanation,
      preview: approval.preview,
    };
    // Ephemeral sessions lack a session-manager record; broadcast to all web clients.
    if (approval.sessionId === "ephemeral") {
      webChatChannel.broadcastApprovalRequest(approvalPayload);
      return;
    }
    try {
      const session = await sessionManager.getSession(approval.sessionId);
      const chatId =
        typeof session.metadata.chatId === "string"
          ? session.metadata.chatId
          : undefined;
      if (!chatId) {
        logger.warn(`Missing chatId for web approval ${approval.id}`);
        return;
      }
      await webChatChannel.sendApprovalRequest(chatId, approvalPayload);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send web approval: ${details}`);
    }
  });
}

httpServer.listen(port, "0.0.0.0", async () => {
  logger.info(`OpenZigs server listening on port ${port} (0.0.0.0)`);

  // Pinterest OAuth: auto-refresh token if expiry is within 7 days
  const checkPinterestRefresh = async () => {
    const expiresAt = process.env.PINTEREST_TOKEN_EXPIRES_AT;
    const refreshToken = process.env.PINTEREST_REFRESH_TOKEN;
    if (!expiresAt || !refreshToken) return;
    const expiresMs = new Date(expiresAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() > expiresMs - sevenDays) {
      logger.info("Pinterest token expiring within 7 days — auto-refreshing…");
      try {
        const result = await refreshPinterestToken();
        if (result.ok) {
          logger.info(
            `Pinterest token auto-refreshed, new expiry: ${result.expiresAt}`,
          );
        } else {
          logger.warn(`Pinterest auto-refresh failed: ${result.error}`);
        }
      } catch (err) {
        logger.warn(
          `Pinterest auto-refresh error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  void checkPinterestRefresh();
  // Check daily
  setInterval(() => void checkPinterestRefresh(), 24 * 60 * 60 * 1000);

  // LinkedIn OAuth: auto-refresh token if expiry is within 7 days
  const checkLinkedInRefresh = async () => {
    const expiresAt = process.env.LINKEDIN_TOKEN_EXPIRES_AT;
    const refreshToken = process.env.LINKEDIN_REFRESH_TOKEN;
    if (!expiresAt || !refreshToken) return;
    const expiresMs = new Date(expiresAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() > expiresMs - sevenDays) {
      logger.info("LinkedIn token expiring within 7 days — auto-refreshing…");
      try {
        const result = await refreshLinkedInToken();
        if (result.ok) {
          logger.info(
            `LinkedIn token auto-refreshed, new expiry: ${result.expiresAt}`,
          );
        } else {
          logger.warn(`LinkedIn auto-refresh failed: ${result.error}`);
        }
      } catch (err) {
        logger.warn(
          `LinkedIn auto-refresh error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  void checkLinkedInRefresh();
  setInterval(() => void checkLinkedInRefresh(), 24 * 60 * 60 * 1000);

  // YouTube/Google OAuth: auto-refresh token if expiry is within 30 minutes
  const checkYouTubeRefresh = async () => {
    const expiresAt = process.env.YOUTUBE_TOKEN_EXPIRES_AT;
    const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
    if (!expiresAt || !refreshToken) return;
    const expiresMs = new Date(expiresAt).getTime();
    const thirtyMinutes = 30 * 60 * 1000;
    if (Date.now() > expiresMs - thirtyMinutes) {
      logger.info(
        "YouTube token expiring within 30 minutes — auto-refreshing…",
      );
      try {
        const result = await refreshYouTubeToken();
        if (result.ok) {
          logger.info(
            `YouTube token auto-refreshed, new expiry: ${result.expiresAt}`,
          );
          // Restart youtube MCP server so the new subprocess picks up the fresh token
          if (localServerManager.isRunning("youtube")) {
            try {
              await localServerManager.restartServer("youtube");
              logger.info("YouTube MCP server restarted with refreshed token");
            } catch (restartErr) {
              logger.warn(
                `YouTube MCP server restart failed: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
              );
            }
          }
        } else {
          logger.warn(`YouTube auto-refresh failed: ${result.error}`);
        }
      } catch (err) {
        logger.warn(
          `YouTube auto-refresh error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  void checkYouTubeRefresh();
  // Google access tokens expire in 1 hour — check every 15 minutes
  setInterval(() => void checkYouTubeRefresh(), 15 * 60 * 1000);

  // Start the media queue push loop
  if (process.env.QUEUE_ENABLED !== "false") {
    // Sub-issue #1010 \u2014 opt-in auto-start of CUDA sidecars before the queue
    // begins polling. When `media.autoStartSidecars` is true and the FluxQ
    // health endpoint is unreachable, spawn the platform-appropriate
    // `scripts/media-ctl.{ps1,sh}` start command (detached, ignored stdio,
    // unref'd) and poll for readiness up to 60 s. Failures are logged but
    // do NOT abort startup \u2014 the queue worker recovers when sidecars
    // come up later.
    if (config.media?.autoStartSidecars) {
      const healthUrl =
        config.media.sidecarHealthUrl ?? "http://127.0.0.1:5005/health";
      logger.info(
        `[Sidecars] media.autoStartSidecars=true \u2014 ensuring sidecar at ${healthUrl}`,
      );
      try {
        const result = await ensureSidecarsRunning({
          healthUrl,
          // Polish (#1014): default extended to 120 s to cover CUDA cold-start
          // (model checkpoint load + first-time kernel compile) on Windows/WSL2.
          timeoutMs: config.media.startupTimeoutMs ?? 120_000,
          repoRoot: process.cwd(),
        });
        if (result.ready) {
          logger.info(
            `[Sidecars] Ready in ${result.durationMs}ms (started=${result.started})`,
          );
        } else {
          logger.warn(
            `[Sidecars] NOT ready after ${result.durationMs}ms (started=${result.started}): ${result.error ?? "timeout"}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Sidecars] Auto-start failed: ${msg}`);
      }
    }

    // Register all queueMaster listeners BEFORE queueMaster.start() so no
    // `job:complete` event can be dropped in the wire-up window. Sub-issue
    // #1010 — the QueueMaster successfully dispatches pitch txt2img jobs
    // to FluxQ and emits `job:complete` when the callback fires, but
    // without this listener the result PNG is never copied into
    // `~/.openzigs/pitch/assets/{deckId}/` and the slide content slot is
    // never patched. The dispatch path was always working; the bookkeeping
    // listener was never wired. (PR #1013 review fix: previously the
    // registration happened after .start(), creating a race window.)
    pitchImageCompletionRegistration = registerImageCompletionListener({
      queueMaster,
      pitchRepo,
      auditLogger,
      // Bug-fix (post-PR-#1024 walkthrough): PR #1023's FluxQ refactor
      // changed `MediaJob.resultUrl` from a local filesystem path to a
      // REST URL (`/api/queue/assets/file/<filename>`). The pitch
      // listener was still treating it as a path and feeding it to
      // `fs.copyFile()`, which on Windows resolved the leading slash to
      // drive root (`C:\api\queue\assets\file\...`) and ENOENT'd. Plumb
      // the same `galleryDir` QueueMaster persists asset bytes into so
      // the listener can invert URL\u2192path.
      galleryDir: path.join(os.homedir(), ".openzigs", "gallery"),
      // Bug-fix (post-PR-#1017 walkthrough): when a Pitch image job
      // completes (success or retries-exhausted failure), broadcast over
      // Socket.IO so the deck editor's `useSlideImageStatus` hook flips
      // the slot from `queued` to `ready` / `failed`. Without these the
      // "Generate all images" button hangs at "Generating 0 / N" forever.
      onPitchImageReady: (info) => {
        io.emit("pitch:image:ready", info);
      },
      onPitchImageFailed: (info) => {
        io.emit("pitch:image:failed", info);
      },
    });
    logger.info("[Pitch] Image completion listener registered");

    // Broadcast job events to all connected UI clients via Socket.IO
    queueMaster.on("job:complete", (job) => {
      io.emit("queue:job:complete", {
        jobId: job.id,
        type: job.type,
        status: job.status,
        resultUrl: job.resultUrl,
        galleryAssetId: job.galleryAssetId,
      });
    });
    queueMaster.on("job:failed", (job, error) => {
      io.emit("queue:job:failed", { jobId: job.id, type: job.type, error });
    });
    queueMaster.on("job:dispatched", (job) => {
      io.emit("queue:job:dispatched", { jobId: job.id, type: job.type });
    });
    queueMaster.on("job:progress", (jobId, progress) => {
      io.emit("queue:job:progress", { jobId, ...progress });
    });

    // Notify Telegram when an entire project's queue is complete
    queueMaster.on("project:complete", (projectId: string, total: number) => {
      const telegram = channelManager.getChannel("telegram");
      const chatId = config.channels?.telegram?.adminUserId;
      if (telegram && chatId) {
        const text = `✅ Project "${projectId}" — all ${total} media jobs complete. Assets ready in Gallery.`;
        void telegram.sendMessage(chatId, { text }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[QueueMaster] Telegram notification failed: ${msg}`);
        });
      }
    });

    // All listeners are now wired — safe to start the push loop.
    queueMaster.start();
    logger.info(
      `[QueueMaster] Push orchestrator started (callback: ${process.env.QUEUE_CALLBACK_URL ?? `http://${getLanIp()}:${port}/api/queue/complete`})`,
    );
  }

  void auditLogger.log({
    level: "info",
    category: "system",
    event: "server_started",
    details: { port },
  });

  if (tunnel) {
    tunnel.on("connected", (publicUrl) => {
      logger.info(`Public URL: ${publicUrl}`);
      setTunnelPublicUrl(publicUrl);
      // Route worker callbacks through the tunnel so they bypass LAN/AP isolation
      queueMaster.setCallbackUrl(`${publicUrl}/api/queue/complete`);
    });
    tunnel.on("disconnected", () => {
      logger.warn("Cloudflare tunnel disconnected");
      setTunnelPublicUrl(null);
      // Fall back to LAN IP for callbacks
      queueMaster.setCallbackUrl(
        `http://${getLanIp()}:${port}/api/queue/complete`,
      );
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
  socialIngestion.stopAllPolling();
  outboxPoller.stop();
  queueMaster.stop();
  pitchImageCompletionRegistration?.dispose();
  pitchImageCompletionRegistration = null;
  subagentRelay.dispose();
  firecrawlWebhookHandler?.shutdown();
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
