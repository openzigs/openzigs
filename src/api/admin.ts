import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { ToolRegistry, RiskLevel } from "../mcp/tool-registry.js";
import type { DockerSidecarManager } from "../mcp/docker-sidecar-manager.js";
import type { LocalMcpServerManager } from "../mcp/local-mcp-server-manager.js";
import type { PromptManager } from "../productivity/prompt-manager.js";
import type { Scheduler } from "../productivity/scheduler.js";
import type { PersonalityManager } from "../personality/personality-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";

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
};

export const createAdminRouter = ({ toolRegistry, sidecarManager, localServerManager, promptManager, scheduler, personalityManager, sessionManager }: AdminRouterOptions) => {
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
      if (!name || !cronExpression) {
        return res.status(400).json({ error: "name and cronExpression are required" });
      }
      try {
        const job = scheduler.create({
          name,
          cronExpression,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          actionType: typeof body.actionType === "string" ? (body.actionType as "prompt" | "shell" | "custom") : undefined,
          actionPayload: (body.actionPayload ?? {}) as Record<string, unknown>,
          model: typeof body.model === "string" ? body.model : undefined,
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
      try {
        const updated = scheduler.update(req.params.id, {
          name: typeof body.name === "string" ? body.name.trim() : undefined,
          cronExpression: typeof body.cronExpression === "string" ? body.cronExpression.trim() : undefined,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          actionPayload: body.actionPayload as Record<string, unknown> | undefined,
          model: typeof body.model === "string" ? body.model : (body.model === null ? null : undefined),
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

  return router;
};
