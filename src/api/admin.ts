import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig, customAgentSchema, mcpServerConfigSchema, nativeMcpServersSchema } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";
import type { ToolRegistry, RiskLevel } from "../mcp/tool-registry.js";
import type { CopilotWrapper } from "../copilot/index.js";
import type { ReasoningEffort, ProviderConfig, CustomAgentDefinition, NativeMcpServerDefinition } from "../copilot/index.js";
import type { DockerSidecarManager } from "../mcp/docker-sidecar-manager.js";
import type { LocalMcpServerManager } from "../mcp/local-mcp-server-manager.js";
import type { PromptManager } from "../productivity/prompt-manager.js";
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
import type { SentinelService } from "../sentinel/index.js";
import { SentinelConfigSchema } from "../sentinel/index.js";
import { TemplateService } from "../productivity/template-service.js";

type EnvEntry = {
  name: string;
  configured: boolean;
};

const ENV_CHECKS = [
  "BRAVE_API_KEY",
  "CHROME_DEBUG_HOST",
  "CHROME_DEBUG_PORT",
  "OPENZIGS_ALLOWED_DIRS",
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
  "GOOGLE_OAUTH_CREDENTIALS",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "JDBC_URL",
  "DB_PASSWORD",
  "INSTAGRAM_ACCESS_TOKEN",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "INSTAGRAM_BUSINESS_ACCOUNT_ID",
] as const;

type SidecarCredential = {
  platform: string;
  label: string;
  imageAvailable: boolean;
  enabled: boolean;
  envVars: { name: string; configured: boolean }[];
};

const SIDECAR_CREDENTIALS: Array<{ platform: string; label: string; envVars: string[]; imageAvailable: boolean }> = [
  { platform: "linkedin", label: "LinkedIn", envVars: ["LINKEDIN_ACCESS_TOKEN"], imageAvailable: true },
  { platform: "twitter", label: "Twitter / X", envVars: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"], imageAvailable: true },
  { platform: "facebook", label: "Facebook", envVars: ["FACEBOOK_PAGE_TOKEN"], imageAvailable: true },
  { platform: "pinterest", label: "Pinterest", envVars: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"], imageAvailable: true },
  // Word/Office and Calendar are NOT Docker sidecars — they use local MCP servers (see LOCAL_SERVER_CREDENTIALS below)
  { platform: "markitdown", label: "MarkItDown", envVars: [], imageAvailable: true },
  { platform: "gmail", label: "Gmail", envVars: ["GOOGLE_OAUTH_CREDENTIALS"], imageAvailable: true },
  { platform: "database", label: "Database (JDBC)", envVars: ["JDBC_URL", "DB_PASSWORD"], imageAvailable: true },
  { platform: "github", label: "GitHub", envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"], imageAvailable: true },
];

type LocalServerCredential = {
  server: string;
  label: string;
  runtime: string;
  envVars: { name: string; configured: boolean }[];
};

const LOCAL_SERVER_CREDENTIALS: Array<{ server: string; label: string; runtime: string; envVars: string[] }> = [
  { server: "word", label: "Word / Office", runtime: "python", envVars: [] },
  { server: "calendar", label: "Google Calendar", runtime: "node", envVars: ["GOOGLE_OAUTH_CREDENTIALS"] },
  {
    server: "instagram",
    label: "Instagram",
    runtime: "python",
    envVars: ["INSTAGRAM_ACCESS_TOKEN", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_BUSINESS_ACCOUNT_ID"]
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

  // Append new keys
  if (remaining.size > 0) {
    updatedLines.push("");
    updatedLines.push("# MCP Credentials");
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

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
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

export const createAdminRouter = ({ toolRegistry, sidecarManager, localServerManager, promptManager, scheduler, personalityManager, sessionManager, copilot, taskWorker, taskEngine, webhookManager, customPostActionManager, sentinel }: AdminRouterOptions) => {
  const router = Router();

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

  router.get("/tools", (_req, res) => {
    const tools = toolRegistry.getAllTools();
    res.json({ tools });
  });

  router.post("/tools/:name/toggle", async (req, res) => {
    const { name } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    try {
      await toolRegistry.setEnabled(name, enabled);
      return res.json({ ok: true, tool: name, enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: message });
    }
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

  // ── Per-Sidecar Tool Listing ──
  router.get("/sidecars/:name/tools", (_req, res) => {
    const { name } = _req.params;

    // For social sidecars, merge platform-specific tools + cross-platform social tools
    const socialSidecars = new Set(["linkedin", "twitter", "facebook", "pinterest"]);
    if (socialSidecars.has(name)) {
      const platformTools = toolRegistry.getToolsBySource(name); // e.g. pinterest-specific
      const crossPlatformTools = toolRegistry.getToolsBySource("social"); // social-post, etc.
      const tools = [...platformTools, ...crossPlatformTools];
      return res.json({ sidecar: name, tools });
    }

    // For other sidecars with source tags, derive tool list dynamically
    const dynamicTools = toolRegistry.getToolsBySource(name);
    if (dynamicTools.length > 0) {
      return res.json({ sidecar: name, tools: dynamicTools });
    }

    return res.status(404).json({ error: `Unknown sidecar: ${name}` });
  });

  // ── Per-Sidecar Tool Toggle ──
  router.put("/sidecars/:name/tools", async (req, res) => {
    const { name } = req.params;
    const { disabledTools } = req.body as { disabledTools?: string[] };
    if (!Array.isArray(disabledTools)) {
      return res.status(400).json({ error: "disabledTools must be an array of tool names" });
    }
    try {
      // Merge platform-specific + cross-platform social tools
      const socialSidecars = new Set(["linkedin", "twitter", "facebook", "pinterest"]);
      let toolNames: string[];
      if (socialSidecars.has(name)) {
        const platformTools = toolRegistry.getToolsBySource(name);
        const crossPlatformTools = toolRegistry.getToolsBySource("social");
        toolNames = [...platformTools, ...crossPlatformTools].map((t) => t.name);
      } else {
        const allSidecarTools = toolRegistry.getToolsBySource(name);
        toolNames = allSidecarTools.map((t) => t.name);
      }

      if (toolNames.length === 0) {
        return res.status(404).json({ error: `Unknown sidecar: ${name}` });
      }

      const disabledSet = new Set(disabledTools);
      for (const toolName of toolNames) {
        await toolRegistry.setEnabled(toolName, !disabledSet.has(toolName));
      }

      logger.info(`Updated disabledTools for sidecar "${name}": ${disabledTools.join(", ") || "(none)"}`);
      return res.json({ ok: true, sidecar: name, disabledTools });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
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

  // ── MCP Sidecar Management ──
  router.get("/sidecars", async (_req, res) => {
    const dockerAvailable = sidecarManager
      ? await sidecarManager.isDockerAvailable()
      : false;

    const statuses = sidecarManager?.getAllStatuses() ?? [];
    const configured = sidecarManager?.getConfiguredSidecars() ?? [];

    // Load sidecar enabled states from config
    const sidecarEnabledMap: Record<string, boolean> = {};
    try {
      const config = await loadConfig();
      const sidecars = config.mcpServers?.sidecars as Record<string, { enabled?: boolean }> | undefined;
      if (sidecars) {
        for (const [name, cfg] of Object.entries(sidecars)) {
          sidecarEnabledMap[name] = cfg.enabled !== false; // default to true
        }
      }
    } catch {
      // Config unavailable — assume all enabled
    }

    const credentials: SidecarCredential[] = SIDECAR_CREDENTIALS.map((cred) => ({
      platform: cred.platform,
      label: cred.label,
      imageAvailable: cred.imageAvailable,
      enabled: sidecarEnabledMap[cred.platform] !== false,
      envVars: cred.envVars.map((name) => ({
        name,
        configured: !!(process.env[name] && process.env[name]!.trim().length > 0)
      }))
    }));

    return res.json({
      sidecars: statuses,
      configuredSidecars: configured,
      credentials,
      dockerAvailable,
    });
  });

  // ── Toggle MCP Sidecar Enabled/Disabled ──
  router.post("/sidecars/:name/toggle", async (req, res) => {
    const { name } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const validSidecars = new Set(SIDECAR_CREDENTIALS.map((c) => c.platform));
    if (!validSidecars.has(name)) {
      return res.status(404).json({ error: `Unknown sidecar: ${name}` });
    }

    try {
      const configPath = defaultConfigPath();
      const userConfig = await readUserConfig(configPath);
      const mcpServers = (userConfig.mcpServers && typeof userConfig.mcpServers === "object")
        ? (userConfig.mcpServers as Record<string, unknown>)
        : {};
      const sidecars = (mcpServers.sidecars && typeof mcpServers.sidecars === "object")
        ? (mcpServers.sidecars as Record<string, unknown>)
        : {};
      const existing = (sidecars[name] && typeof sidecars[name] === "object")
        ? (sidecars[name] as Record<string, unknown>)
        : {};

      sidecars[name] = { ...existing, enabled };
      mcpServers.sidecars = sidecars;
      userConfig.mcpServers = mcpServers;

      await writeUserConfig(configPath, userConfig);

      logger.info(`Sidecar "${name}" ${enabled ? "enabled" : "disabled"}`);
      return res.json({ ok: true, sidecar: name, enabled, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  // ── Save MCP sidecar credentials ──
  router.post("/sidecars/credentials", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const credentials = body.credentials as Record<string, string> | undefined;

    if (!credentials || typeof credentials !== "object") {
      return res.status(400).json({ error: "credentials must be an object of { ENV_VAR: value }" });
    }

    // Validate: only allow known sidecar + local server env vars
    const allEnvVars = new Set([
      ...SIDECAR_CREDENTIALS.flatMap((c) => c.envVars),
      ...LOCAL_SERVER_CREDENTIALS.flatMap((c) => c.envVars),
    ]);
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
      // Write to .env file
      const envPath = defaultEnvPath();
      await upsertEnvFile(envPath, filtered);

      // Update process.env in-memory so sidecars can start immediately
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

  router.post("/sidecars/:name/restart", async (req, res) => {
    const { name } = req.params;
    if (!sidecarManager) {
      return res.status(503).json({ error: "Docker sidecar manager not available" });
    }
    try {
      const status = await sidecarManager.restartSidecar(name);
      if (!status) {
        return res.status(404).json({ error: `Unknown sidecar: ${name}` });
      }
      return res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
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
      try {
        const prompt = promptManager.create({
          name,
          template,
          description: typeof body.description === "string" ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
          preferredTools: Array.isArray(body.preferredTools) ? (body.preferredTools as string[]) : undefined,
          stages: Array.isArray(body.stages) ? (body.stages as PipelineStage[]) : undefined,
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
    router.get("/jobs", (_req, res) => {
      return res.json({ jobs: scheduler.list() });
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
        // Dry-run: return job config without executing or affecting run counts
        return res.json({
          ok: true,
          dryRun: true,
          jobId: job.id,
          jobName: job.name,
          preview: {
            cronExpression: job.cronExpression,
            timezone: job.timezone,
            actionType: job.actionType,
            actionPayload: job.actionPayload,
            model: job.model,
          },
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
  }

  // ── Scheduler Assistant ──
  if (copilot) {
    router.post("/scheduler/assist", async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const promptNames = Array.isArray(body.promptNames)
        ? body.promptNames.filter((entry): entry is string => typeof entry === "string")
        : [];

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
        for await (const chunk of copilot.chat(instructions, { model: "gpt-5-mini", tools: [] })) {
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
  router.get("/native-mcp-servers", (_req, res) => {
    const servers = copilot?.getNativeMcpServers() ?? {};
    return res.json({ servers });
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

  router.post("/native-mcp-servers/:name", async (req, res) => {
    const { name } = req.params;
    const parsed = mcpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
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

    try {
      const current = copilot?.getNativeMcpServers() ?? {};
      if (!(name in current)) {
        return res.status(404).json({ error: `Server '${name}' not found` });
      }

      const updated = { ...current, [name]: parsed.data as NativeMcpServerDefinition };
      if (copilot) copilot.setNativeMcpServers(updated);

      await updateCopilotConfig("nativeMcpServers", updated);

      logger.info(`Native MCP server updated: ${name}`);
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

    try {
      const remaining = { ...current };
      delete remaining[name];
      if (copilot) copilot.setNativeMcpServers(remaining as Record<string, NativeMcpServerDefinition>);

      await updateCopilotConfig("nativeMcpServers", remaining);

      logger.info(`Native MCP server removed: ${name}`);
      return res.json({ ok: true });
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
      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
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
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
      try {
        const digests = await sentinel.getDigestHistory(limit);
        return res.json({ digests });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: message });
      }
    });
  }

  return router;
};
