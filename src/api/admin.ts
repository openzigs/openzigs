import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { loadConfig, customAgentSchema, mcpServerConfigSchema, nativeMcpServersSchema } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";
import type { ToolRegistry, RiskLevel } from "../mcp/tool-registry.js";
import type { CopilotWrapper } from "../copilot/index.js";
import type { ReasoningEffort, ProviderConfig, CustomAgentDefinition, NativeMcpServerDefinition } from "../copilot/index.js";
import type { DockerSidecarManager } from "../mcp/docker-sidecar-manager.js";
import type { LocalMcpServerManager } from "../mcp/local-mcp-server-manager.js";
import { type PromptManager, interpolateTemplate } from "../productivity/prompt-manager.js";
import type { Scheduler } from "../productivity/scheduler.js";
import type { PersonalityManager } from "../personality/personality-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { postActionRegistry } from "../tasks/post-action-registry.js";
import type { CustomPostActionManager } from "../tasks/custom-post-actions.js";
import type { TaskWorker } from "../tasks/task-worker.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { PipelineStage } from "../tasks/types.js";
import { PipelinePlanner } from "../tasks/pipeline-planner.js";
import type { WebhookManager } from "../webhooks/webhook-manager.js";
import { getUserSelectedModel } from "../config/user-model.js";
import type { SentinelService } from "../sentinel/index.js";
import type { KnowledgeIngestionService } from "../knowledge/index.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import { SentinelConfigSchema, readStatusMarkdown } from "../sentinel/index.js";
import { TemplateService } from "../productivity/template-service.js";
import { CopilotNativeMcpTester, type NativeMcpDiscoveredTool, type NativeMcpTester } from "../mcp/native-mcp-test-service.js";
import { AVAILABLE_VOICES } from "../voice/types.js";
import { loadSkillMetadata } from "../skills/skill-loader.js";
import type { PipelineTemplateManager } from "../productivity/pipeline-template-manager.js";
import type { Server as SocketIOServer } from "socket.io";

let _adminIo: SocketIOServer | null = null;
export function setAdminIO(io: SocketIOServer): void { _adminIo = io; }

type EnvEntry = {
  name: string;
  configured: boolean;
};

// ── Cron field matcher (for dry-run next-runs computation) ──────────────────
function matchCronField(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    if (part.includes("/")) {
      const [base, step] = part.split("/");
      const s = parseInt(step, 10);
      const b = base === "*" ? 0 : parseInt(base, 10);
      return (value - b) % s === 0 && value >= b;
    }
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(part, 10) === value;
  });
}

// ── Pinterest OAuth state ──────────────────────────────────────────────────
/** CSRF state tokens for pending Pinterest OAuth flows (short-lived, single-user) */
export const pinterestOAuthStates = new Map<string, number>();

/** Refresh the Pinterest access token using the stored refresh token. */
export async function refreshPinterestToken(): Promise<{ ok: boolean; expiresAt?: string; error?: string }> {
  const appId = (process.env.PINTEREST_APP_ID ?? "").trim();
  const appSecret = (process.env.PINTEREST_APP_SECRET ?? "").trim();
  const refreshToken = (process.env.PINTEREST_REFRESH_TOKEN ?? "").trim();

  if (!appId || !appSecret || !refreshToken) {
    return { ok: false, error: "Missing PINTEREST_APP_ID, PINTEREST_APP_SECRET, or PINTEREST_REFRESH_TOKEN" };
  }

  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return { ok: false, error: `Pinterest token refresh failed (${tokenRes.status}): ${errText}` };
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
  };

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  const envPath = defaultEnvPath();
  const updates: Record<string, string> = {
    PINTEREST_ACCESS_TOKEN: tokenData.access_token,
    PINTEREST_TOKEN_EXPIRES_AT: expiresAt,
  };
  if (tokenData.refresh_token) {
    updates.PINTEREST_REFRESH_TOKEN = tokenData.refresh_token;
    process.env.PINTEREST_REFRESH_TOKEN = tokenData.refresh_token;
  }
  await upsertEnvFile(envPath, updates);
  process.env.PINTEREST_ACCESS_TOKEN = tokenData.access_token;
  process.env.PINTEREST_TOKEN_EXPIRES_AT = expiresAt;

  logger.info(`Pinterest access token refreshed, expires at ${expiresAt}`);
  return { ok: true, expiresAt };
}

/** Exchange a Pinterest authorization code for access + refresh tokens. */
export async function exchangePinterestCode(code: string): Promise<{
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  error?: string;
}> {
  const appId = (process.env.PINTEREST_APP_ID ?? "").trim();
  const appSecret = (process.env.PINTEREST_APP_SECRET ?? "").trim();

  if (!appId || !appSecret) {
    return { ok: false, error: "PINTEREST_APP_ID and PINTEREST_APP_SECRET must be configured" };
  }

  const backendPort = Number(process.env.PORT ?? 3000);
  const redirectUri = (process.env.PINTEREST_REDIRECT_URI ?? "").trim() || `http://localhost:${backendPort}/api/pinterest/oauth/callback`;
  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");

  const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      continuous_refresh: "true",
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return { ok: false, error: `Pinterest token exchange failed (${tokenRes.status}): ${errText}` };
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
    scope: string;
  };

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  const envPath = defaultEnvPath();
  await upsertEnvFile(envPath, {
    PINTEREST_ACCESS_TOKEN: tokenData.access_token,
    PINTEREST_REFRESH_TOKEN: tokenData.refresh_token,
    PINTEREST_TOKEN_EXPIRES_AT: expiresAt,
  });
  process.env.PINTEREST_ACCESS_TOKEN = tokenData.access_token;
  process.env.PINTEREST_REFRESH_TOKEN = tokenData.refresh_token;
  process.env.PINTEREST_TOKEN_EXPIRES_AT = expiresAt;

  logger.info(`Pinterest OAuth completed — token expires at ${expiresAt}, scopes: ${tokenData.scope}`);
  return {
    ok: true,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scope: tokenData.scope,
  };
}

const PINTEREST_DAILY_JOB_NAME = "Daily Pinterest Trends & Metrics";

const PINTEREST_DAILY_PROMPT_NAME = "Daily Pinterest Trends & Metrics";

const PINTEREST_DAILY_PROMPT_TEMPLATE = {
  name: PINTEREST_DAILY_PROMPT_NAME,
  template:
    "Fetch growing Pinterest trends for the {{region}} market using the pinterest-trends tool " +
    "(region: {{region}}, trend_type: {{trend_type}}, limit: {{limit}}).\n\n" +
    "Then run pinterest-content-ideas for the topic '{{topic}}' to discover keyword opportunities.\n\n" +
    "Finally, for each active pin in the tracker, fetch its latest metrics from the Pinterest API " +
    "and record a new snapshot.\n\n" +
    "Save a brief summary of today's top trends and any new content ideas to a file.",
  description: "Daily Pinterest trend discovery, content ideation, and pin metric snapshots",
  tags: ["pinterest", "seo", "daily", "automated"],
  preferredTools: ["pinterest-trends", "pinterest-content-ideas", "pinterest-related-keywords"] as string[],
  suggestedSkill: "pinterest-marketer",
};

/**
 * Idempotently creates the daily Pinterest trends saved prompt + scheduled job.
 * Called whenever a Pinterest access token is saved so the job is always present
 * when the integration is active. Safe to call multiple times.
 */
export function ensurePinterestScheduledJob(scheduler: Scheduler, promptManager?: PromptManager): void {
  // Ensure the saved prompt exists (if prompt manager is available)
  if (promptManager && !promptManager.getByName(PINTEREST_DAILY_PROMPT_NAME)) {
    try {
      promptManager.create(PINTEREST_DAILY_PROMPT_TEMPLATE);
      logger.info("[Pinterest] Created daily trends saved prompt");
    } catch {
      // Prompt may already exist from another call — safe to ignore
    }
  }

  if (scheduler.getByName(PINTEREST_DAILY_JOB_NAME)) return;
  try {
    scheduler.create({
      name: PINTEREST_DAILY_JOB_NAME,
      cronExpression: "0 8 * * *",
      timezone: "America/New_York",
      actionType: "prompt",
      actionPayload: {
        promptName: PINTEREST_DAILY_PROMPT_NAME,
        skillName: "pinterest-marketer",
        variables: {
          region: "US",
          trend_type: "growing",
          limit: "20",
          topic: "AI automation productivity",
        },
      },
      autoApproveTools: ["pinterest-trends", "pinterest-content-ideas"],
    });
    logger.info("[Pinterest] Created daily trends & metrics scheduled job");
  } catch (err) {
    logger.warn(
      `[Pinterest] Failed to create daily scheduled job: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const ENV_CHECKS = [
  "BRAVE_API_KEY",
  "CHROME_DEBUG_HOST",
  "CHROME_DEBUG_PORT",
  "OPENZIGS_ALLOWED_DIRS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_CLIENT_ID",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "LINKEDIN_ACCESS_TOKEN",
  "TWITTER_BEARER_TOKEN",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "FACEBOOK_PAGE_TOKEN",
  "PINTEREST_APP_ID",
  "PINTEREST_APP_SECRET",
  "PINTEREST_ACCESS_TOKEN",
  "PINTEREST_AD_ACCOUNT_ID",
  "GOOGLE_OAUTH_CREDENTIALS",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "JDBC_URL",
  "DB_PASSWORD",
  "INSTAGRAM_ACCESS_TOKEN",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "INSTAGRAM_BUSINESS_ACCOUNT_ID",
  "YOUTUBE_API_KEY",
] as const;

/**
 * @deprecated All MCP servers have been migrated to native subprocess transport.
 * Docker sidecars are no longer used for MCP. This type is retained for backward
 * compatibility with any consumers of the /api/admin/sidecars endpoint.
 */
type SidecarCredential = {
  platform: string;
  label: string;
  imageAvailable: boolean;
  enabled: boolean;
  envVars: { name: string; configured: boolean }[];
};

type LocalServerCredential = {
  server: string;
  label: string;
  runtime: string;
  envVars: { name: string; configured: boolean }[];
};

const LOCAL_SERVER_CREDENTIALS: Array<{ server: string; label: string; runtime: string; envVars: string[] }> = [
  // Non-social servers (migrated from Docker sidecars — Issue #312)
  { server: "markitdown", label: "MarkItDown", runtime: "python", envVars: [] },
  { server: "gmail", label: "Gmail", runtime: "node", envVars: ["GOOGLE_OAUTH_CREDENTIALS"] },
  { server: "database", label: "Database (JDBC)", runtime: "other", envVars: ["JDBC_URL", "DB_PASSWORD"] },
  { server: "github", label: "GitHub", runtime: "node", envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  { server: "word", label: "Word / Office", runtime: "python", envVars: [] },
  { server: "calendar", label: "Google Calendar", runtime: "node", envVars: ["GOOGLE_OAUTH_CREDENTIALS"] },
  // Social platform servers (Issue #301–#305)
  {
    server: "instagram",
    label: "Instagram",
    runtime: "python",
    envVars: ["INSTAGRAM_ACCESS_TOKEN", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_BUSINESS_ACCOUNT_ID"],
  },
  {
    server: "facebook",
    label: "Facebook / Meta Pages",
    runtime: "python",
    envVars: ["FACEBOOK_PAGE_TOKEN", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
  },
  {
    server: "twitter",
    label: "Twitter / X",
    runtime: "python",
    envVars: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"],
  },
  {
    server: "youtube",
    label: "YouTube",
    runtime: "python",
    envVars: ["YOUTUBE_API_KEY"],
  },
  {
    server: "linkedin",
    label: "LinkedIn",
    runtime: "python",
    envVars: ["LINKEDIN_ACCESS_TOKEN"],
  },
  {
    server: "reddit",
    label: "Reddit",
    runtime: "python",
    envVars: [],
  },
];

// ── .env file helpers ──

const defaultEnvPath = () =>
  path.resolve(process.env.OPENZIGS_ENV_PATH ?? path.join(process.cwd(), ".env"));

/**
 * Upsert key=value pairs into a .env file, preserving comments and ordering.
 * New keys are appended under a dedicated "# MCP Credentials" section.
 */
const upsertEnvFile = async (envPath: string, updates: Record<string, string>): Promise<void> => {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch {
    // File doesn't exist yet — will create
  }

  const lines = content.split("\n");
  const remaining = new Map(Object.entries(updates));

  // Update existing lines in-place
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  // Append new keys — only add the section header if it isn't already present
  if (remaining.size > 0) {
    const alreadyHasSection = updatedLines.some((l) => l.trim() === "# MCP Credentials");
    if (!alreadyHasSection) {
      updatedLines.push("");
      updatedLines.push("# MCP Credentials");
    }
    for (const [key, value] of remaining) {
      updatedLines.push(`${key}=${value}`);
    }
  }

  await fs.writeFile(envPath, updatedLines.join("\n"), { encoding: "utf-8", mode: 0o600 });
};

const TELEGRAM_TOKEN_PLACEHOLDER = "${TELEGRAM_BOT_TOKEN}";
const DISCORD_TOKEN_PLACEHOLDER = "${DISCORD_BOT_TOKEN}";

const defaultConfigPath = () => process.env.OPENZIGS_CONFIG_PATH
  ?? path.join(os.homedir(), ".openzigs", "config.json");

const readUserConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeUserConfig = async (configPath: string, data: Record<string, unknown>) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
};

/** Read user config, update a single key under `copilot`, and write back. */
const updateCopilotConfig = async (key: string, value: unknown) => {
  const configPath = defaultConfigPath();
  const userConfig = await readUserConfig(configPath);
  const existingCopilot = (userConfig.copilot && typeof userConfig.copilot === "object")
    ? (userConfig.copilot as Record<string, unknown>)
    : {};
  existingCopilot[key] = value;
  userConfig.copilot = existingCopilot;
  await writeUserConfig(configPath, userConfig);
};

/** Read user config, update keys under `voice`, and write back. */
const updateVoiceConfig = async (updates: Record<string, unknown>) => {
  const configPath = defaultConfigPath();
  const userConfig = await readUserConfig(configPath);
  const existingVoice = (userConfig.voice && typeof userConfig.voice === "object")
    ? (userConfig.voice as Record<string, unknown>)
    : {};
  userConfig.voice = { ...existingVoice, ...updates };
  await writeUserConfig(configPath, userConfig);
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
};

type NativeMcpToolCache = Record<string, {
  tools: NativeMcpDiscoveredTool[];
  connected: boolean;
  error?: string;
  updatedAt: string;
}>;

const getNativeMcpToolCache = (config: Record<string, unknown>): NativeMcpToolCache => {
  const copilot = (config.copilot && typeof config.copilot === "object")
    ? (config.copilot as Record<string, unknown>)
    : {};
  const raw = (copilot.nativeMcpToolCache && typeof copilot.nativeMcpToolCache === "object")
    ? (copilot.nativeMcpToolCache as Record<string, unknown>)
    : {};

  const cache: NativeMcpToolCache = {};
  for (const [serverName, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const toolsRaw = Array.isArray(obj.tools) ? obj.tools : [];
    const tools = toolsRaw
      .map((tool) => {
        if (!tool || typeof tool !== "object") return null;
        const t = tool as Record<string, unknown>;
        const name = typeof t.name === "string" ? t.name.trim() : "";
        if (!name) return null;
        const description = typeof t.description === "string" ? t.description : "";
        return { name, description };
      })
      .filter((tool): tool is NativeMcpDiscoveredTool => !!tool);

    cache[serverName] = {
      tools,
      connected: obj.connected !== false,
      error: typeof obj.error === "string" ? obj.error : undefined,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
    };
  }
  return cache;
};

const setNativeMcpToolCache = async (cache: NativeMcpToolCache) => {
  await updateCopilotConfig("nativeMcpToolCache", cache);
};

export type AdminRouterOptions = {
  toolRegistry: ToolRegistry;
  sidecarManager?: DockerSidecarManager;
  localServerManager?: LocalMcpServerManager;
  promptManager?: PromptManager;
  scheduler?: Scheduler;
  personalityManager?: PersonalityManager;
  sessionManager?: SessionManager;
  copilot?: CopilotWrapper;
  taskWorker?: TaskWorker;
  taskEngine?: TaskEngine;
  webhookManager?: WebhookManager;
  customPostActionManager?: CustomPostActionManager;
  sentinel?: SentinelService;
  knowledgeService?: KnowledgeIngestionService;
  brandVoiceService?: BrandVoiceService;
  nativeMcpTester?: NativeMcpTester;
  pipelineTemplateManager?: PipelineTemplateManager;
};

type SchedulerSuggestion = {
  name: string;
  actionType: "prompt" | "shell" | "custom";
  cronExpression: string;
  timezone: string;
  promptName?: string;
  actionPayload?: Record<string, unknown>;
  model?: string;
};

const extractJsonBlock = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
};

const normalizeSchedulerSuggestion = (
  raw: unknown,
  promptNames: string[]
): SchedulerSuggestion => {
  const data = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const promptName = typeof data.promptName === "string" ? data.promptName.trim() : "";
  const actionType = (data.actionType === "prompt" || data.actionType === "shell" || data.actionType === "custom")
    ? data.actionType
    : (promptName ? "prompt" : "custom");
  const actionPayload = (data.actionPayload && typeof data.actionPayload === "object" && !Array.isArray(data.actionPayload))
    ? (data.actionPayload as Record<string, unknown>)
    : undefined;
  const model = typeof data.model === "string" ? data.model.trim() : undefined;
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "scheduled-job";
  const cronExpression = typeof data.cronExpression === "string" ? data.cronExpression.trim() : "";
  const timezone = typeof data.timezone === "string" && data.timezone.trim() ? data.timezone.trim() : "UTC";
  const promptNameValid = promptName && promptNames.includes(promptName);

  return {
    name,
    actionType,
    cronExpression,
    timezone,
    promptName: promptNameValid ? promptName : undefined,
    actionPayload,
    model: model || undefined,
  };
};

const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

const parseReasoningEffort = (value: unknown): ReasoningEffort | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VALID_REASONING_EFFORTS.has(trimmed as ReasoningEffort)
    ? (trimmed as ReasoningEffort)
    : undefined;
};

export const createAdminRouter = ({ toolRegistry, sidecarManager, localServerManager, promptManager, scheduler, personalityManager, sessionManager, copilot, taskWorker, taskEngine, webhookManager, customPostActionManager, sentinel, brandVoiceService, nativeMcpTester, pipelineTemplateManager }: AdminRouterOptions): Router => {
  const router = Router();
  const mcpTester = nativeMcpTester ?? new CopilotNativeMcpTester();

  // ── Server Restart ──
  // In dev mode, tsx watch only restarts on file changes — process.exit()
  // just kills the process permanently.  We touch the server entry-point
  // to trigger a genuine watch-based restart.  In prod (node / pm2),
  // process.exit(0) still works because the process manager handles respawns.
  router.post("/restart", async (_req, res) => {
    logger.info("Server restart requested via admin API");
    res.json({ ok: true, message: "Server restarting…" });

    setTimeout(async () => {
      const isDev = !!process.env.npm_lifecycle_script?.includes("tsx watch");
      if (isDev) {
        // Touch the entry-point so tsx watch picks up the "change"
        const entry = path.resolve(process.cwd(), "src", "server.ts");
        try {
          const now = new Date();
          await fs.utimes(entry, now, now);
          logger.info("Touched src/server.ts to trigger tsx watch restart");
        } catch {
          // Fallback: exit and hope a process manager picks up
          process.exit(0);
        }
      } else {
        process.exit(0);
      }
    }, 500);
  });

  router.get("/tools", async (_req, res) => {
    const tools = toolRegistry.getAllTools() as unknown as Record<string, Array<{
      name: string;
      description: string;
      category: string;
      riskLevel: string;
      enabled: boolean;
      source?: string;
      globalApprovalRequired?: boolean;
    }>>;

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      const nativeServers = copilot?.getNativeMcpServers() ?? {};

      for (const [serverName, entry] of Object.entries(cache)) {
        const groupName = `user mcp: ${serverName}`;
        const serverDef = nativeServers[serverName];
        const configuredTools = serverDef?.tools;

        const visibleTools = entry.tools.map((tool) => {
          const enabled = !configuredTools || configuredTools.includes("*") || configuredTools.includes(tool.name);
          return {
            name: `mcp:${serverName}:${tool.name}`,
            description: tool.description || "MCP-discovered tool",
            category: groupName,
            riskLevel: "medium",
            enabled,
            source: `mcp:${serverName}`,
          };
        });

        const disconnectedMarker = entry.connected
          ? []
          : [{
              name: `mcp:${serverName}:__disconnected__`,
              description: `⚠️ Disconnected — tools unavailable${entry.error ? ` (${entry.error})` : ""}`,
              category: groupName,
              riskLevel: "medium",
              enabled: false,
              source: `mcp:${serverName}`,
            }];

        tools[groupName] = [...visibleTools, ...disconnectedMarker];
      }
    } catch {
      // Non-fatal: return core tool groups even if cache read fails
    }

    res.json({ tools });
  });

  router.post("/tools/:name/toggle", async (req, res) => {
    const { name } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    if (toolRegistry.getToolDefinition(name)) {
      try {
        await toolRegistry.setEnabled(name, enabled);
        return res.json({ ok: true, tool: name, enabled });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    }

    if (name.startsWith("mcp:")) {
      const parts = name.split(":");
      if (parts.length < 3) {
        return res.status(400).json({ error: "Invalid MCP tool identifier" });
      }
      const serverName = parts[1];
      const toolName = parts.slice(2).join(":");
      if (toolName === "__disconnected__") {
        return res.status(400).json({ error: "Cannot toggle disconnected marker" });
      }

      if (!copilot) {
        return res.status(503).json({ error: "Copilot service unavailable" });
      }

      const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
      const activeCount = stats.running + stats.queued;
      if (activeCount > 0) {
        return res.status(409).json({
          error: `Cannot update MCP configuration while ${activeCount} task(s) are active. Please wait for tasks to complete or cancel them.`,
          activeCount,
          tasks: { running: stats.running, queued: stats.queued },
        });
      }

      const current = copilot.getNativeMcpServers();
      const server = current[serverName];
      if (!server) {
        return res.status(404).json({ error: `Server '${serverName}' not found` });
      }

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      const discovered = (cache[serverName]?.tools ?? []).map((tool) => tool.name);
      if (discovered.length === 0) {
        return res.status(400).json({ error: `No discovered tools found for server '${serverName}'. Re-test the server first.` });
      }

      const existingTools = Array.isArray(server.tools) ? [...server.tools] : ["*"];
      const explicitlyListed = existingTools.includes("*") ? [...discovered] : [...existingTools];
      const nextSet = new Set(explicitlyListed);
      if (enabled) nextSet.add(toolName);
      else nextSet.delete(toolName);

      const nextTools = discovered.filter((t) => nextSet.has(t));
      const nextServer: NativeMcpServerDefinition = { ...server, tools: nextTools };
      const updated = { ...current, [serverName]: nextServer };

      copilot.setNativeMcpServers(updated);
      await updateCopilotConfig("nativeMcpServers", updated);
      return res.json({ ok: true, tool: name, enabled });
    }

    return res.status(404).json({ error: `Unknown tool: ${name}` });
  });

  // ── Admin Risk Override ──
  router.post("/tools/:name/risk", async (req, res) => {
    const { name } = req.params;
    const { riskLevel } = req.body as { riskLevel?: string };
    if (!riskLevel || !["low", "medium", "high"].includes(riskLevel)) {
      return res.status(400).json({ error: "riskLevel must be 'low', 'medium', or 'high'" });
    }
    try {
      await toolRegistry.setRiskOverride(name, riskLevel as RiskLevel);
      return res.json({ ok: true, tool: name, riskLevel });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  // ── Global Approval Lock Toggle ──
  router.post("/tools/:name/global-approval", async (req, res) => {
    const { name } = req.params;
    const { required } = req.body as { required?: boolean };
    if (typeof required !== "boolean") {
      return res.status(400).json({ error: "required must be a boolean" });
    }
    try {
      await toolRegistry.setGlobalApprovalOverride(name, required);
      return res.json({ ok: true, tool: name, globalApprovalRequired: required });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  /**
   * @deprecated Redirects to local-server tools endpoint.
   * Kept for backward compatibility with older UI builds.
   */
  router.get("/sidecars/:name/tools", (_req, res) => {
    const { name } = _req.params;
    const dynamicTools = toolRegistry.getToolsBySource(name);
    if (dynamicTools.length > 0) {
      return res.json({ sidecar: name, tools: dynamicTools });
    }
    const crossPlatformTools = toolRegistry.getToolsBySource("social");
    if (crossPlatformTools.length > 0) {
      return res.json({ sidecar: name, tools: crossPlatformTools });
    }
    return res.json({ sidecar: name, tools: [] });
  });

  /** @deprecated Use /api/admin/local-servers/:name/tools instead. */
  router.put("/sidecars/:name/tools", async (_req, res) => {
    return res.status(410).json({
      error: "Docker MCP sidecars have been deprecated. Use local-server tool management instead.",
    });
  });

  router.get("/env", (_req, res) => {
    const env: EnvEntry[] = ENV_CHECKS.map((name) => ({
      name,
      configured: !!(process.env[name] && process.env[name]!.trim().length > 0)
    }));
    res.json({ env });
  });

  router.get("/allowed-dirs", (_req, res) => {
    const value = (process.env.OPENZIGS_ALLOWED_DIRS ?? "").trim();
    res.json({ value });
  });

  router.post("/allowed-dirs", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rawValue = typeof body.value === "string" ? body.value : "";
    const normalized = rawValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(",");

    try {
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, { OPENZIGS_ALLOWED_DIRS: normalized });

      if (normalized) {
        process.env.OPENZIGS_ALLOWED_DIRS = normalized;
      } else {
        delete process.env.OPENZIGS_ALLOWED_DIRS;
      }

      logger.info("Updated OPENZIGS_ALLOWED_DIRS via admin UI");
      return res.json({ ok: true, value: normalized, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/voice-tts-credentials", (_req, res) => {
    const value = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
    res.json({ value });
  });

  router.post("/voice-tts-credentials", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rawValue = typeof body.value === "string" ? body.value : "";
    const normalized = rawValue.trim();

    try {
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: normalized });

      if (normalized) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = normalized;
      } else {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }

      logger.info("Updated GOOGLE_APPLICATION_CREDENTIALS via admin UI");
      return res.json({ ok: true, value: normalized, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/voice-settings", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const voiceConfig = (userConfig.voice && typeof userConfig.voice === "object")
        ? (userConfig.voice as Record<string, unknown>)
        : {};
      const configuredVoice = typeof voiceConfig.voiceName === "string" ? voiceConfig.voiceName.trim() : "";
      const currentVoiceName = configuredVoice || "en-US-Standard-C";
      return res.json({
        voiceName: currentVoiceName,
        recommendedFreeTierVoice: "en-US-Standard-C",
        availableVoices: AVAILABLE_VOICES,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/voice-settings", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const voiceName = typeof body.voiceName === "string" ? body.voiceName.trim() : "";

    if (!voiceName) {
      return res.status(400).json({ error: "voiceName is required" });
    }

    const validVoice = AVAILABLE_VOICES.some((voice) => voice.id === voiceName);
    if (!validVoice) {
      return res.status(400).json({ error: `Unsupported voice: ${voiceName}` });
    }

    try {
      await updateVoiceConfig({ voiceName });
      logger.info(`Updated voice.voiceName via admin UI: ${voiceName}`);
      return res.json({ ok: true, voiceName, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Full voice configuration (all fields) ──

  router.get("/voice-config", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const voiceConfig = (userConfig.voice && typeof userConfig.voice === "object")
        ? (userConfig.voice as Record<string, unknown>)
        : {};
      return res.json({
        enabled: voiceConfig.enabled ?? false,
        provider: voiceConfig.provider ?? "google",
        voiceName: voiceConfig.voiceName ?? "en-US-Standard-C",
        speakingRate: voiceConfig.speakingRate ?? 1.0,
        pitch: voiceConfig.pitch ?? 0.0,
        sidecarUrl: voiceConfig.sidecarUrl ?? "http://localhost:5006",
        maxTextLength: voiceConfig.maxTextLength ?? 5000,
        maxCacheSizeMb: voiceConfig.maxCacheSizeMb ?? 500,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/voice-config", async (req, res) => {
    const body = req.body as Record<string, unknown>;

    const updates: Record<string, unknown> = {};

    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
    if (body.provider === "google" || body.provider === "local") updates.provider = body.provider;
    if (typeof body.voiceName === "string" && body.voiceName.trim()) updates.voiceName = body.voiceName.trim();
    if (typeof body.sidecarUrl === "string") updates.sidecarUrl = body.sidecarUrl.trim();

    if (typeof body.speakingRate === "number") {
      const rate = Math.max(0.25, Math.min(4.0, body.speakingRate));
      updates.speakingRate = rate;
    }
    if (typeof body.pitch === "number") {
      const pitch = Math.max(-20, Math.min(20, body.pitch));
      updates.pitch = pitch;
    }
    if (typeof body.maxTextLength === "number" && body.maxTextLength >= 1) {
      updates.maxTextLength = Math.floor(body.maxTextLength);
    }
    if (typeof body.maxCacheSizeMb === "number" && body.maxCacheSizeMb >= 1) {
      updates.maxCacheSizeMb = Math.floor(body.maxCacheSizeMb);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    try {
      await updateVoiceConfig(updates);
      logger.info(`Updated voice config via admin UI: ${JSON.stringify(updates)}`);
      return res.json({ ok: true, updated: updates, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/channels", async (_req, res) => {
    try {
      const config = await loadConfig();
      const telegram = config.channels?.telegram;
      const discord = config.channels?.discord;
      return res.json({
        channels: {
          telegram: {
            enabled: telegram?.enabled ?? false,
            webhookUrl: telegram?.webhookUrl ?? "",
            adminUserId: telegram?.adminUserId ?? "",
            allowedUsers: telegram?.allowedUsers ?? [],
            model: telegram?.model ?? ""
          },
          discord: {
            enabled: discord?.enabled ?? false,
            allowedGuilds: discord?.allowedGuilds ?? []
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/channels", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const telegramBody = (body.telegram ?? {}) as Record<string, unknown>;
    const discordBody = (body.discord ?? {}) as Record<string, unknown>;

    const telegramEnabled = telegramBody.enabled === true;
    const discordEnabled = discordBody.enabled === true;

    if (telegramEnabled && !(process.env.TELEGRAM_BOT_TOKEN ?? "").trim()) {
      return res.status(400).json({ error: "TELEGRAM_BOT_TOKEN is required to enable Telegram." });
    }
    if (discordEnabled && !(process.env.DISCORD_BOT_TOKEN ?? "").trim()) {
      return res.status(400).json({ error: "DISCORD_BOT_TOKEN is required to enable Discord." });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingChannels = (userConfig.channels && typeof userConfig.channels === "object")
        ? (userConfig.channels as Record<string, unknown>)
        : {};
      const existingTelegram = (existingChannels.telegram && typeof existingChannels.telegram === "object")
        ? (existingChannels.telegram as Record<string, unknown>)
        : {};
      const existingDiscord = (existingChannels.discord && typeof existingChannels.discord === "object")
        ? (existingChannels.discord as Record<string, unknown>)
        : {};

      const telegramToken = typeof existingTelegram.token === "string" && existingTelegram.token.trim().length > 0
        ? existingTelegram.token
        : TELEGRAM_TOKEN_PLACEHOLDER;
      const discordToken = typeof existingDiscord.token === "string" && existingDiscord.token.trim().length > 0
        ? existingDiscord.token
        : DISCORD_TOKEN_PLACEHOLDER;

      const telegramAllowedUsers = toStringArray(telegramBody.allowedUsers ?? existingTelegram.allowedUsers);
      const discordAllowedGuilds = toStringArray(discordBody.allowedGuilds ?? existingDiscord.allowedGuilds);
      const telegramWebhookUrl = typeof telegramBody.webhookUrl === "string"
        ? telegramBody.webhookUrl.trim()
        : (typeof existingTelegram.webhookUrl === "string" ? existingTelegram.webhookUrl : "");
      const telegramWebhookSecret = typeof telegramBody.webhookSecret === "string"
        ? telegramBody.webhookSecret.trim()
        : (typeof existingTelegram.webhookSecret === "string" ? existingTelegram.webhookSecret : "");
      const telegramAdminUserId = typeof telegramBody.adminUserId === "string"
        ? telegramBody.adminUserId.trim()
        : (typeof existingTelegram.adminUserId === "string" ? existingTelegram.adminUserId : "");
      const telegramModel = typeof telegramBody.model === "string"
        ? telegramBody.model.trim()
        : (typeof existingTelegram.model === "string" ? existingTelegram.model : "");

      const telegramConfig: Record<string, unknown> = {
        enabled: telegramEnabled,
        token: telegramToken,
        allowedUsers: telegramAllowedUsers
      };
      if (telegramWebhookUrl) {
        telegramConfig.webhookUrl = telegramWebhookUrl;
      }
      if (telegramWebhookSecret) {
        telegramConfig.webhookSecret = telegramWebhookSecret;
      }
      if (telegramAdminUserId) {
        telegramConfig.adminUserId = telegramAdminUserId;
      }
      if (telegramModel) {
        telegramConfig.model = telegramModel;
      }

      const discordConfig: Record<string, unknown> = {
        enabled: discordEnabled,
        token: discordToken,
        allowedGuilds: discordAllowedGuilds
      };

      const nextChannels = {
        ...existingChannels,
        telegram: telegramConfig,
        discord: discordConfig
      };

      const nextConfig = {
        ...userConfig,
        channels: nextChannels
      };

      await writeUserConfig(configPath, nextConfig);
      return res.json({ ok: true, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── MCP Sidecar Management (DEPRECATED — all servers migrated to native) ──
  router.get("/sidecars", async (_req, res) => {
    const dockerAvailable = sidecarManager
      ? await sidecarManager.isDockerAvailable()
      : false;

    return res.json({
      sidecars: [],
      configuredSidecars: [],
      credentials: [] as SidecarCredential[],
      dockerAvailable,
      deprecated: true,
      message: "All MCP servers have been migrated to native subprocess transport. Use /api/admin/local-servers instead.",
    });
  });

  /** @deprecated Use local-server toggle instead. */
  router.post("/sidecars/:name/toggle", async (_req, res) => {
    return res.status(410).json({
      error: "Docker MCP sidecars have been deprecated. Use /api/admin/local-servers/:name/toggle instead.",
    });
  });

  // ── Save MCP server credentials (kept at /sidecars/credentials for backward compat) ──
  router.post("/sidecars/credentials", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const credentials = body.credentials as Record<string, string> | undefined;

    if (!credentials || typeof credentials !== "object") {
      return res.status(400).json({ error: "credentials must be an object of { ENV_VAR: value }" });
    }

    const allEnvVars = new Set(LOCAL_SERVER_CREDENTIALS.flatMap((c) => c.envVars));
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (!allEnvVars.has(key)) {
        return res.status(400).json({ error: `Unknown credential: ${key}` });
      }
      if (typeof value !== "string") {
        return res.status(400).json({ error: `Value for ${key} must be a string` });
      }
      filtered[key] = value.trim();
    }

    try {
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, filtered);

      for (const [key, value] of Object.entries(filtered)) {
        if (value) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }

      logger.info(`MCP credentials saved: ${Object.keys(filtered).join(", ")}`);
      return res.json({ ok: true, saved: Object.keys(filtered) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  /** @deprecated Use /api/admin/local-servers/:name/restart instead. */
  router.post("/sidecars/:name/restart", async (_req, res) => {
    return res.status(410).json({
      error: "Docker MCP sidecars have been deprecated. Use /api/admin/local-servers/:name/restart instead.",
    });
  });

  // ── Local MCP Server Management ──
  router.get("/local-servers", async (_req, res) => {
    const statuses = localServerManager?.getAllStatuses() ?? [];
    const definitions = localServerManager?.getDefinitions() ?? [];
    const configured = localServerManager?.getConfiguredServers() ?? [];

    const credentials: LocalServerCredential[] = LOCAL_SERVER_CREDENTIALS.map((cred) => ({
      server: cred.server,
      label: cred.label,
      runtime: cred.runtime,
      envVars: cred.envVars.map((name) => ({
        name,
        configured: !!(process.env[name] && process.env[name]!.trim().length > 0),
      })),
    }));

    return res.json({
      servers: statuses,
      definitions: definitions.map((d) => ({
        name: d.name,
        label: d.label,
        command: d.command,
        args: d.args,
        runtime: d.runtime,
        category: d.category,
        requiresCredentials: d.requiresCredentials,
      })),
      configuredServers: configured,
      credentials,
    });
  });

  router.post("/local-servers/:name/restart", async (req, res) => {
    const { name } = req.params;
    if (!localServerManager) {
      return res.status(503).json({ error: "Local MCP server manager not available" });
    }
    try {
      const status = await localServerManager.restartServer(name);
      if (!status) {
        return res.status(404).json({ error: `Unknown local server: ${name}` });
      }
      return res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Per-Local-Server Tool Listing ──
  router.get("/local-servers/:name/tools", (_req, res) => {
    const { name } = _req.params;

    // Get tools registered in the ToolRegistry via source tag
    const tools = toolRegistry.getToolsBySource(name);
    if (tools.length === 0) {
      return res.status(404).json({ error: `Unknown local server: ${name}` });
    }

    return res.json({ server: name, tools });
  });

  router.post("/local-servers/:name/stop", async (req, res) => {
    const { name } = req.params;
    if (!localServerManager) {
      return res.status(503).json({ error: "Local MCP server manager not available" });
    }
    if (!localServerManager.isRunning(name)) {
      return res.status(404).json({ error: `Server "${name}" is not running` });
    }
    try {
      const status = await localServerManager.restartServer(name);
      return res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Post-Action Registry ──
  router.get("/post-actions", (_req, res) => {
    return res.json({ actions: postActionRegistry.list() });
  });

  // ── Custom Post-Action CRUD ──
  router.get("/post-actions/custom", (_req, res) => {
    if (!customPostActionManager) {
      return res.json({ actions: [] });
    }
    return res.json({ actions: customPostActionManager.list() });
  });

  router.get("/post-actions/custom/:type", (req, res) => {
    if (!customPostActionManager) {
      return res.status(404).json({ error: "Custom post-actions not available" });
    }
    const def = customPostActionManager.getByType(req.params.type);
    return def ? res.json(def) : res.status(404).json({ error: "Not found" });
  });

  /* ── Zod schemas for custom post-action validation ── */
  const customFieldSchema = z.object({
    key: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "array"]),
    title: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    enum: z.array(z.string()).optional(),
    enumLabels: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  });

  const templateConfigSchema = z.record(z.string(), z.unknown());

  const createCustomPostActionSchema = z.object({
    type: z.string().min(1),
    label: z.string().min(1),
    description: z.string().default(""),
    category: z.string().default("Custom"),
    icon: z.string().optional(),
    templateType: z.enum(["webhook", "script"]).optional(),
    templateConfig: templateConfigSchema.optional(),
    customFields: z.array(customFieldSchema).optional(),
    scriptBody: z.string().optional(),
    scriptTimeout: z.number().int().positive().optional(),
  });

  const updateCustomPostActionSchema = z.object({
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    icon: z.string().optional(),
    templateType: z.enum(["webhook", "script"]).optional(),
    templateConfig: templateConfigSchema.optional(),
    customFields: z.array(customFieldSchema).optional(),
    scriptBody: z.string().optional(),
    scriptTimeout: z.number().int().positive().optional(),
  });

  router.post("/post-actions/custom", async (req, res) => {
    if (!customPostActionManager) {
      return res.status(503).json({ error: "Custom post-actions not available" });
    }
    const parsed = createCustomPostActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    try {
      const def = await customPostActionManager.create(parsed.data);
      return res.status(201).json(def);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  router.put("/post-actions/custom/:type", async (req, res) => {
    if (!customPostActionManager) {
      return res.status(503).json({ error: "Custom post-actions not available" });
    }
    const parsed = updateCustomPostActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    try {
      const updated = await customPostActionManager.update(req.params.type, parsed.data);
      return res.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  router.delete("/post-actions/custom/:type", async (req, res) => {
    if (!customPostActionManager) {
      return res.status(503).json({ error: "Custom post-actions not available" });
    }
    const deleted = await customPostActionManager.delete(req.params.type);
    return deleted
      ? res.json({ ok: true })
      : res.status(404).json({ error: "Not found" });
  });

  // ── Saved Prompts (Library) ──
  if (promptManager) {
    router.get("/prompts", (req, res) => {
      const query = typeof req.query.q === "string" ? req.query.q : undefined;
      const prompts = query ? promptManager.search(query) : promptManager.list();
      return res.json({ prompts });
    });

    router.get("/prompts/:id", (req, res) => {
      const prompt = promptManager.getById(req.params.id);
      return prompt
        ? res.json(prompt)
        : res.status(404).json({ error: "Prompt not found" });
    });

    router.post("/prompts", (req, res) => {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const template = typeof body.template === "string" ? body.template : "";
      if (!name || !template) {
        return res.status(400).json({ error: "name and template are required" });
      }
      const MAX_PROMPT_LENGTH = 100_000;
      if (template.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `Prompt template exceeds ${MAX_PROMPT_LENGTH} characters` });
      }
      try {
        const prompt = promptManager.create({
          name,
          template,
          description: typeof body.description === "string" ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
          preferredTools: Array.isArray(body.preferredTools) ? (body.preferredTools as string[]) : undefined,
          stages: Array.isArray(body.stages) ? (body.stages as PipelineStage[]) : undefined,
          suggestedSkill: typeof body.suggestedSkill === "string" ? body.suggestedSkill : undefined,
        });
        return res.status(201).json(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.put("/prompts/:id", (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        const updated = promptManager.update(req.params.id, {
          name: typeof body.name === "string" ? body.name.trim() : undefined,
          template: typeof body.template === "string" ? body.template : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
          preferredTools: Array.isArray(body.preferredTools) ? (body.preferredTools as string[]) : (body.preferredTools === null ? null : undefined),
          stages: Array.isArray(body.stages) ? (body.stages as PipelineStage[]) : (body.stages === null ? null : undefined),
          suggestedSkill: typeof body.suggestedSkill === "string" ? body.suggestedSkill : (body.suggestedSkill === null ? null : undefined),
        });
        return res.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.delete("/prompts/:id", (req, res) => {
      const deleted = promptManager.delete(req.params.id);
      return deleted
        ? res.json({ ok: true })
        : res.status(404).json({ error: "Prompt not found" });
    });

    // ── Template Export/Import (#188) ──
    const templateService = new TemplateService({
      promptManager,
      postActionRegistry,
    });

    router.get("/prompts/:id/export", (req, res) => {
      try {
        const template = templateService.export(req.params.id);
        const filename = `${template.prompt.name.toLowerCase().replace(/\s+/g, "-")}.openzigs-template.json`;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.json(template);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(404).json({ error: message });
      }
    });

    router.post("/templates/analyze", (req, res) => {
      const analysis = templateService.analyze(req.body);
      return res.json(analysis);
    });

    router.post("/templates/import", (req, res) => {
      const body = req.body as Record<string, unknown>;
      const templateData = body.template;
      const placeholders = (body.placeholders ?? {}) as Record<string, string>;

      if (!templateData) {
        return res.status(400).json({ error: "template is required" });
      }

      try {
        const prompt = templateService.import(templateData, placeholders);
        return res.status(201).json({ success: true, prompt });
      } catch (error) {
        if (error instanceof Error && error.name === "TemplateValidationError") {
          return res.status(400).json({ error: error.message, issues: (error as { issues?: unknown }).issues });
        }
        if (error instanceof Error && error.name === "PlaceholderResolutionError") {
          return res.status(400).json({ error: error.message, missing: (error as { missing?: unknown }).missing });
        }
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });
  }

  // ── Scheduled Jobs (Scheduler) ──
  if (scheduler) {
    router.get("/jobs", (req, res) => {
      const jobs = scheduler.list();
      const promptName = typeof req.query.promptName === "string" ? req.query.promptName : undefined;
      if (promptName) {
        const filtered = jobs.filter(j => {
          const payload = j.actionPayload as Record<string, unknown>;
          return payload.promptName === promptName;
        });
        return res.json({ jobs: filtered });
      }
      return res.json({ jobs });
    });

    // ── Automations (joined jobs + prompts + skills) ──
    router.get("/automations", (_req, res) => {
      const jobs = scheduler.list();
      const automations = jobs.map((job) => {
        const payload = job.actionPayload as Record<string, unknown> | undefined;
        const promptNameVal = payload?.promptName as string | undefined;
        const prompt = promptNameVal && promptManager ? promptManager.getByName(promptNameVal) : null;
        const skillName = (payload?.skillName as string | undefined) ?? prompt?.suggestedSkill ?? null;

        let lastExecution = null;
        if (taskEngine) {
          try {
            const execs = taskEngine.getRepository().findByJobName(job.name, 1);
            if (execs.length > 0) {
              const ex = execs[0];
              lastExecution = {
                taskId: ex.id,
                status: ex.status,
                startedAt: ex.startedAt,
                completedAt: ex.completedAt,
                duration: ex.startedAt && ex.completedAt
                  ? new Date(ex.completedAt).getTime() - new Date(ex.startedAt).getTime()
                  : null,
              };
            }
          } catch { /* ignore */ }
        }

        return {
          job: {
            id: job.id,
            name: job.name,
            cronExpression: job.cronExpression,
            timezone: job.timezone,
            enabled: job.enabled,
            actionType: job.actionType,
            runCount: job.runCount,
            lastRunAt: job.lastRunAt,
          },
          prompt: prompt ? {
            name: prompt.name,
            suggestedSkill: prompt.suggestedSkill,
            template: prompt.template.slice(0, 200),
            stages: prompt.stages?.length ?? 0,
          } : null,
          skillName,
          lastExecution,
        };
      });
      return res.json({ automations });
    });

    router.get("/jobs/:id", (req, res) => {
      const job = scheduler.getById(req.params.id);
      return job
        ? res.json(job)
        : res.status(404).json({ error: "Job not found" });
    });

    router.post("/jobs", (req, res) => {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
      if (!name || !cronExpression) {
        return res.status(400).json({ error: "name and cronExpression are required" });
      }
      if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && !reasoningEffort) {
        return res.status(400).json({ error: "reasoningEffort must be 'low', 'medium', 'high', or 'xhigh'" });
      }
      try {
        const job = scheduler.create({
          name,
          cronExpression,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          actionType: typeof body.actionType === "string" ? (body.actionType as "prompt" | "shell" | "custom") : undefined,
          actionPayload: (body.actionPayload ?? {}) as Record<string, unknown>,
          model: typeof body.model === "string" ? body.model : undefined,
          reasoningEffort,
          allowedTools: Array.isArray(body.allowedTools) ? (body.allowedTools as string[]) : undefined,
          autoApproveTools: Array.isArray(body.autoApproveTools) ? (body.autoApproveTools as string[]) : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        return res.status(201).json(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.put("/jobs/:id", (req, res) => {
      const body = req.body as Record<string, unknown>;
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
      if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && !reasoningEffort) {
        return res.status(400).json({ error: "reasoningEffort must be 'low', 'medium', 'high', 'xhigh', or null" });
      }
      try {
        const updated = scheduler.update(req.params.id, {
          name: typeof body.name === "string" ? body.name.trim() : undefined,
          cronExpression: typeof body.cronExpression === "string" ? body.cronExpression.trim() : undefined,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          actionPayload: body.actionPayload as Record<string, unknown> | undefined,
          model: typeof body.model === "string" ? body.model : (body.model === null ? null : undefined),
          reasoningEffort: reasoningEffort ?? (body.reasoningEffort === null ? null : undefined),
          allowedTools: Array.isArray(body.allowedTools) ? (body.allowedTools as string[]) : (body.allowedTools === null ? null : undefined),
          autoApproveTools: Array.isArray(body.autoApproveTools) ? (body.autoApproveTools as string[]) : (body.autoApproveTools === null ? null : undefined),
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        return res.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.post("/jobs/:id/toggle", (req, res) => {
      const body = req.body as Record<string, unknown>;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
      if (enabled === undefined) {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      try {
        const updated = scheduler.setEnabled(req.params.id, enabled);
        return res.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.delete("/jobs/:id", (req, res) => {
      const deleted = scheduler.delete(req.params.id);
      return deleted
        ? res.json({ ok: true })
        : res.status(404).json({ error: "Job not found" });
    });

    router.post("/jobs/:id/run", async (req, res) => {
      const job = scheduler.getById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!job.enabled) {
        return res.status(400).json({ error: "Job is disabled and cannot be run." });
      }

      const dryRun = req.query.dry_run === "true";

      if (dryRun) {
        // Dry-run: return full execution plan without executing
        const preview: Record<string, unknown> = {
          cronExpression: job.cronExpression,
          timezone: job.timezone,
          actionType: job.actionType,
          actionPayload: job.actionPayload,
          model: job.model,
        };

        // Resolve prompt + skill details for rich preview
        if (job.actionType === "prompt" && typeof job.actionPayload.promptName === "string" && promptManager) {
          const promptName = job.actionPayload.promptName;
          const templateVars = typeof job.actionPayload.templateVars === "object" && job.actionPayload.templateVars
            ? (job.actionPayload.templateVars as Record<string, string>)
            : {};
          const prompt = promptManager.getByName(promptName);
          if (prompt) {
            // Compute scheduled variables
            const now = new Date();
            const builtInVars: Record<string, string> = {
              today: now.toISOString().slice(0, 10),
              now: now.toISOString(),
              day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
              month: now.toLocaleDateString("en-US", { month: "long" }),
              year: String(now.getFullYear()),
            };
            const allVars = { ...builtInVars, ...templateVars };
            const resolvedText = interpolateTemplate(prompt.template, allVars);
            preview.resolvedGoal = resolvedText;
            preview.skillName = prompt.suggestedSkill;
            preview.allowedTools = prompt.preferredTools;
            preview.pipeline = prompt.stages ? { stages: prompt.stages } : null;
            preview.variables = allVars;
          }
        }

        // Compute next run times
        try {
          const nextRuns: string[] = [];
          const cursor = new Date();
          cursor.setSeconds(0, 0);
          cursor.setMinutes(cursor.getMinutes() + 1);
          const parts = job.cronExpression.trim().split(/\s+/);
          if (parts.length === 5) {
            for (let i = 0; i < 525960 && nextRuns.length < 3; i++) {
              const min = cursor.getMinutes();
              const hour = cursor.getHours();
              const dom = cursor.getDate();
              const mon = cursor.getMonth() + 1;
              const dow = cursor.getDay();
              if (
                matchCronField(parts[0], min) &&
                matchCronField(parts[1], hour) &&
                matchCronField(parts[2], dom) &&
                matchCronField(parts[3], mon) &&
                matchCronField(parts[4], dow)
              ) {
                nextRuns.push(cursor.toISOString());
              }
              cursor.setMinutes(cursor.getMinutes() + 1);
            }
          }
          preview.nextRuns = nextRuns;
        } catch {
          // ignore cron parse errors
        }

        preview.autoApproveTools = job.autoApproveTools;

        return res.json({
          ok: true,
          dryRun: true,
          jobId: job.id,
          jobName: job.name,
          preview,
        });
      }

      try {
        await scheduler.executeJob(job.id);
        return res.json({ ok: true, jobId: job.id, jobName: job.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    // Execution history for a job (query tasks table by context.jobId)
    router.get("/jobs/:id/history", (req, res) => {
      const job = scheduler.getById(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });

      if (!taskEngine) return res.json({ executions: [] });

      try {
        const repo = taskEngine.getRepository();
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
        const executions = repo.findByJobName(job.name, limit);
        return res.json({ executions });
      } catch {
        return res.json({ executions: [] });
      }
    });
  }

  // ── Scheduler Assistant ──
  if (copilot) {
    router.post("/scheduler/assist", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const promptNames = Array.isArray(body.promptNames)
        ? body.promptNames.filter((entry): entry is string => typeof entry === "string")
        : [];
      const bodyModel = typeof body.model === "string" ? body.model.trim() : "";

      if (!message) {
        return res.status(400).json({ error: "message is required" });
      }

      const promptList = promptNames.length > 0
        ? `Available saved prompts: ${promptNames.join(", ")}.`
        : "No saved prompts are available.";

      const instructions = [
        "You are a scheduling assistant for OpenZigs.",
        "Return ONLY valid JSON with these fields:",
        "name (string), actionType (prompt|shell|custom), cronExpression (string), timezone (IANA string),",
        "promptName (string, only if actionType is prompt), actionPayload (object, only if actionType is shell or custom),",
        "model (string, optional).",
        "Use 5-field cron format. Default timezone to UTC if not specified.",
        "If actionType is prompt, promptName must be one of the available saved prompts.",
        promptList,
        "User request:",
        message
      ].join("\n");

      try {
        let response = "";
        const nlModel = bodyModel || (await getUserSelectedModel() ?? "gpt-5-mini");
        for await (const chunk of copilot.chat(instructions, { model: nlModel, tools: [] })) {
          response += chunk;
        }

        const jsonText = extractJsonBlock(response);
        if (!jsonText) {
          return res.status(400).json({ error: "Assistant response was not JSON.", raw: response });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          return res.status(400).json({ error: `Invalid JSON from assistant: ${details}`, raw: response });
        }

        const suggestion = normalizeSchedulerSuggestion(parsed, promptNames);
        return res.json({ suggestion });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });
  }

  // ── Pipeline Planner ──
  if (copilot) {
    router.post("/pipeline/plan", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : undefined;

      if (!goal) {
        return res.status(400).json({ error: "goal is required" });
      }

      const availableTools = toolRegistry.listEnabledTools().map((t) => t.name);

      try {
        const planner = new PipelinePlanner(copilot);
        const result = await planner.plan(goal, { availableTools, model: model || undefined });
        return res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    // Extended plan: pipeline + skill recommendation + prompt template + schedule
    router.post("/automation/plan", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : undefined;

      if (!goal) {
        return res.status(400).json({ error: "goal is required" });
      }

      const availableTools = toolRegistry.listEnabledTools().map((t) => t.name);

      try {
        // 1. Get pipeline plan
        const planner = new PipelinePlanner(copilot);
        const pipelineResult = await planner.plan(goal, { availableTools, model: model || undefined });

        // 2. Match best skill
        const dirs = copilot?.getSkillDirectories?.() ?? [];
        const skills = await loadSkillMetadata(dirs);
        const goalLower = goal.toLowerCase();
        let bestSkill: { name: string; confidence: number; reason: string } | null = null;
        for (const sk of skills) {
          const nameMatch = goalLower.includes(sk.name.replace(/-/g, " ")) || goalLower.includes(sk.name);
          const descMatch = sk.description && goalLower.split(" ").some((w: string) => w.length > 3 && sk.description.toLowerCase().includes(w));
          if (nameMatch) {
            bestSkill = { name: sk.name, confidence: 0.9, reason: `Goal mentions ${sk.displayName}` };
            break;
          }
          if (descMatch && (!bestSkill || bestSkill.confidence < 0.6)) {
            bestSkill = { name: sk.name, confidence: 0.6, reason: `Goal overlaps with ${sk.displayName} domain` };
          }
        }

        // 3. Generate prompt template suggestion
        const variableHints = goal.match(/\b(region|topic|limit|keyword|query|date|platform|url)\b/gi) ?? [];
        const variables: Record<string, string> = {};
        for (const v of variableHints) variables[v.toLowerCase()] = "";

        const promptSuggestion = {
          name: goal.split(" ").slice(0, 5).join(" "),
          template: goal,
          variables,
          preferredTools: bestSkill
            ? skills.find((s) => s.name === bestSkill!.name)?.tools ?? []
            : [],
        };

        // 4. Suggest schedule from goal text
        let cronExpression: string | null = null;
        let cronHumanReadable = "";
        let timezone = "UTC";
        if (/daily|every day|each day/i.test(goal)) {
          cronExpression = "0 8 * * *";
          cronHumanReadable = "Daily at 8:00 AM";
        } else if (/weekday|week ?day|monday.?friday/i.test(goal)) {
          cronExpression = "0 8 * * 1-5";
          cronHumanReadable = "Weekdays at 8:00 AM";
        } else if (/weekly|every week/i.test(goal)) {
          cronExpression = "0 9 * * 1";
          cronHumanReadable = "Weekly on Monday at 9:00 AM";
        } else if (/monthly|every month/i.test(goal)) {
          cronExpression = "0 9 1 * *";
          cronHumanReadable = "Monthly on the 1st at 9:00 AM";
        } else if (/hourly|every hour/i.test(goal)) {
          cronExpression = "0 * * * *";
          cronHumanReadable = "Every hour";
        }
        if (/eastern|ET\b|new.?york/i.test(goal)) timezone = "America/New_York";
        else if (/pacific|PT\b|los.?angeles/i.test(goal)) timezone = "America/Los_Angeles";
        else if (/central|CT\b|chicago/i.test(goal)) timezone = "America/Chicago";

        return res.json({
          ...pipelineResult,
          skill: bestSkill,
          prompt: promptSuggestion,
          schedule: cronExpression ? {
            cronExpression,
            cronHumanReadable,
            timezone,
          } : null,
          autoApproveTools: promptSuggestion.preferredTools.slice(0, 5),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });
  }

  // ── Pipeline Templates ──
  if (pipelineTemplateManager) {
    router.get("/pipeline-templates", async (_req, res) => {
      try {
        return res.json(pipelineTemplateManager.list());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.get("/pipeline-templates/:id", async (req, res) => {
      const template = pipelineTemplateManager.getById(req.params.id);
      if (!template) return res.status(404).json({ error: "Template not found" });
      return res.json(template);
    });

    router.post("/pipeline-templates", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return res.status(400).json({ error: "name is required" });
      try {
        const template = await pipelineTemplateManager.create({
          name,
          description: typeof body.description === "string" ? body.description : "",
          icon: typeof body.icon === "string" ? body.icon : "📋",
          tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
          suggestedSkill: typeof body.suggestedSkill === "string" ? body.suggestedSkill : null,
          template: typeof body.template === "string" ? body.template : "",
          stages: Array.isArray(body.stages) ? body.stages : [],
          variables: Array.isArray(body.variables) ? body.variables : [],
        });
        return res.json(template);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.put("/pipeline-templates/:id", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      if (typeof body.name === "string") updates.name = body.name.trim();
      if (typeof body.description === "string") updates.description = body.description;
      if (typeof body.icon === "string") updates.icon = body.icon;
      if (typeof body.template === "string") updates.template = body.template;
      if (Array.isArray(body.tags)) updates.tags = body.tags;
      if (Array.isArray(body.stages)) updates.stages = body.stages;
      if (Array.isArray(body.variables)) updates.variables = body.variables;
      try {
        const template = await pipelineTemplateManager.update(req.params.id, updates as Partial<Record<string, unknown>>);
        if (!template) return res.status(404).json({ error: "Template not found or is built-in" });
        return res.json(template);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.delete("/pipeline-templates/:id", async (req, res) => {
      try {
        const removed = await pipelineTemplateManager.remove(req.params.id);
        if (!removed) return res.status(404).json({ error: "Template not found or is built-in" });
        return res.json({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });
  }

  // ── Personality Management ──
  if (personalityManager) {
    router.get("/personality", (_req, res) => {
      return res.json(personalityManager.getConfig());
    });

    router.put("/personality", (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        const updated = personalityManager.update({
          systemInstruction: typeof body.systemInstruction === "string" ? body.systemInstruction : undefined,
          prePrompt: typeof body.prePrompt === "string" ? body.prePrompt : undefined,
          postPrompt: typeof body.postPrompt === "string" ? body.postPrompt : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          mode: body.mode === "append" || body.mode === "replace" ? body.mode : undefined,
        });
        return res.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.post("/personality/reset", (_req, res) => {
      const config = personalityManager.reset();
      return res.json(config);
    });
  }

  // ── Brand Voice Management ──
  if (brandVoiceService) {
    router.get("/brand-voice", (_req, res) => {
      return res.json({ voices: brandVoiceService.getAll() });
    });

    router.get("/brand-voice/active", (_req, res) => {
      const active = brandVoiceService.getActive();
      return res.json({ voice: active });
    });

    router.get("/brand-voice/:id", (req, res) => {
      const voice = brandVoiceService.getById(req.params.id);
      if (!voice) return res.status(404).json({ error: "Brand voice not found" });
      return res.json(voice);
    });

    router.post("/brand-voice/analyze", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const samples = Array.isArray(body.samples)
        ? (body.samples as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const active = body.active === true;
      const model = typeof body.model === "string" ? body.model.trim() : undefined;

      if (samples.length === 0) {
        return res.status(400).json({ error: "At least one writing sample is required" });
      }
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }
      const MAX_SAMPLE_LENGTH = 10_000;
      for (const sample of samples) {
        if (sample.length > MAX_SAMPLE_LENGTH) {
          return res.status(400).json({ error: `Sample exceeds ${MAX_SAMPLE_LENGTH} characters` });
        }
      }

      try {
        const voice = await brandVoiceService.analyzeAndSave(name, samples, { active, model });
        return res.json(voice);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[BrandVoice] Analysis failed: ${message}`);
        return res.status(500).json({ error: message });
      }
    });

    const BrandVoiceRulebookUpdateSchema = z.object({
      tone: z.string(),
      sentence_structure: z.string(),
      vocabulary_level: z.string(),
      formatting_quirks: z.string(),
      banned_words: z.array(z.string()),
    }).partial().strict();

    router.put("/brand-voice/:id", (req, res) => {
      const body = req.body as Record<string, unknown>;

      let rulebook: import("../personality/brand-voice-repository.js").BrandVoiceRulebook | undefined;
      if (body.rulebook !== undefined) {
        const result = BrandVoiceRulebookUpdateSchema.safeParse(body.rulebook);
        if (!result.success) {
          return res.status(400).json({ error: "Invalid rulebook structure", issues: result.error.issues });
        }
        rulebook = result.data as import("../personality/brand-voice-repository.js").BrandVoiceRulebook;
      }

      const updated = brandVoiceService.update(req.params.id, {
        name: typeof body.name === "string" ? body.name.trim() : undefined,
        rulebook,
        active: typeof body.active === "boolean" ? body.active : undefined,
      });
      if (!updated) return res.status(404).json({ error: "Brand voice not found" });
      return res.json(updated);
    });

    router.post("/brand-voice/:id/activate", (req, res) => {
      const voice = brandVoiceService.setActive(req.params.id);
      if (!voice) return res.status(404).json({ error: "Brand voice not found" });
      return res.json(voice);
    });

    router.post("/brand-voice/:id/reanalyze", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const samples = Array.isArray(body.samples)
        ? (body.samples as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const model = typeof body.model === "string" ? body.model.trim() : undefined;

      if (samples.length === 0) {
        return res.status(400).json({ error: "At least one writing sample is required" });
      }

      try {
        const voice = await brandVoiceService.reanalyze(req.params.id, samples, model);
        if (!voice) return res.status(404).json({ error: "Brand voice not found" });
        return res.json(voice);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[BrandVoice] Re-analysis failed: ${message}`);
        return res.status(500).json({ error: message });
      }
    });

    router.post("/brand-voice/deactivate", (_req, res) => {
      brandVoiceService.deactivateAll();
      return res.json({ ok: true });
    });

    // Upload Word/PDF files and extract text as writing samples
    const sampleUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 10 },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if ([".pdf", ".docx", ".doc", ".txt"].includes(ext)) {
          cb(null, true);
        } else {
          cb(new Error("Unsupported file type. Accepted: .pdf, .docx, .doc, .txt"));
        }
      },
    });

    router.post("/brand-voice/upload-samples", sampleUpload.array("files", 10), async (req, res) => {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const samples: string[] = [];
      const errors: string[] = [];

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        try {
          let text = "";
          if (ext === ".txt") {
            text = file.buffer.toString("utf-8");
          } else if (ext === ".docx" || ext === ".doc") {
            const mod: unknown = await import("mammoth");
            const m = mod as Record<string, unknown>;
            const mammoth = (m.default ?? m) as Record<string, unknown>;
            if (typeof mammoth.extractRawText !== "function") {
              throw new Error("mammoth.extractRawText is not a function — unexpected module shape");
            }
            const result = await (mammoth.extractRawText as (opts: { buffer: Buffer }) => Promise<{ value: string }>)({ buffer: file.buffer });
            text = result.value;
          } else if (ext === ".pdf") {
            const mod: unknown = await import("pdf-parse");
            const m = mod as Record<string, unknown>;
            const pdf = (m.default ?? m) as (data: Buffer) => Promise<{ text: string }>;
            if (typeof pdf !== "function") {
              throw new Error("pdf-parse default export is not a function — unexpected module shape");
            }
            const data = await pdf(file.buffer);
            text = data.text;
          }

          const trimmed = text.trim();
          if (trimmed) {
            samples.push(trimmed);
          } else {
            errors.push(`${file.originalname}: extracted text was empty`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${file.originalname}: ${msg}`);
        }
      }

      return res.json({ samples, errors });
    });

    router.delete("/brand-voice/:id", (req, res) => {
      const deleted = brandVoiceService.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Brand voice not found" });
      return res.json({ ok: true });
    });
  }

  // ── Sessions ──
  if (sessionManager) {
    router.get("/sessions", async (_req, res) => {
      try {
        const sessions = await sessionManager.listSessions();
        return res.json({ sessions });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.get("/sessions/:id", async (req, res) => {
      try {
        const session = await sessionManager.getSession(req.params.id);
        return res.json(session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(404).json({ error: message });
      }
    });

    router.get("/sessions/:id/history", async (req, res) => {
      try {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const events = await sessionManager.getHistory(req.params.id, limit);
        return res.json({ events });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(404).json({ error: message });
      }
    });

    router.post("/sessions/:id/fork", async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        const upToIndex = typeof body.upToIndex === "number" ? body.upToIndex : 0;
        const forked = await sessionManager.forkSession(req.params.id, upToIndex);
        return res.status(201).json(forked);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    router.delete("/sessions/:id", async (req, res) => {
      try {
        await sessionManager.deleteSession(req.params.id);
        return res.json({ deleted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });
  }

  // ── Copilot SDK Sessions (Phase 1-4 of Epic #334) ──
  if (copilot) {
    // Phase 4: Session analytics (must be before :sessionId routes)
    router.get("/copilot-sessions/analytics", (_req, res) => {
      const analytics = copilot.getSessionAnalytics();
      return res.json(analytics);
    });

    router.post("/copilot-sessions/analytics/reset", (_req, res) => {
      copilot.resetSessionAnalytics();
      return res.json({ reset: true });
    });

    // Phase 1: List SDK-managed sessions
    router.get("/copilot-sessions", async (req, res) => {
      try {
        const filter: Record<string, string> = {};
        if (typeof req.query.repository === "string") filter.repository = req.query.repository;
        if (typeof req.query.branch === "string") filter.branch = req.query.branch;
        if (typeof req.query.cwd === "string") filter.cwd = req.query.cwd;
        if (typeof req.query.gitRoot === "string") filter.gitRoot = req.query.gitRoot;
        const sessions = await copilot.listSdkSessions(Object.keys(filter).length > 0 ? filter : undefined);
        return res.json({ sessions });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    // Phase 1: Delete an SDK session
    router.delete("/copilot-sessions/:sessionId", async (req, res) => {
      try {
        await copilot.deleteSdkSession(req.params.sessionId);
        return res.json({ deleted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(400).json({ error: message });
      }
    });

    // Phase 2: Resume a past Copilot session (returns session metadata for the UI to open chat)
    router.post("/copilot-sessions/:sessionId/resume", async (req, res) => {
      try {
        // Verify the session exists in the SDK listing
        const sessions = await copilot.listSdkSessions();
        const target = sessions.find((s) => s.sessionId === req.params.sessionId);
        if (!target) {
          return res.status(404).json({ error: "SDK session not found" });
        }
        // The SDK handles resume via the CopilotWrapper.getOrCreateSession flow.
        // We just need to tell the UI to open chat with this conversationId.
        return res.json({
          conversationId: req.params.sessionId,
          summary: target.summary,
          context: target.context,
          startTime: target.startTime,
          modifiedTime: target.modifiedTime,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    // Phase 3: Get conversation events for replay
    router.get("/copilot-sessions/:sessionId/messages", async (req, res) => {
      try {
        const events = await copilot.getSdkSessionMessages(req.params.sessionId);
        return res.json({ events });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });
  }

  // ── Session / Tool-Limit Configuration ──
  router.get("/session/config", (_req, res) => {
    const maxToolsPerRequest = copilot?.getMaxToolsPerRequest() ?? 30;
    const totalTools = toolRegistry.listEnabledTools().length;
    const alwaysOnCount = ALWAYS_ON_TOOLS.size;
    return res.json({ maxToolsPerRequest, totalTools, alwaysOnCount });
  });

  router.put("/session/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const maxToolsPerRequest =
      typeof body.maxToolsPerRequest === "number" ? body.maxToolsPerRequest : undefined;

    if (
      maxToolsPerRequest === undefined ||
      !Number.isInteger(maxToolsPerRequest) ||
      maxToolsPerRequest < 1 ||
      maxToolsPerRequest > 128
    ) {
      return res.status(400).json({ error: "maxToolsPerRequest must be an integer between 1 and 128" });
    }

    try {
      if (copilot) {
        copilot.setMaxToolsPerRequest(maxToolsPerRequest);
      }

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingSession =
        userConfig.session && typeof userConfig.session === "object"
          ? (userConfig.session as Record<string, unknown>)
          : {};
      userConfig.session = { ...existingSession, maxToolsPerRequest };
      await writeUserConfig(configPath, userConfig);

      logger.info(`maxToolsPerRequest updated to ${maxToolsPerRequest}`);
      return res.json({ ok: true, maxToolsPerRequest });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  // ── Task Engine Configuration ──
  router.get("/tasks/stats", (_req, res) => {
    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    return res.json({
      queued: stats.queued,
      running: stats.running,
      activeCount: stats.queued + stats.running,
    });
  });

  router.get("/tasks/config", (_req, res) => {
    const maxConcurrent = taskWorker?.concurrencyLimit ?? 2;
    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    return res.json({
      maxConcurrent,
      stats,
    });
  });

  router.put("/tasks/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const maxConcurrent = typeof body.maxConcurrent === "number" ? body.maxConcurrent : undefined;

    if (maxConcurrent === undefined || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) {
      return res.status(400).json({ error: "maxConcurrent must be an integer between 1 and 10" });
    }

    try {
      if (taskWorker) {
        taskWorker.setMaxConcurrent(maxConcurrent);
      }

      // Persist to user config
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingTasks = (userConfig.tasks && typeof userConfig.tasks === "object")
        ? (userConfig.tasks as Record<string, unknown>)
        : {};
      userConfig.tasks = { ...existingTasks, maxConcurrent };
      await writeUserConfig(configPath, userConfig);

      logger.info(`Task engine maxConcurrent updated to ${maxConcurrent}`);
      return res.json({ ok: true, maxConcurrent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
  });

  // ── Model / Copilot Configuration ──
  router.get("/models/config", (_req, res) => {
    const reasoningEffort = copilot?.getReasoningEffort() ?? "medium";
    const provider = copilot?.getProvider() ?? null;
    const workingDirectory = copilot?.getWorkingDirectory() ?? null;
    return res.json({ reasoningEffort, provider, workingDirectory });
  });

  router.put("/models/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;

    const validEfforts = new Set(["low", "medium", "high", "xhigh"]);

    if (body.reasoningEffort !== undefined) {
      if (body.reasoningEffort !== null && (typeof body.reasoningEffort !== "string" || !validEfforts.has(body.reasoningEffort))) {
        return res.status(400).json({ error: "reasoningEffort must be 'low', 'medium', 'high', 'xhigh', or null" });
      }
    }

    if (body.workingDirectory !== undefined) {
      if (body.workingDirectory !== null && typeof body.workingDirectory !== "string") {
        return res.status(400).json({ error: "workingDirectory must be a string or null" });
      }
    }

    if (body.provider !== undefined) {
      if (body.provider !== null) {
        const prov = body.provider as Record<string, unknown>;
        const validTypes = new Set(["openai", "azure", "anthropic", "ollama"]);
        if (!prov || typeof prov !== "object" || !validTypes.has(prov.type as string)) {
          return res.status(400).json({ error: "provider.type must be 'openai', 'azure', 'anthropic', or 'ollama'" });
        }
        if (typeof prov.baseUrl !== "string" || !prov.baseUrl) {
          return res.status(400).json({ error: "provider.baseUrl is required" });
        }
      }
    }

    try {
      // Apply changes in-memory
      if (copilot) {
        if (body.reasoningEffort !== undefined) {
          copilot.setReasoningEffort(
            body.reasoningEffort === null ? undefined : (body.reasoningEffort as ReasoningEffort)
          );
        }
        if (body.workingDirectory !== undefined) {
          copilot.setWorkingDirectory(
            body.workingDirectory === null ? undefined : (body.workingDirectory as string)
          );
        }
        if (body.provider !== undefined) {
          copilot.setProvider(
            body.provider === null ? undefined : (body.provider as ProviderConfig)
          );
        }
      }

      // Persist to user config
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existingCopilot = (userConfig.copilot && typeof userConfig.copilot === "object")
        ? (userConfig.copilot as Record<string, unknown>)
        : {};

      if (body.reasoningEffort !== undefined) {
        existingCopilot.defaultReasoningEffort = body.reasoningEffort ?? "medium";
      }
      if (body.workingDirectory !== undefined) {
        existingCopilot.defaultWorkingDirectory = body.workingDirectory;
      }
      if (body.provider !== undefined) {
        existingCopilot.provider = body.provider;
      }

      userConfig.copilot = existingCopilot;
      await writeUserConfig(configPath, userConfig);

      logger.info(`Model config updated: ${Object.keys(body).join(", ")}`);
      return res.json({
        ok: true,
        reasoningEffort: copilot?.getReasoningEffort() ?? "medium",
        provider: copilot?.getProvider() ?? null,
        workingDirectory: copilot?.getWorkingDirectory() ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Custom Agents Management ──
  router.get("/agents", (_req, res) => {
    const agents = copilot?.getCustomAgents() ?? [];
    return res.json({ agents });
  });

  router.put("/agents", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const agents = body.agents;
    if (!Array.isArray(agents)) {
      return res.status(400).json({ error: "agents must be an array" });
    }

    // Validate each agent against the Zod schema
    for (const agent of agents) {
      const result = customAgentSchema.safeParse(agent);
      if (!result.success) {
        const name = (agent as Record<string, unknown>).name ?? "unknown";
        return res.status(400).json({ error: `Agent '${name}': ${result.error.issues.map((i) => i.message).join(", ")}` });
      }
    }

    try {
      if (copilot) {
        copilot.setCustomAgents(agents as CustomAgentDefinition[]);
      }

      await updateCopilotConfig("customAgents", agents);

      logger.info(`Custom agents updated: ${agents.length} agent(s)`);
      return res.json({ ok: true, agents: copilot?.getCustomAgents() ?? agents });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/agents", async (req, res) => {
    const parsed = customAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    try {
      const current = copilot?.getCustomAgents() ?? [];
      if (current.some((a) => a.name === parsed.data.name)) {
        return res.status(409).json({ error: `Agent '${parsed.data.name}' already exists` });
      }

      const newAgent = parsed.data as CustomAgentDefinition;
      const updated = [...current, newAgent];
      if (copilot) copilot.setCustomAgents(updated);

      await updateCopilotConfig("customAgents", updated);

      logger.info(`Custom agent added: ${newAgent.name}`);
      return res.status(201).json({ ok: true, agent: newAgent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/agents/:name", async (req, res) => {
    const { name } = req.params;
    const parsed = customAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    try {
      const current = copilot?.getCustomAgents() ?? [];
      const idx = current.findIndex((a) => a.name === name);
      if (idx === -1) {
        return res.status(404).json({ error: `Agent '${name}' not found` });
      }

      const updatedAgent = parsed.data as CustomAgentDefinition;
      const updated = [...current];
      updated[idx] = updatedAgent;
      if (copilot) copilot.setCustomAgents(updated);

      await updateCopilotConfig("customAgents", updated);

      logger.info(`Custom agent updated: ${name}`);
      return res.json({ ok: true, agent: updatedAgent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.delete("/agents/:name", async (req, res) => {
    const { name } = req.params;
    const current = copilot?.getCustomAgents() ?? [];
    const filtered = current.filter((a) => a.name !== name);
    if (filtered.length === current.length) {
      return res.status(404).json({ error: `Agent '${name}' not found` });
    }

    try {
      if (copilot) copilot.setCustomAgents(filtered);

      await updateCopilotConfig("customAgents", filtered);

      logger.info(`Custom agent removed: ${name}`);
      return res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Native MCP Servers Management ──

  /** Background tool discovery: spawn/connect to MCP server, cache discovered tools, then tear down. */
  const discoverAndCacheTools = async (name: string, def: NativeMcpServerDefinition) => {
    try {
      logger.info(`Background tool discovery starting for "${name}"`);
      const result = await mcpTester.testServer(name, def);

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);

      if (result.ok) {
        cache[name] = {
          tools: result.tools,
          connected: true,
          updatedAt: new Date().toISOString(),
        };
        logger.info(`Background tool discovery for "${name}" found ${result.tools.length} tools`);
      } else {
        cache[name] = {
          tools: cache[name]?.tools ?? [],
          connected: false,
          error: result.error,
          updatedAt: new Date().toISOString(),
        };
        logger.warn(`Background tool discovery for "${name}" failed: ${result.error}`);
      }

      await setNativeMcpToolCache(cache);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Background tool discovery for "${name}" threw: ${message}`);
    }
  };

  router.get("/native-mcp-servers", (_req, res) => {
    const servers = copilot?.getNativeMcpServers() ?? {};
    return res.json({ servers });
  });

  router.get("/native-mcp-servers/tool-cache", async (_req, res) => {
    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      return res.json({ cache });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/native-mcp-servers", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const servers = body.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return res.status(400).json({ error: "servers must be an object (Record<string, ServerConfig>)" });
    }

    // Validate the entire servers record against the Zod schema
    const parsed = nativeMcpServersSchema.safeParse(servers);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
    }

    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    const activeCount = stats.running + stats.queued;
    if (activeCount > 0) {
      return res.status(409).json({
        error: `Cannot update MCP configuration while ${activeCount} task(s) are active. Please wait for tasks to complete or cancel them.`,
        activeCount,
        tasks: { running: stats.running, queued: stats.queued },
      });
    }

    try {
      if (copilot) {
        copilot.setNativeMcpServers(parsed.data as Record<string, NativeMcpServerDefinition>);
      }

      await updateCopilotConfig("nativeMcpServers", parsed.data);

      logger.info(`Native MCP servers updated: ${Object.keys(parsed.data).length} server(s)`);
      return res.json({ ok: true, servers: copilot?.getNativeMcpServers() ?? parsed.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/native-mcp-servers/test", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const serverName = typeof body.serverName === "string" ? body.serverName.trim() : "test";

    const parsed = mcpServerConfigSchema.safeParse(body.server ?? body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    try {
      const result = await Promise.race([
        mcpTester.testServer(serverName, parsed.data as NativeMcpServerDefinition),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection test timed out after 15s")), 15_000)),
      ]);

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      if (result.ok) {
        cache[serverName] = {
          tools: result.tools,
          connected: true,
          updatedAt: new Date().toISOString(),
        };
      } else {
        cache[serverName] = {
          tools: cache[serverName]?.tools ?? [],
          connected: false,
          error: result.error,
          updatedAt: new Date().toISOString(),
        };
      }
      await setNativeMcpToolCache(cache);

      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, serverName, error: message });
    }
  });

  router.post("/native-mcp-servers/:name/reconnect", async (req, res) => {
    const { name } = req.params;
    const current = copilot?.getNativeMcpServers() ?? {};
    const server = current[name];
    if (!server) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    try {
      const result = await Promise.race([
        mcpTester.testServer(name, server),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection test timed out after 15s")), 15_000)),
      ]);

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      if (result.ok) {
        cache[name] = {
          tools: result.tools,
          connected: true,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Clear stale tools on failure — don't keep old potentially-wrong entries.
        // The server definition's `tools` allowlist serves as the fallback source.
        cache[name] = {
          tools: [],
          connected: false,
          error: result.error,
          updatedAt: new Date().toISOString(),
        };
      }
      await setNativeMcpToolCache(cache);

      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, serverName: name, error: message });
    }
  });

  router.post("/native-mcp-servers/:name", async (req, res) => {
    const { name } = req.params;
    const parsed = mcpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    const activeCount = stats.running + stats.queued;
    if (activeCount > 0) {
      return res.status(409).json({
        error: `Cannot update MCP configuration while ${activeCount} task(s) are active. Please wait for tasks to complete or cancel them.`,
        activeCount,
        tasks: { running: stats.running, queued: stats.queued },
      });
    }

    try {
      const current = copilot?.getNativeMcpServers() ?? {};
      if (name in current) {
        return res.status(409).json({ error: `Server '${name}' already exists` });
      }

      const updated = { ...current, [name]: parsed.data as NativeMcpServerDefinition };
      if (copilot) copilot.setNativeMcpServers(updated);

      await updateCopilotConfig("nativeMcpServers", updated);

      logger.info(`Native MCP server added: ${name}`);

      // Fire-and-forget: background tool discovery so cache is populated immediately
      void discoverAndCacheTools(name, parsed.data as NativeMcpServerDefinition);

      return res.status(201).json({ ok: true, server: parsed.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/native-mcp-servers/:name", async (req, res) => {
    const { name } = req.params;
    const parsed = mcpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    const activeCount = stats.running + stats.queued;
    if (activeCount > 0) {
      return res.status(409).json({
        error: `Cannot update MCP configuration while ${activeCount} task(s) are active. Please wait for tasks to complete or cancel them.`,
        activeCount,
        tasks: { running: stats.running, queued: stats.queued },
      });
    }

    try {
      const current = copilot?.getNativeMcpServers() ?? {};
      if (!(name in current)) {
        return res.status(404).json({ error: `Server '${name}' not found` });
      }

      const updated = { ...current, [name]: parsed.data as NativeMcpServerDefinition };
      if (copilot) copilot.setNativeMcpServers(updated);

      await updateCopilotConfig("nativeMcpServers", updated);

      logger.info(`Native MCP server updated: ${name}`);

      // Fire-and-forget: background tool discovery so cache is refreshed
      void discoverAndCacheTools(name, parsed.data as NativeMcpServerDefinition);

      return res.json({ ok: true, server: parsed.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.delete("/native-mcp-servers/:name", async (req, res) => {
    const { name } = req.params;
    const current = copilot?.getNativeMcpServers() ?? {};
    if (!(name in current)) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    const stats = taskEngine?.getStats() ?? { queued: 0, running: 0 };
    const activeCount = stats.running + stats.queued;
    if (activeCount > 0) {
      return res.status(409).json({
        error: `Cannot update MCP configuration while ${activeCount} task(s) are active. Please wait for tasks to complete or cancel them.`,
        activeCount,
        tasks: { running: stats.running, queued: stats.queued },
      });
    }

    try {
      const remaining = { ...current };
      delete remaining[name];
      if (copilot) copilot.setNativeMcpServers(remaining as Record<string, NativeMcpServerDefinition>);

      await updateCopilotConfig("nativeMcpServers", remaining);

      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      delete cache[name];
      await setNativeMcpToolCache(cache);

      logger.info(`Native MCP server removed: ${name}`);
      return res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Per Native MCP Server Tool Listing & Toggle ──

  router.get("/native-mcp-servers/:name/tools", async (req, res) => {
    const { name } = req.params;
    const current = copilot?.getNativeMcpServers() ?? {};
    const server = current[name];
    if (!server) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      const entry = cache[name];
      let discoveredTools = entry?.tools ?? [];

      // Fallback: if cache is empty but the server definition has a `tools`
      // allowlist (plain tool-name strings), synthesise entries so the UI
      // can still render toggles for known tools even while disconnected.
      if (discoveredTools.length === 0 && server.tools && server.tools.length > 0) {
        discoveredTools = server.tools.map((t) => ({ name: t, description: "" }));
      }

      const disabledSet = new Set(server.disabledTools ?? []);

      const tools = discoveredTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: !disabledSet.has(tool.name),
      }));

      return res.json({ server: name, tools, connected: entry?.connected ?? false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // Add a known tool name to the server definition's tools array (pre-configure without connecting).
  // MUST be registered before the `:toolName` param routes to avoid matching "add" as a toolName.
  router.post("/native-mcp-servers/:name/tools/add", async (req, res) => {
    const { name } = req.params;
    const { toolName } = req.body as { toolName?: string };
    if (!toolName || typeof toolName !== "string" || !toolName.trim()) {
      return res.status(400).json({ error: "toolName is required" });
    }

    const current = copilot?.getNativeMcpServers() ?? {};
    const server = current[name];
    if (!server) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    try {
      const trimmed = toolName.trim();
      const existingTools = server.tools ?? [];
      if (existingTools.includes(trimmed)) {
        return res.json({ ok: true, tool: trimmed, message: "already exists" });
      }

      const updatedDef = {
        ...server,
        tools: [...existingTools, trimmed],
      };

      const updated = { ...current, [name]: updatedDef };
      if (copilot) copilot.setNativeMcpServers(updated as Record<string, NativeMcpServerDefinition>);

      await updateCopilotConfig("nativeMcpServers", updated);

      logger.info(`Known tool "${trimmed}" added to server "${name}"`);
      return res.json({ ok: true, tool: trimmed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/native-mcp-servers/:name/tools/:toolName/toggle", async (req, res) => {
    const { name, toolName } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const current = copilot?.getNativeMcpServers() ?? {};
    const server = current[name];
    if (!server) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    try {
      const disabledSet = new Set(server.disabledTools ?? []);
      if (enabled) {
        disabledSet.delete(toolName);
      } else {
        disabledSet.add(toolName);
      }

      const updatedDef = {
        ...server,
        disabledTools: disabledSet.size > 0 ? Array.from(disabledSet) : undefined,
      };

      const updated = { ...current, [name]: updatedDef };
      if (copilot) copilot.setNativeMcpServers(updated as Record<string, NativeMcpServerDefinition>);

      await updateCopilotConfig("nativeMcpServers", updated);

      logger.info(`Native MCP tool "${toolName}" ${enabled ? "enabled" : "disabled"} on server "${name}"`);
      return res.json({ ok: true, tool: toolName, enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // Remove a tool from the server definition's tools array and disabledTools
  router.post("/native-mcp-servers/:name/tools/:toolName/remove", async (req, res) => {
    const { name, toolName } = req.params;
    const current = copilot?.getNativeMcpServers() ?? {};
    const server = current[name];
    if (!server) {
      return res.status(404).json({ error: `Server '${name}' not found` });
    }

    try {
      const existingTools = (server.tools ?? []).filter((t) => t !== toolName);
      const disabledTools = (server.disabledTools ?? []).filter((t) => t !== toolName);

      const updatedDef = {
        ...server,
        tools: existingTools.length > 0 ? existingTools : undefined,
        disabledTools: disabledTools.length > 0 ? disabledTools : undefined,
      };

      const updated = { ...current, [name]: updatedDef };
      if (copilot) copilot.setNativeMcpServers(updated as Record<string, NativeMcpServerDefinition>);

      await updateCopilotConfig("nativeMcpServers", updated);

      // Also remove from cache
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const cache = getNativeMcpToolCache(userConfig);
      if (cache[name]) {
        cache[name].tools = cache[name].tools.filter((t) => t.name !== toolName);
        await setNativeMcpToolCache(cache);
      }

      logger.info(`Tool "${toolName}" removed from server "${name}"`);
      return res.json({ ok: true, tool: toolName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Webhooks ──

  router.get("/webhooks", (_req, res) => {
    if (!webhookManager) return res.status(501).json({ error: "Webhooks not enabled" });
    const webhooks = webhookManager.list().map((wh) => ({
      id: wh.id,
      name: wh.name,
      action: wh.action,
      actionPayload: wh.actionPayload,
      enabled: wh.enabled,
      allowedIps: wh.allowedIps,
      rateLimit: wh.rateLimit,
      triggerCount: wh.triggerCount,
      lastTriggeredAt: wh.lastTriggeredAt,
      createdAt: wh.createdAt,
    }));
    return res.json({ webhooks });
  });

  router.post("/webhooks", (req, res) => {
    if (!webhookManager) return res.status(501).json({ error: "Webhooks not enabled" });
    const { name, action, actionPayload, allowedIps, rateLimit } = req.body ?? {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (action !== "prompt" && action !== "goal") return res.status(400).json({ error: "action must be 'prompt' or 'goal'" });

    const { webhook, apiKey } = webhookManager.create({
      name: name.trim(),
      action,
      actionPayload: actionPayload ?? {},
      allowedIps: Array.isArray(allowedIps) ? allowedIps : [],
      rateLimit: typeof rateLimit === "number" ? rateLimit : 60,
    });

    logger.info(`Webhook created: ${webhook.name} (${webhook.id})`);
    return res.status(201).json({
      webhook: {
        id: webhook.id,
        name: webhook.name,
        action: webhook.action,
        enabled: webhook.enabled,
        secret: webhook.secret,
        rateLimit: webhook.rateLimit,
        createdAt: webhook.createdAt,
      },
      apiKey, // Shown only once
    });
  });

  router.post("/webhooks/:id/toggle", (req, res) => {
    if (!webhookManager) return res.status(501).json({ error: "Webhooks not enabled" });
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled is required (boolean)" });
    const webhook = webhookManager.toggle(req.params.id, enabled);
    if (!webhook) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ ok: true, enabled: webhook.enabled });
  });

  router.post("/webhooks/:id/rotate-key", (req, res) => {
    if (!webhookManager) return res.status(501).json({ error: "Webhooks not enabled" });
    const result = webhookManager.rotateKey(req.params.id);
    if (!result) return res.status(404).json({ error: "Webhook not found" });
    logger.info(`API key rotated for webhook ${req.params.id}`);
    return res.json({ apiKey: result.apiKey });
  });

  router.delete("/webhooks/:id", (req, res) => {
    if (!webhookManager) return res.status(501).json({ error: "Webhooks not enabled" });
    const deleted = webhookManager.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Webhook not found" });
    logger.info(`Webhook deleted: ${req.params.id}`);
    return res.json({ ok: true });
  });

  // ── Sentinel: Autonomous System Monitor ──
  if (sentinel) {
    router.get("/sentinel/status", (_req, res) => {
      return res.json(sentinel.getStatus());
    });

    router.put("/sentinel/config", async (req, res) => {
      const parsed = SentinelConfigSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      }
      try {
        await sentinel.updateConfig(parsed.data);
        return res.json({ ok: true, config: sentinel.getStatus().config });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.post("/sentinel/toggle", async (req, res) => {
      const toggleSchema = z.object({ enabled: z.boolean() });
      const parsed = toggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      const { enabled } = parsed.data;
      try {
        await sentinel.toggle(enabled);
        return res.json({ ok: true, enabled: sentinel.isRunning });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.post("/sentinel/run-now", async (_req, res) => {
      try {
        const result = await sentinel.runCheck();
        return res.json({
          ok: true,
          totalTasks: result.totalTasks,
          successRate: result.successRate,
          alertCount: result.alerts.length,
          alerts: result.alerts,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    router.get("/sentinel/digests", async (req, res) => {
      const parsedLimit = typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : Number.NaN;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
      try {
        const digests = await sentinel.getDigestHistory(limit);
        return res.json({ digests });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });

    // #198: Download status.md digest markdown
    router.get("/sentinel/digest-markdown", async (_req, res) => {
      try {
        const markdown = await readStatusMarkdown(sentinel.getStatus().config.markdownDigestPath);
        if (!markdown) {
          return res.status(404).json({ error: "No status.md found. Enable persistMarkdownDigest in Sentinel config." });
        }
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        return res.send(markdown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });
  }

  // ── Presenter Mode Configuration ──
  router.get("/presenter/config", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const presenter = (userConfig.presenter ?? {}) as Record<string, unknown>;
      return res.json({
        baseUrl: presenter.baseUrl ?? "",
        hasInviteSecret: !!presenter.inviteSecret,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/presenter/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const baseUrl = body.baseUrl as string | undefined;

    if (baseUrl !== undefined && typeof baseUrl !== "string") {
      return res.status(400).json({ error: "baseUrl must be a string" });
    }
    if (baseUrl && !/^https?:\/\/.+/.test(baseUrl)) {
      return res.status(400).json({ error: "baseUrl must be a valid HTTP(S) URL" });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existing = (userConfig.presenter ?? {}) as Record<string, unknown>;
      userConfig.presenter = {
        ...existing,
        ...(baseUrl !== undefined ? { baseUrl: baseUrl.replace(/\/$/, "") } : {}),
      };
      await writeUserConfig(configPath, userConfig);
      logger.info(`[Admin] Presenter baseUrl updated: ${baseUrl}`);
      return res.json({ ok: true, baseUrl: (userConfig.presenter as Record<string, unknown>).baseUrl ?? "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Image Generation Node Configuration ──
  router.get("/image-gen/config", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const imageGen = (userConfig.imageGen ?? {}) as Record<string, unknown>;
      return res.json({
        mode: imageGen.mode ?? "local",
        networkNodeUrl: imageGen.networkNodeUrl ?? "",
        networkNodeToken: imageGen.networkNodeToken ? "••••••••" : "",
        hasToken: !!imageGen.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/image-gen/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const mode = body.mode as string | undefined;
    const networkNodeUrl = body.networkNodeUrl as string | undefined;
    const networkNodeToken = body.networkNodeToken as string | undefined;

    if (mode !== undefined && mode !== "local" && mode !== "network") {
      return res.status(400).json({ error: "mode must be 'local' or 'network'" });
    }
    if (networkNodeUrl !== undefined && typeof networkNodeUrl !== "string") {
      return res.status(400).json({ error: "networkNodeUrl must be a string" });
    }
    if (networkNodeUrl && !/^https?:\/\/.+/.test(networkNodeUrl)) {
      return res.status(400).json({ error: "networkNodeUrl must be a valid HTTP(S) URL" });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existing = (userConfig.imageGen ?? {}) as Record<string, unknown>;
      const updated: Record<string, unknown> = { ...existing };
      if (mode !== undefined) updated.mode = mode;
      if (networkNodeUrl !== undefined) updated.networkNodeUrl = networkNodeUrl;
      if (networkNodeToken !== undefined) updated.networkNodeToken = networkNodeToken;
      userConfig.imageGen = updated;
      await writeUserConfig(configPath, userConfig);

      logger.info(`[Admin] Image-gen config updated: mode=${updated.mode}`);
      return res.json({
        ok: true,
        mode: updated.mode,
        networkNodeUrl: updated.networkNodeUrl,
        hasToken: !!updated.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/image-gen/health", async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : undefined;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;

    // Determine target: explicit query params or saved config
    let targetUrl: string;
    let targetToken: string | undefined;
    if (url) {
      if (!/^https?:\/\/.+/.test(url)) {
        return res.status(400).json({ error: "url must be a valid HTTP(S) URL" });
      }
      targetUrl = url.replace(/\/$/, "");
      targetToken = token;
    } else {
      const userConfig = await readUserConfig(defaultConfigPath());
      const imageGen = (userConfig.imageGen ?? {}) as Record<string, unknown>;
      targetUrl = ((imageGen.networkNodeUrl as string) || "http://127.0.0.1:5005").replace(/\/$/, "");
      targetToken = imageGen.networkNodeToken as string | undefined;
    }

    try {
      const headers: Record<string, string> = {};
      if (targetToken) {
        headers["Authorization"] = `Bearer ${targetToken}`;
      }
      const response = await fetch(`${targetUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.json({ ok: false, status: response.status, error: `HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json({ ok: true, ...data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.json({ ok: false, error: message });
    }
  });

  // ── Video Generation Node Configuration ──
  router.get("/video-gen/config", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const videoGen = (userConfig.videoGen ?? {}) as Record<string, unknown>;
      return res.json({
        mode: videoGen.mode ?? "local",
        networkNodeUrl: videoGen.networkNodeUrl ?? "",
        networkNodeToken: videoGen.networkNodeToken ? "••••••••" : "",
        hasToken: !!videoGen.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/video-gen/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const mode = body.mode as string | undefined;
    const networkNodeUrl = body.networkNodeUrl as string | undefined;
    const networkNodeToken = body.networkNodeToken as string | undefined;

    if (mode !== undefined && mode !== "local" && mode !== "network") {
      return res.status(400).json({ error: "mode must be 'local' or 'network'" });
    }
    if (networkNodeUrl !== undefined && typeof networkNodeUrl !== "string") {
      return res.status(400).json({ error: "networkNodeUrl must be a string" });
    }
    if (networkNodeUrl && !/^https?:\/\/.+/.test(networkNodeUrl)) {
      return res.status(400).json({ error: "networkNodeUrl must be a valid HTTP(S) URL" });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existing = (userConfig.videoGen ?? {}) as Record<string, unknown>;
      const updated: Record<string, unknown> = { ...existing };
      if (mode !== undefined) updated.mode = mode;
      if (networkNodeUrl !== undefined) updated.networkNodeUrl = networkNodeUrl;
      if (networkNodeToken !== undefined) updated.networkNodeToken = networkNodeToken;
      userConfig.videoGen = updated;
      await writeUserConfig(configPath, userConfig);

      logger.info(`[Admin] Video-gen config updated: mode=${updated.mode}`);
      return res.json({
        ok: true,
        mode: updated.mode,
        networkNodeUrl: updated.networkNodeUrl,
        hasToken: !!updated.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/video-gen/health", async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : undefined;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;

    let targetUrl: string;
    let targetToken: string | undefined;
    if (url) {
      if (!/^https?:\/\/.+/.test(url)) {
        return res.status(400).json({ error: "url must be a valid HTTP(S) URL" });
      }
      targetUrl = url.replace(/\/$/, "");
      targetToken = token;
    } else {
      const userConfig = await readUserConfig(defaultConfigPath());
      const videoGen = (userConfig.videoGen ?? {}) as Record<string, unknown>;
      targetUrl = ((videoGen.networkNodeUrl as string) || "http://127.0.0.1:5007").replace(/\/$/, "");
      targetToken = videoGen.networkNodeToken as string | undefined;
    }

    try {
      const headers: Record<string, string> = {};
      if (targetToken) {
        headers["Authorization"] = `Bearer ${targetToken}`;
      }
      const response = await fetch(`${targetUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.json({ ok: false, status: response.status, error: `HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json({ ok: true, ...data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.json({ ok: false, error: message });
    }
  });

  // ── Music Generation Node Configuration ──
  router.get("/music-gen/config", async (_req, res) => {
    try {
      const userConfig = await readUserConfig(defaultConfigPath());
      const musicGen = (userConfig.musicGen ?? {}) as Record<string, unknown>;
      return res.json({
        mode: musicGen.mode ?? "local",
        networkNodeUrl: musicGen.networkNodeUrl ?? "",
        networkNodeToken: musicGen.networkNodeToken ? "••••••••" : "",
        hasToken: !!musicGen.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/music-gen/config", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const mode = body.mode as string | undefined;
    const networkNodeUrl = body.networkNodeUrl as string | undefined;
    const networkNodeToken = body.networkNodeToken as string | undefined;

    if (mode !== undefined && mode !== "local" && mode !== "network") {
      return res.status(400).json({ error: "mode must be 'local' or 'network'" });
    }
    if (networkNodeUrl !== undefined && typeof networkNodeUrl !== "string") {
      return res.status(400).json({ error: "networkNodeUrl must be a string" });
    }
    if (networkNodeUrl && !/^https?:\/\/.+/.test(networkNodeUrl)) {
      return res.status(400).json({ error: "networkNodeUrl must be a valid HTTP(S) URL" });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const existing = (userConfig.musicGen ?? {}) as Record<string, unknown>;
      const updated: Record<string, unknown> = { ...existing };
      if (mode !== undefined) updated.mode = mode;
      if (networkNodeUrl !== undefined) updated.networkNodeUrl = networkNodeUrl;
      if (networkNodeToken !== undefined) updated.networkNodeToken = networkNodeToken;
      userConfig.musicGen = updated;
      await writeUserConfig(configPath, userConfig);

      logger.info(`[Admin] Music-gen config updated: mode=${updated.mode}`);
      return res.json({
        ok: true,
        mode: updated.mode,
        networkNodeUrl: updated.networkNodeUrl,
        hasToken: !!updated.networkNodeToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/music-gen/health", async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : undefined;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;

    let targetUrl: string;
    let targetToken: string | undefined;
    if (url) {
      if (!/^https?:\/\/.+/.test(url)) {
        return res.status(400).json({ error: "url must be a valid HTTP(S) URL" });
      }
      targetUrl = url.replace(/\/$/, "");
      targetToken = token;
    } else {
      const userConfig = await readUserConfig(defaultConfigPath());
      const musicGen = (userConfig.musicGen ?? {}) as Record<string, unknown>;
      targetUrl = ((musicGen.networkNodeUrl as string) || "http://127.0.0.1:5009").replace(/\/$/, "");
      targetToken = musicGen.networkNodeToken as string | undefined;
    }

    try {
      const headers: Record<string, string> = {};
      if (targetToken) {
        headers["Authorization"] = `Bearer ${targetToken}`;
      }
      const response = await fetch(`${targetUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.json({ ok: false, status: response.status, error: `HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json({ ok: true, ...data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.json({ ok: false, error: message });
    }
  });

  // ── Music Studio Sidecar Proxy ──────────────────────────────

  /** Resolve sidecar base URL from user config. */
  async function musicStudioBaseUrl(): Promise<string> {
    const userConfig = await readUserConfig(defaultConfigPath());
    const ms = (userConfig.musicStudio ?? {}) as Record<string, unknown>;
    return ((ms.networkNodeUrl as string) || "http://localhost:5010").replace(/\/$/, "");
  }

  router.get("/music-studio/models", async (_req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const response = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.status(502).json({ error: `Sidecar returned HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ models: [], voice_references: [], error: message });
    }
  });

  // ── Voice Reference Proxy Routes ───────────────────────────

  router.get("/music-studio/voice-references", async (_req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const response = await fetch(`${baseUrl}/voice-references`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.status(502).json({ error: `Sidecar HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ references: [], error: message });
    }
  });

  router.post("/music-studio/voice-references/upload", async (req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      // Forward the multipart body directly to the sidecar
      const contentType = req.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);

      const response = await fetch(`${baseUrl}/voice-references/upload`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: text });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: message });
    }
  });

  router.get("/music-studio/voice-references/:refId", async (req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const response = await fetch(`${baseUrl}/voice-references/${encodeURIComponent(req.params.refId)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: `Sidecar HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: message });
    }
  });

  router.get("/music-studio/voice-references/:refId/audio", async (req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const response = await fetch(`${baseUrl}/voice-references/${encodeURIComponent(req.params.refId)}/audio`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: `Sidecar HTTP ${response.status}` });
      }
      res.setHeader("Content-Type", response.headers.get("content-type") ?? "audio/wav");
      const arrayBuf = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuf));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: message });
    }
  });

  router.patch("/music-studio/voice-references/:refId", async (req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const { name } = req.body as { name?: string };
      const url = new URL(`${baseUrl}/voice-references/${encodeURIComponent(req.params.refId)}`);
      if (name) url.searchParams.set("name", name);
      const response = await fetch(url.toString(), {
        method: "PATCH",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: `Sidecar HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: message });
    }
  });

  router.delete("/music-studio/voice-references/:refId", async (req, res) => {
    try {
      const baseUrl = await musicStudioBaseUrl();
      const response = await fetch(`${baseUrl}/voice-references/${encodeURIComponent(req.params.refId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: `Sidecar HTTP ${response.status}` });
      }
      const data = await response.json() as Record<string, unknown>;
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: message });
    }
  });

  // ── Skills API ──
  router.get("/skills", async (_req, res) => {
    try {
      const dirs = copilot?.getSkillDirectories?.() ?? [];
      const skills = await loadSkillMetadata(dirs);
      return res.json({ skills });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load skills: ${message}`);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/skills/:name", async (req, res) => {
    try {
      const dirs = copilot?.getSkillDirectories?.() ?? [];
      const skills = await loadSkillMetadata(dirs, true);
      const skill = skills.find((s) => s.name === req.params.name);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      return res.json(skill);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load skill content for '${req.params.name}': ${message}`);
      return res.status(500).json({ error: message });
    }
  });

  // Skill write endpoints (user skills in ~/.openzigs/skills/)
  const userSkillsDir = path.join(os.homedir(), ".openzigs", "skills");

  router.post("/skills/validate", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return res.status(400).json({ error: "content is required" });

    // Check frontmatter has name
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const toolsMatch = content.match(/^allowed-tools:\s*(.+)$/m);
    const errors: string[] = [];
    if (!nameMatch) errors.push("Missing 'name' in YAML frontmatter");
    if (toolsMatch) {
      const tools = toolsMatch[1].trim().split(/\s+/);
      const available = new Set(toolRegistry.listEnabledTools().map((t) => t.name));
      const invalid = tools.filter((t) => !available.has(t));
      if (invalid.length) errors.push(`Unknown tools: ${invalid.join(", ")}`);
    }
    return res.json({ valid: errors.length === 0, errors, parsedName: nameMatch?.[1]?.trim() });
  });

  router.post("/skills", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!name || !content) return res.status(400).json({ error: "name and content are required" });

    // Reject path-traversal characters
    if (/[/\\.]/.test(name)) return res.status(400).json({ error: "Invalid skill name" });

    try {
      const skillDir = path.join(userSkillsDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");

      // Hot-reload: add to copilot skill directories
      if (copilot?.addSkillDirectory) {
        copilot.addSkillDirectory(skillDir);
      }

      const skills = await loadSkillMetadata([skillDir], true);
      _adminIo?.emit("skills:updated");
      return res.json({ success: true, skill: skills[0] ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.put("/skills/:name", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    const skillName = req.params.name;
    if (!content) return res.status(400).json({ error: "content is required" });

    // Check both built-in and user directories
    const dirs = copilot?.getSkillDirectories?.() ?? [];
    const builtInDir = dirs.find((d) => path.basename(d) === skillName && d.includes("src/skills"));
    if (builtInDir) return res.status(403).json({ error: "Built-in skills are read-only" });

    try {
      const skillDir = path.join(userSkillsDir, skillName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");

      if (copilot?.addSkillDirectory) {
        copilot.addSkillDirectory(skillDir);
      }

      const skills = await loadSkillMetadata([skillDir], true);
      _adminIo?.emit("skills:updated");
      return res.json({ success: true, skill: skills[0] ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.delete("/skills/:name", async (req, res) => {
    const skillName = req.params.name;
    if (/[/\\.]/.test(skillName)) return res.status(400).json({ error: "Invalid skill name" });

    const dirs = copilot?.getSkillDirectories?.() ?? [];
    const builtInDir = dirs.find((d) => path.basename(d) === skillName && d.includes("src/skills"));
    if (builtInDir) return res.status(403).json({ error: "Cannot delete built-in skills" });

    try {
      const skillDir = path.join(userSkillsDir, skillName);
      await fs.rm(skillDir, { recursive: true, force: true });
      _adminIo?.emit("skills:updated");
      return res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Pinterest SEO Routes ─────────────────────────────────────────────────

  /** GET /api/admin/pinterest/credentials — return masked Pinterest credentials */
  router.get("/pinterest/credentials", (_req, res) => {
    const token = (process.env.PINTEREST_ACCESS_TOKEN ?? "").trim();
    const adAccountId = (process.env.PINTEREST_AD_ACCOUNT_ID ?? "").trim();
    const refreshToken = (process.env.PINTEREST_REFRESH_TOKEN ?? "").trim();
    const expiresAt = (process.env.PINTEREST_TOKEN_EXPIRES_AT ?? "").trim();
    const appId = (process.env.PINTEREST_APP_ID ?? "").trim();
    const appSecret = (process.env.PINTEREST_APP_SECRET ?? "").trim();
    res.json({
      accessToken: token ? `${token.slice(0, 8)}…${token.slice(-4)}` : "",
      adAccountId,
      configured: !!token,
      hasRefreshToken: !!refreshToken,
      expiresAt: expiresAt || null,
      oauthConfigured: !!(appId && appSecret),
    });
  });

  /** POST /api/admin/pinterest/credentials — save Pinterest credentials to .env */
  router.post("/pinterest/credentials", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const adAccountId = typeof body.adAccountId === "string" ? body.adAccountId.trim() : "";

    if (!accessToken) {
      return res.status(400).json({ error: "accessToken is required" });
    }

    try {
      const envPath = defaultEnvPath();
      const updates: Record<string, string> = { PINTEREST_ACCESS_TOKEN: accessToken };
      if (adAccountId) {
        updates.PINTEREST_AD_ACCOUNT_ID = adAccountId;
      }
      await upsertEnvFile(envPath, updates);

      // Update process.env immediately so tools work without restart
      process.env.PINTEREST_ACCESS_TOKEN = accessToken;
      if (adAccountId) {
        process.env.PINTEREST_AD_ACCOUNT_ID = adAccountId;
      }

      // Auto-create the daily Pinterest job when a token is saved
      if (scheduler) {
        ensurePinterestScheduledJob(scheduler);
      }

      logger.info("Updated Pinterest credentials via admin UI");
      return res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  /** POST /api/admin/pinterest/app-credentials — save Pinterest App ID + Secret for OAuth */
  router.post("/pinterest/app-credentials", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const appSecret = typeof body.appSecret === "string" ? body.appSecret.trim() : "";

    if (!appId || !appSecret) {
      return res.status(400).json({ error: "appId and appSecret are required" });
    }

    try {
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, { PINTEREST_APP_ID: appId, PINTEREST_APP_SECRET: appSecret });
      process.env.PINTEREST_APP_ID = appId;
      process.env.PINTEREST_APP_SECRET = appSecret;
      logger.info("Updated Pinterest OAuth app credentials via admin UI");
      return res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  /** GET /api/admin/pinterest/oauth/authorize — generate Pinterest OAuth URL */
  router.get("/pinterest/oauth/authorize", (_req, res) => {
    const appId = (process.env.PINTEREST_APP_ID ?? "").trim();
    if (!appId) {
      return res.status(400).json({ error: "PINTEREST_APP_ID not configured. Set your App ID first." });
    }

    const backendPort = Number(process.env.PORT ?? 3000);
    const redirectUri = (process.env.PINTEREST_REDIRECT_URI ?? "").trim() || `http://localhost:${backendPort}/api/pinterest/oauth/callback`;

    // CSRF state token
    const state = randomUUID();
    // Store in module-level map (short-lived, single-user self-hosted app)
    pinterestOAuthStates.set(state, Date.now());
    // Clean stale states older than 10 minutes
    for (const [k, ts] of pinterestOAuthStates) {
      if (Date.now() - ts > 600_000) pinterestOAuthStates.delete(k);
    }

    const scopes = [
      "ads:read", "ads:write",
      "boards:read", "boards:write", "boards:read_secret", "boards:write_secret",
      "catalogs:read", "catalogs:write",
      "pins:read", "pins:write", "pins:read_secret", "pins:write_secret",
      "user_accounts:read", "user_accounts:write",
      "billing:read", "billing:write",
      "biz_access:read", "biz_access:write",
    ];

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(","),
      state,
    });

    const authUrl = `https://www.pinterest.com/oauth/?${params.toString()}`;
    return res.json({ authUrl, state });
  });

  /** POST /api/admin/pinterest/oauth/refresh — manually trigger token refresh */
  router.post("/pinterest/oauth/refresh", async (_req, res) => {
    try {
      const result = await refreshPinterestToken();
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  /** POST /api/admin/pinterest/oauth/disconnect — clear all Pinterest OAuth tokens */
  router.post("/pinterest/oauth/disconnect", async (_req, res) => {
    try {
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, {
        PINTEREST_ACCESS_TOKEN: "",
        PINTEREST_REFRESH_TOKEN: "",
        PINTEREST_TOKEN_EXPIRES_AT: "",
      });
      delete process.env.PINTEREST_ACCESS_TOKEN;
      delete process.env.PINTEREST_REFRESH_TOKEN;
      delete process.env.PINTEREST_TOKEN_EXPIRES_AT;
      logger.info("Pinterest OAuth disconnected via admin UI");
      return res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/pinterest/status", async (_req, res) => {
    const token = process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) {
      return res.json({ connected: false, message: "PINTEREST_ACCESS_TOKEN not configured" });
    }
    try {
      const apiRes = await fetch("https://api.pinterest.com/v5/user_account", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!apiRes.ok) {
        return res.status(502).json({ connected: false, message: `Pinterest API error: ${apiRes.status}` });
      }
      const profile = await apiRes.json();
      return res.json({ connected: true, profile });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ connected: false, message });
    }
  });

  router.get("/pinterest/trends", async (req, res) => {
    const token = process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) {
      return res.status(400).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });
    }
    const region = typeof req.query.region === "string" ? req.query.region : "US";
    const limit = typeof req.query.limit === "string" ? req.query.limit : "10";
    try {
      const url = new URL(`https://api.pinterest.com/v5/trends/keywords/${encodeURIComponent(region)}/top/growing`);
      url.searchParams.set("limit", limit);
      const apiRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!apiRes.ok) {
        const body = await apiRes.text();
        return res.status(apiRes.status).json({ error: body });
      }
      const data = await apiRes.json();
      return res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.get("/pinterest/stats", async (req, res) => {
    const token = process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) {
      return res.status(400).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });
    }
    const days = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : 7;
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
    try {
      const url = new URL("https://api.pinterest.com/v5/user_account/analytics");
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date", endDate);
      url.searchParams.set("metric_types", "IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE,ENGAGEMENT");
      const apiRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!apiRes.ok) {
        const body = await apiRes.text();
        return res.status(apiRes.status).json({ error: body });
      }
      const data = await apiRes.json();
      return res.json({ start_date: startDate, end_date: endDate, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  return router;
};
