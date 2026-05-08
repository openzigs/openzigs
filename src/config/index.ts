import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import {
  secureDirOptions,
  secureWriteOptions,
  chmodSecureFile,
} from "./file-permissions.js";
import { logger } from "../logging/logger.js";
import { PROJECT_ROOT } from "../project-root.js";
import type { Role } from "../auth/auth.js";
import {
  localLlmSchema,
  localLlmHealthSchema,
  type LocalLlmConfig,
  type LocalLlmHealthConfig,
} from "./local-llm-schema.js";

export {
  localLlmSchema,
  localCopilotProviderSchema,
  localLlmHealthSchema,
  privacyModeSchema,
} from "./local-llm-schema.js";
export type {
  LocalLlmConfig,
  LocalLlmHealthConfig,
  LocalCopilotProviderConfig,
  PrivacyModeConfig,
} from "./local-llm-schema.js";

export type RateLimitConfig = {
  windowMs: number;
  max: number;
};

export type AuthConfig = {
  mode: "local" | "github";
  token?: string;
  role?: Role;
  rateLimit: RateLimitConfig;
  /** Optional shared secret for queue worker callbacks. When set, /api/queue callback endpoints require this as a Bearer token. */
  workerSecret?: string;
};

export type AccessControlMode =
  | "allowlist"
  | "blocklist"
  | "open"
  | "closed";

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
  notificationChannelId?: string;
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
  cfAccessTeamDomain?: string;
  cfAccessAudience?: string | string[];
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
  backgroundTaskDefaultModel?: string | null;
  defaultOrchestrationMode?: "task" | "session";
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
  | {
      type: "openai";
      baseUrl: string;
      apiKey?: string;
      bearerToken?: string;
      wireApi?: "completions" | "responses";
    }
  | {
      type: "azure";
      baseUrl: string;
      apiKey?: string;
      bearerToken?: string;
      azure?: { apiVersion?: string };
    }
  | {
      type: "anthropic";
      baseUrl: string;
      apiKey?: string;
      bearerToken?: string;
    }
  | { type: "ollama"; baseUrl: string };

// ── Native Custom Agent Config ──
export type CustomAgentConfig = {
  name: string;
  displayName?: string;
  description?: string;
  prompt?: string;
  role?: string;
  instructions?: string;
  tools?: string[] | null;
  infer?: boolean;
  mcpServers?: Record<string, NativeMcpServerConfig>;
};

// ── Native MCP Server Config (SDK-level) ──
export type NativeMcpServerConfig =
  | {
      type: "local" | "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      tools?: string[];
      disabledTools?: string[];
      timeout?: number;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      tools?: string[];
      disabledTools?: string[];
      timeout?: number;
    };

export type CopilotConfig = {
  provider?: CopilotProviderConfig | null;
  defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  defaultWorkingDirectory?: string | null;
  customAgents?: CustomAgentConfig[];
  nativeMcpServers?: Record<string, NativeMcpServerConfig>;
  /** Timeout in ms for the initial Copilot SDK `client.start()` call. Default 10000. */
  startTimeoutMs?: number;
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
  /** Epic #1053 / sub-issue #1055 — local LLM endpoint health monitor. */
  localLlmHealth?: LocalLlmHealthConfig;
};

export type KnowledgeAppConfig = {
  enabled?: boolean;
  directory?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  maxResults?: number;
  includeExtensions?: string[];
  excludePatterns?: string[];
  watchEnabled?: boolean;
  mediaModel?: string;
  vectorStore?: {
    provider?: "lancedb";
    options?: Record<string, unknown>;
  };
};

export type VaultAppConfig = {
  enabled?: boolean;
  /** Override the default vault file path (~/.openzigs/vault.enc). */
  vaultPath?: string;
};

export type MemoryAppConfig = {
  enabled?: boolean;
  owner?: string;
  repo?: string;
  cacheTtlMs?: number;
};

export type VoiceAppConfig = {
  enabled?: boolean;
  provider?: "google" | "local";
  voiceName?: string;
  speakingRate?: number;
  pitch?: number;
  cacheDir?: string;
  maxCacheSizeMb?: number;
  maxTextLength?: number;
  sidecarUrl?: string;
};

export type PresenterAppConfig = {
  inviteSecret?: string;
  baseUrl?: string;
};

export type ImageGenAppConfig = {
  mode?: "local" | "network";
  networkNodeUrl?: string;
  networkNodeToken?: string;
  trainingTimeoutHours?: number;
};

export type MusicGenAppConfig = {
  mode?: "local" | "network";
  networkNodeUrl?: string;
  networkNodeToken?: string;
};

export type LipSyncAppConfig = {
  enabled?: boolean;
  networkNodeUrl?: string;
  networkNodeToken?: string;
  defaultModel?: string;
  inferenceSteps?: number;
  guidanceScale?: number;
  enableDeepCache?: boolean;
  maxDurationSec?: number;
  modelIdleTimeoutSec?: number;
  memoryLimitGB?: number;
};

/**
 * Sub-issue #1010 — controls auto-start of CUDA sidecars at server boot.
 * When `autoStartSidecars` is true, the server pings `sidecarHealthUrl`
 * (default `http://127.0.0.1:5005/health`) on startup and, if the
 * endpoint is unreachable, spawns the platform-appropriate
 * `scripts/media-ctl.{ps1,sh} flux start` command (detached + ignored
 * stdio + unref()) and polls for readiness up to `startupTimeoutMs`.
 * Defaults are conservative — opt-in only, never blocks server startup
 * on failure (the queue worker recovers when sidecars come up later).
 */
export type MediaAppConfig = {
  autoStartSidecars?: boolean;
  sidecarHealthUrl?: string;
  startupTimeoutMs?: number;
};

export type SocialBrainPlatformConnectionConfig = {
  enabled?: boolean;
  mode?: "webhook" | "polling" | "browser";
  pollIntervalSeconds?: number;
  accessToken?: string;
};

export type SocialBrainAppConfig = {
  enabled?: boolean;
  /** Override the LLM model used for social brain responses (falls back to system default) */
  model?: string;
  /** Response style preset: "friendly" (default), "professional", "witty", "minimal" */
  responseStyle?: "friendly" | "professional" | "witty" | "minimal";
  confidenceThreshold?: "high" | "medium" | "low";
  /** Route comments (with no matching rule) through the Brain for AI auto-reply */
  commentBrainEnabled?: boolean;
  /** Hold AI-generated replies for human approval before sending */
  approvalRequired?: boolean;
  handoff?: {
    preferredChannel?: "discord" | "telegram";
    discordChannelId?: string;
    telegramChatId?: string;
    autoArchiveMinutes?: number;
  };
  commentAutomation?: {
    enabled?: boolean;
  };
  notifications?: {
    enabled?: boolean;
    /** Push incoming message alerts to Telegram admin chat */
    telegram?: boolean;
    /** Push incoming message alerts to Discord notification channel */
    discord?: boolean;
    /** Push incoming message alerts to the web UI via Socket.IO (always on) */
    web?: boolean;
  };
  connections?: Record<string, SocialBrainPlatformConnectionConfig>;
};

export type FirecrawlAppConfig = {
  enabled?: boolean;
  url?: string;
  idleTimeoutMs?: number;
};

export type AppConfig = {
  server: {
    port: number;
    trustProxy?: boolean | number | string;
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
  presenter?: PresenterAppConfig;
  imageGen?: ImageGenAppConfig;
  musicGen?: MusicGenAppConfig;
  lipSync?: LipSyncAppConfig;
  media?: MediaAppConfig;
  socialBrain?: SocialBrainAppConfig;
  sentinel?: SentinelAppConfig;
  knowledge?: KnowledgeAppConfig;
  voice?: VoiceAppConfig;
  vault?: VaultAppConfig;
  memory?: MemoryAppConfig;
  firecrawl?: FirecrawlAppConfig;
  workbench?: {
    directories?: string[];
  };
  /** Local LLM provider configuration (epic #1053). */
  localLlm?: LocalLlmConfig;
};

const rateLimitSchema = z.object({
  windowMs: z.number(),
  max: z.number(),
});

const authSchema = z.object({
  mode: z.enum(["local", "github"]),
  token: z.string().optional(),
  role: z.enum(["viewer", "operator", "admin"]).optional(),
  rateLimit: rateLimitSchema,
  workerSecret: z.string().optional(),
});

const accessControlSchema = z.object({
  mode: z.enum(["allowlist", "blocklist", "open", "closed"]),
  allowedUsers: z.array(z.string()),
  blockedUsers: z.array(z.string()),
});

const messagingSchema = z
  .object({
    accessControl: accessControlSchema,
  })
  .optional();

const telegramSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  allowedUsers: z.array(z.string()),
  adminUserId: z.string().optional(),
  model: z.string().optional(),
});

const discordSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowedGuilds: z.array(z.string()),
});

const webChannelSchema = z.object({
  enabled: z.boolean(),
});

const channelsSchema = z
  .object({
    telegram: telegramSchema.optional(),
    discord: discordSchema.optional(),
    web: webChannelSchema.optional(),
  })
  .optional();

const namedTunnelSchema = z.object({
  credentialsFile: z.string(),
  hostname: z.string(),
});

const tunnelSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["quick", "named"]),
    namedTunnel: namedTunnelSchema.optional(),
    cfAccessTeamDomain: z.string().optional(),
    cfAccessAudience: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.mode === "named" && !value.namedTunnel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "namedTunnel is required when tunnel mode is named",
      });
    }
  });

const sidecarConfigSchema = z.object({
  enabled: z.boolean(),
});

const mcpServersSchema = z
  .object({
    autoProvision: z.boolean(),
    skipUnconfigured: z.boolean(),
    healthRetries: z.number(),
    healthRetryDelay: z.number(),
    network: z.string(),
    sidecars: z.record(z.string(), sidecarConfigSchema),
  })
  .optional();

const tasksSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(10).default(2),
    backgroundTaskDefaultModel: z.string().nullable().optional().default(null),
    defaultOrchestrationMode: z
      .enum(["task", "session"])
      .optional()
      .default("task"),
  })
  .optional();

const infiniteSessionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    backgroundCompactionThreshold: z.number().min(0).max(1).default(0.8),
    bufferExhaustionThreshold: z.number().min(0).max(1).default(0.95),
  })
  .optional();

const sessionSchema = z
  .object({
    historyWindow: z.number().int().min(1).default(20),
    maxToolsPerRequest: z.number().int().min(1).max(128).default(30),
    dynamicToolLoading: z.boolean().default(false),
    infiniteSessions: infiniteSessionsSchema,
  })
  .optional();

const providerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    bearerToken: z.string().optional(),
    wireApi: z.enum(["completions", "responses"]).optional(),
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
    disabledTools: z.array(z.string()).optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    timeout: z.number().optional(),
  }),
]);

/** Zod schema for a single custom agent entry. */
export const customAgentSchema = z
  .object({
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string().optional().default(""),
    role: z.string().optional(),
    instructions: z.string().optional(),
    tools: z.array(z.string()).nullable().optional(),
    infer: z.boolean().optional(),
    mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  })
  .strict();

/** Zod schema for the nativeMcpServers record. */
export const nativeMcpServersSchema = z.record(
  z.string(),
  mcpServerConfigSchema,
);

const copilotSchema = z
  .object({
    provider: providerSchema.nullable().optional().default(null),
    defaultReasoningEffort: z
      .enum(["low", "medium", "high", "xhigh"])
      .optional()
      .default("medium"),
    defaultWorkingDirectory: z.string().nullable().optional().default(null),
    customAgents: z.array(customAgentSchema).optional().default([]),
    nativeMcpServers: nativeMcpServersSchema.optional().default({}),
    startTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .optional()
      .default(10_000),
  })
  .optional();

const appConfigSchema = z.object({
  server: z.object({
    port: z.number(),
    trustProxy: z.union([z.boolean(), z.number(), z.string()]).optional(),
  }),
  logging: z.object({
    level: z.string(),
  }),
  auth: authSchema,
  messaging: messagingSchema,
  channels: channelsSchema,
  tunnel: tunnelSchema.optional(),
  mcpServers: mcpServersSchema,
  tasks: tasksSchema,
  session: sessionSchema,
  copilot: copilotSchema,
  presenter: z
    .object({
      inviteSecret: z.string().optional().default(""),
      baseUrl: z.string().optional().default(""),
    })
    .optional(),
  lipSync: z
    .object({
      enabled: z.boolean().optional().default(false),
      networkNodeUrl: z.string().optional().default(""),
      networkNodeToken: z.string().optional().default(""),
      defaultModel: z.string().optional().default("latentsync-v1.5"),
      inferenceSteps: z.number().int().min(1).max(100).optional().default(20),
      guidanceScale: z.number().min(0).max(10).optional().default(1.5),
      enableDeepCache: z.boolean().optional().default(true),
      maxDurationSec: z.number().int().min(1).max(120).optional().default(30),
      modelIdleTimeoutSec: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(300),
      memoryLimitGB: z.number().min(1).max(128).optional().default(24),
    })
    .optional(),
  llm: z
    .object({
      localVllm: z
        .object({
          enabled: z.boolean().optional().default(false),
          model: z
            .string()
            .optional()
            .default("Qwen/Qwen2.5-14B-Instruct-AWQ"),
          baseUrl: z.string().optional().default("http://127.0.0.1:8000"),
          maxQueueDepth: z
            .number()
            .int()
            .min(1)
            .max(64)
            .optional()
            .default(8),
          timeoutMs: z
            .number()
            .int()
            .min(1000)
            .max(600_000)
            .optional()
            .default(120_000),
          autoRegister: z.boolean().optional().default(true),
        })
        .optional(),
    })
    .optional(),
  socialBrain: z
    .object({
      enabled: z.boolean().optional(),
      confidenceThreshold: z.enum(["high", "medium", "low"]).optional(),
      commentBrainEnabled: z.boolean().optional(),
      approvalRequired: z.boolean().optional(),
      handoff: z
        .object({
          preferredChannel: z.enum(["discord", "telegram"]).optional(),
          discordChannelId: z.string().optional(),
          telegramChatId: z.string().optional(),
          autoArchiveMinutes: z.number().optional(),
        })
        .optional(),
      commentAutomation: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
      notifications: z
        .object({
          enabled: z.boolean().optional(),
          telegram: z.boolean().optional(),
          discord: z.boolean().optional(),
          web: z.boolean().optional(),
        })
        .optional(),
      connections: z
        .record(
          z.string(),
          z.object({
            enabled: z.boolean().optional(),
            mode: z.enum(["webhook", "polling", "browser"]).optional(),
            pollIntervalSeconds: z.number().optional(),
            accessToken: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  sentinel: z
    .object({
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
      // Epic #1053 / sub-issue #1055 — local LLM endpoint health monitor.
      localLlmHealth: localLlmHealthSchema,
    })
    .optional(),
  knowledge: z
    .object({
      enabled: z.boolean().optional(),
      directory: z.string().optional(),
      chunkSize: z.number().optional(),
      chunkOverlap: z.number().optional(),
      maxResults: z.number().optional(),
      includeExtensions: z.array(z.string()).optional(),
      excludePatterns: z.array(z.string()).optional(),
      watchEnabled: z.boolean().optional(),
      mediaModel: z.string().optional(),
      vectorStore: z
        .object({
          provider: z.enum(["lancedb"]).optional().default("lancedb"),
          options: z.record(z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
  voice: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(["google", "local"]).optional(),
      voiceName: z.string().optional(),
      speakingRate: z.number().min(0.25).max(4.0).optional(),
      pitch: z.number().min(-20).max(20).optional(),
      cacheDir: z.string().optional(),
      maxCacheSizeMb: z.number().min(1).optional(),
      maxTextLength: z.number().min(1).optional(),
      sidecarUrl: z.string().optional(),
    })
    .optional(),
  vault: z
    .object({
      enabled: z.boolean().optional(),
      vaultPath: z.string().optional(),
    })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional(),
      owner: z.string().optional(),
      repo: z.string().optional(),
      cacheTtlMs: z.number().min(0).optional(),
    })
    .optional(),
  firecrawl: z
    .object({
      enabled: z.boolean().optional().default(false),
      url: z.string().optional().default("http://localhost:3002"),
      idleTimeoutMs: z.number().min(0).optional().default(600000),
    })
    .optional(),
  workbench: z
    .object({
      directories: z.array(z.string()).optional().default([]),
    })
    .optional()
    .default({}),
  // Sub-issue #1010 — opt-in CUDA sidecar auto-start. See `MediaAppConfig`.
  media: z
    .object({
      autoStartSidecars: z.boolean().optional().default(false),
      sidecarHealthUrl: z
        .string()
        .optional()
        .default("http://127.0.0.1:5005/health"),
      startupTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(600_000)
        .optional()
        .default(60_000),
    })
    .optional(),
  // Epic #1053 — local LLM as primary provider.
  localLlm: localLlmSchema,
});

export type LoadConfigOptions = {
  configPath?: string;
};

const defaultConfigPath = () =>
  path.join(os.homedir(), ".openzigs", "config.json");

const defaultConfigFile = () =>
  path.resolve(PROJECT_ROOT, "config", "default.json");

const interpolateEnv = (value: string) => {
  return value.replace(
    /\$\{([^}]+)\}/g,
    (_match, name) => process.env[name] ?? "",
  );
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

const readJsonFile = async (
  filePath: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    // Strip UTF-8 BOM if present (e.g. when config was edited by Windows tools
    // such as PowerShell 5.1's Set-Content/Out-File which prepend EF BB BF).
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
};

const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
) => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const baseValue = result[key];
      if (
        baseValue &&
        typeof baseValue === "object" &&
        !Array.isArray(baseValue)
      ) {
        result[key] = deepMerge(
          baseValue as Record<string, unknown>,
          value as Record<string, unknown>,
        );
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
  await fs.mkdir(path.dirname(filePath), secureDirOptions());
  await fs.writeFile(
    filePath,
    JSON.stringify(data, null, 2),
    secureWriteOptions(),
  );
  await chmodSecureFile(filePath);
};

const toObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const ensureToken = async (
  config: AppConfig,
  configPath: string,
  userConfig: Record<string, unknown> | null,
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
      token,
    },
  };

  const userConfigObject = toObject(userConfig);
  const userAuth = toObject(userConfigObject.auth);
  const updatedUserConfig = {
    ...userConfigObject,
    auth: {
      ...userAuth,
      token,
    },
  };

  await writeJsonFile(configPath, updatedUserConfig);
  logger.info(`Generated local auth token in ${configPath}`);
  return updated;
};

export const loadConfig = async (
  options: LoadConfigOptions = {},
): Promise<AppConfig> => {
  const configPath =
    options.configPath ??
    process.env.OPENZIGS_CONFIG_PATH ??
    defaultConfigPath();

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
