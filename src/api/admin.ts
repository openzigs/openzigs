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
] as const;

type SidecarCredential = {
  platform: string;
  label: string;
  imageAvailable: boolean;
  envVars: { name: string; configured: boolean }[];
};

const SIDECAR_CREDENTIALS: Array<{ platform: string; label: string; envVars: string[]; imageAvailable: boolean }> = [
  { platform: "linkedin", label: "LinkedIn", envVars: ["LINKEDIN_ACCESS_TOKEN"], imageAvailable: true },
  { platform: "twitter", label: "Twitter / X", envVars: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"], imageAvailable: true },
  { platform: "facebook", label: "Facebook", envVars: ["FACEBOOK_PAGE_TOKEN"], imageAvailable: true },
  { platform: "pinterest", label: "Pinterest", envVars: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"], imageAvailable: true },
  // Word/Office and Calendar are NOT Docker sidecars — they use local MCP servers (see LOCAL_SERVER_CREDENTIALS below)
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
};

export const createAdminRouter = ({ toolRegistry, sidecarManager, localServerManager, promptManager, scheduler }: AdminRouterOptions) => {
  const router = Router();

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
    const sidecarToolMap: Record<string, string[]> = {
      linkedin: ["social-post", "social-timeline", "social-profile"],
      twitter: ["social-post", "social-timeline", "social-profile"],
      facebook: ["social-post", "social-timeline", "social-profile"],
      pinterest: ["social-post", "social-timeline", "social-profile", "pinterest-boards", "pinterest-pins"],
      markitdown: ["convert-to-markdown"],
      gmail: ["gmail-search", "gmail-read", "gmail-draft", "gmail-send"],
      database: ["db-list-tables", "db-describe", "db-query"],
      github: ["github-get-file", "github-search-code", "github-list-issues", "github-create-issue", "github-create-pr"],
    };
    const toolNames = sidecarToolMap[name];
    if (!toolNames) {
      return res.status(404).json({ error: `Unknown sidecar: ${name}` });
    }
    const tools = toolNames.map((toolName) => {
      const info = toolRegistry.getToolInfo(toolName);
      return info
        ? { name: info.name, description: info.description, riskLevel: info.riskLevel, enabled: info.enabled }
        : { name: toolName, description: "", riskLevel: "low", enabled: false };
    });
    return res.json({ sidecar: name, tools });
  });

  // ── Per-Sidecar Tool Toggle ──
  router.put("/sidecars/:name/tools", async (req, res) => {
    const { name } = req.params;
    const { disabledTools } = req.body as { disabledTools?: string[] };
    if (!Array.isArray(disabledTools)) {
      return res.status(400).json({ error: "disabledTools must be an array of tool names" });
    }
    try {
      const configPath = path.resolve(process.cwd(), "config", "default.json");
      const raw = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
      const sidecars = (mcpServers.sidecars ?? {}) as Record<string, Record<string, unknown>>;
      const sidecar = sidecars[name] ?? {};
      sidecar.disabledTools = disabledTools;
      sidecars[name] = sidecar;
      mcpServers.sidecars = sidecars;
      config.mcpServers = mcpServers;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      logger.info(`Updated disabledTools for sidecar "${name}": ${disabledTools.join(", ") || "(none)"}`);
      return res.json({ ok: true, sidecar: name, disabledTools, restartRequired: true });
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

    const credentials: SidecarCredential[] = SIDECAR_CREDENTIALS.map((cred) => ({
      platform: cred.platform,
      label: cred.label,
      imageAvailable: cred.imageAvailable,
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

  return router;
};
