import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { logger } from "../logging/logger.js";
import type { Role } from "../auth/auth.js";

export type RateLimitConfig = {
  windowMs: number;
  max: number;
};

export type AuthConfig = {
  mode: "local" | "github";
  token?: string;
  role?: Role;
  rateLimit: RateLimitConfig;
};

export type AccessControlMode = "allowlist" | "blocklist" | "open";

export type AccessControlConfig = {
  mode: AccessControlMode;
  allowedUsers: string[];
  blockedUsers: string[];
};

export type MessagingConfig = {
  accessControl: AccessControlConfig;
};

export type TelegramConfig = {
  enabled: boolean;
  token: string;
  webhookUrl?: string;
  webhookSecret?: string;
  allowedUsers: string[];
  adminUserId?: string;
  model?: string;
};

export type DiscordConfig = {
  enabled: boolean;
  token: string;
  allowedGuilds: string[];
};

export type WebChannelConfig = {
  enabled: boolean;
};

export type ChannelsConfig = {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  web?: WebChannelConfig;
};

export type TunnelMode = "quick" | "named";

export type NamedTunnelConfig = {
  credentialsFile: string;
  hostname: string;
};

export type TunnelConfig = {
  enabled: boolean;
  mode: TunnelMode;
  namedTunnel?: NamedTunnelConfig;
};

export type SidecarConfig = {
  enabled: boolean;
};

export type McpServersConfig = {
  autoProvision: boolean;
  skipUnconfigured: boolean;
  healthRetries: number;
  healthRetryDelay: number;
  network: string;
  sidecars: Record<string, SidecarConfig>;
};

export type TasksConfig = {
  maxConcurrent: number;
};

export type InfiniteSessionConfig = {
  enabled?: boolean;
  backgroundCompactionThreshold?: number;
  bufferExhaustionThreshold?: number;
};

export type SessionConfig = {
  historyWindow: number;
  maxToolsPerRequest: number;
  dynamicToolLoading: boolean;
  infiniteSessions?: InfiniteSessionConfig;
};

export type CopilotProviderConfig =
  | { type: "openai"; baseUrl: string; apiKey?: string; bearerToken?: string; wireApi?: "openai" | "anthropic" }
  | { type: "azure"; baseUrl: string; apiKey?: string; bearerToken?: string; azure?: { apiVersion?: string } }
  | { type: "anthropic"; baseUrl: string; apiKey?: string; bearerToken?: string }
  | { type: "ollama"; baseUrl: string };

// ── Native Custom Agent Config ──
export type CustomAgentConfig = {
  name: string;
  displayName: string;
  description?: string;
  prompt: string;
  tools?: string[] | null;
  infer?: boolean;
  mcpServers?: Record<string, NativeMcpServerConfig>;
};

// ── Native MCP Server Config (SDK-level) ──
export type NativeMcpServerConfig =
  | { type: "local" | "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; tools?: string[]; timeout?: number }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; tools?: string[]; timeout?: number };

export type CopilotConfig = {
  provider?: CopilotProviderConfig | null;
  defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  defaultWorkingDirectory?: string | null;
  customAgents?: CustomAgentConfig[];
  nativeMcpServers?: Record<string, NativeMcpServerConfig>;
};

export type SentinelAppConfig = {
  enabled?: boolean;
  model?: string;
  checkIntervalMinutes?: number;
  jitterMinutes?: number;
  slowTaskThresholdMinutes?: number;
  orphanTaskThresholdMinutes?: number;
  digestHour?: number;
  auditHour?: number;
  consecutiveFailureThreshold?: number;
  queueDepthThreshold?: number;
  // #195: State & Memory
  persistMarkdownDigest?: boolean;
  markdownDigestPath?: string | null;
  digestRetentionDays?: number;
  // #196: Multi-channel alerts
  notifyChannels?: string[];
  criticalCooldownMinutes?: number;
  warningCooldownMinutes?: number;
  // #197: Advanced scheduler
  timezone?: string;
  noOverlap?: boolean;
  maxRandomDelayMs?: number;
};

export type AppConfig = {
  server: {
    port: number;
  };
  logging: {
    level: string;
  };
  auth: AuthConfig;
  messaging?: MessagingConfig;
  channels?: ChannelsConfig;
  tunnel?: TunnelConfig;
  mcpServers?: McpServersConfig;
  tasks?: TasksConfig;
  session?: SessionConfig;
  copilot?: CopilotConfig;
  sentinel?: SentinelAppConfig;
};

const rateLimitSchema = z.object({
  windowMs: z.number(),
  max: z.number()
});

const authSchema = z.object({
  mode: z.enum(["local", "github"]),
  token: z.string().optional(),
  role: z.enum(["viewer", "operator", "admin"]).optional(),
  rateLimit: rateLimitSchema
});

const accessControlSchema = z.object({
  mode: z.enum(["allowlist", "blocklist", "open"]),
  allowedUsers: z.array(z.string()),
  blockedUsers: z.array(z.string())
});

const messagingSchema = z.object({
  accessControl: accessControlSchema
}).optional();

const telegramSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  allowedUsers: z.array(z.string()),
  adminUserId: z.string().optional(),
  model: z.string().optional()
});

const discordSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowedGuilds: z.array(z.string())
});

const webChannelSchema = z.object({
  enabled: z.boolean()
});

const channelsSchema = z.object({
  telegram: telegramSchema.optional(),
  discord: discordSchema.optional(),
  web: webChannelSchema.optional()
}).optional();

const namedTunnelSchema = z.object({
  credentialsFile: z.string(),
  hostname: z.string()
});

const tunnelSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["quick", "named"]),
  namedTunnel: namedTunnelSchema.optional()
}).superRefine((value, ctx) => {
  if (value.enabled && value.mode === "named" && !value.namedTunnel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "namedTunnel is required when tunnel mode is named"
    });
  }
});

const sidecarConfigSchema = z.object({
  enabled: z.boolean()
});

const mcpServersSchema = z.object({
  autoProvision: z.boolean(),
  skipUnconfigured: z.boolean(),
  healthRetries: z.number(),
  healthRetryDelay: z.number(),
  network: z.string(),
  sidecars: z.record(z.string(), sidecarConfigSchema)
}).optional();

const tasksSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(10).default(2),
}).optional();

const infiniteSessionsSchema = z.object({
  enabled: z.boolean().default(true),
  backgroundCompactionThreshold: z.number().min(0).max(1).default(0.80),
  bufferExhaustionThreshold: z.number().min(0).max(1).default(0.95),
}).optional();

const sessionSchema = z.object({
  historyWindow: z.number().int().min(1).default(20),
  maxToolsPerRequest: z.number().int().min(1).max(128).default(30),
  dynamicToolLoading: z.boolean().default(false),
  infiniteSessions: infiniteSessionsSchema,
}).optional();

const providerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    bearerToken: z.string().optional(),
    wireApi: z.enum(["openai", "anthropic"]).optional(),
  }),
  z.object({
    type: z.literal("azure"),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    bearerToken: z.string().optional(),
    azure: z.object({ apiVersion: z.string().optional() }).optional(),
  }),
  z.object({
    type: z.literal("anthropic"),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    bearerToken: z.string().optional(),
  }),
  z.object({
    type: z.literal("ollama"),
    baseUrl: z.string(),
  }),
]);

/** Zod schema for a single MCP server config entry (local/stdio or http/sse). */
export const mcpServerConfigSchema = z.union([
  z.object({
    type: z.enum(["local", "stdio"]),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    tools: z.array(z.string()).optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string()).optional(),
    timeout: z.number().optional(),
  }),
]);

/** Zod schema for a single custom agent entry. */
export const customAgentSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  tools: z.array(z.string()).nullable().optional(),
  infer: z.boolean().optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

/** Zod schema for the nativeMcpServers record. */
export const nativeMcpServersSchema = z.record(z.string(), mcpServerConfigSchema);

const copilotSchema = z.object({
  provider: providerSchema.nullable().optional().default(null),
  defaultReasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional().default("medium"),
  defaultWorkingDirectory: z.string().nullable().optional().default(null),
  customAgents: z.array(customAgentSchema).optional().default([]),
  nativeMcpServers: nativeMcpServersSchema.optional().default({}),
}).optional();

const appConfigSchema = z.object({
  server: z.object({
    port: z.number()
  }),
  logging: z.object({
    level: z.string()
  }),
  auth: authSchema,
  messaging: messagingSchema,
  channels: channelsSchema,
  tunnel: tunnelSchema.optional(),
  mcpServers: mcpServersSchema,
  tasks: tasksSchema,
  session: sessionSchema,
  copilot: copilotSchema,
  sentinel: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    checkIntervalMinutes: z.number().optional(),
    jitterMinutes: z.number().optional(),
    slowTaskThresholdMinutes: z.number().optional(),
    orphanTaskThresholdMinutes: z.number().optional(),
    digestHour: z.number().optional(),
    auditHour: z.number().optional(),
    consecutiveFailureThreshold: z.number().optional(),
    queueDepthThreshold: z.number().optional(),
    persistMarkdownDigest: z.boolean().optional(),
    markdownDigestPath: z.string().nullable().optional(),
    digestRetentionDays: z.number().optional(),
    notifyChannels: z.array(z.string()).optional(),
    criticalCooldownMinutes: z.number().optional(),
    warningCooldownMinutes: z.number().optional(),
    timezone: z.string().optional(),
    noOverlap: z.boolean().optional(),
    maxRandomDelayMs: z.number().optional(),
  }).optional(),
});

export type LoadConfigOptions = {
  configPath?: string;
};

const defaultConfigPath = () => path.join(os.homedir(), ".openzigs", "config.json");

const defaultConfigFile = () => path.resolve(process.cwd(), "config", "default.json");

const interpolateEnv = (value: string) => {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name) => process.env[name] ?? "");
};

const applyEnv = (value: unknown): unknown => {
  if (typeof value === "string") {
    return interpolateEnv(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyEnv(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = applyEnv(nested);
    }
    return result;
  }
  return value;
};

const readJsonFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const deepMerge = (base: Record<string, unknown>, override: Record<string, unknown>) => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const baseValue = result[key];
      if (baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)) {
        result[key] = deepMerge(baseValue as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

const writeJsonFile = async (filePath: string, data: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
};

const toObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const ensureToken = async (
  config: AppConfig,
  configPath: string,
  userConfig: Record<string, unknown> | null
) => {
  if (config.auth.mode !== "local") {
    return config;
  }
  if (config.auth.token && config.auth.token.length >= 64) {
    return config;
  }

  const token = randomBytes(32).toString("hex");
  const updated: AppConfig = {
    ...config,
    auth: {
      ...config.auth,
      token
    }
  };

  const userConfigObject = toObject(userConfig);
  const userAuth = toObject(userConfigObject.auth);
  const updatedUserConfig = {
    ...userConfigObject,
    auth: {
      ...userAuth,
      token
    }
  };

  await writeJsonFile(configPath, updatedUserConfig);
  logger.info(`Generated local auth token in ${configPath}`);
  return updated;
};

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<AppConfig> => {
  const configPath = options.configPath
    ?? process.env.OPENZIGS_CONFIG_PATH
    ?? defaultConfigPath();

  const defaultConfigRaw = await readJsonFile(defaultConfigFile());
  // We apply env substitution after merging so user config can also use ${ENV_VARS}
  const userConfigRaw = await readJsonFile(configPath);

  const mergedRaw = deepMerge(defaultConfigRaw ?? {}, userConfigRaw ?? {});
  const merged = applyEnv(mergedRaw) as AppConfig;

  const parsed = appConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }

  return ensureToken(parsed.data, configPath, userConfigRaw);
};
