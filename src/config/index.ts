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
  allowedUsers: string[];
  adminUserId?: string;
};

export type DiscordConfig = {
  enabled: boolean;
  token: string;
  allowedGuilds: string[];
};

export type ChannelsConfig = {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
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
  allowedUsers: z.array(z.string()),
  adminUserId: z.string().optional()
});

const discordSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowedGuilds: z.array(z.string())
});

const channelsSchema = z.object({
  telegram: telegramSchema.optional(),
  discord: discordSchema.optional()
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
  tunnel: tunnelSchema.optional()
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
  const defaultConfig = applyEnv(defaultConfigRaw ?? {}) as Record<string, unknown>;
  const userConfig = await readJsonFile(configPath);

  const merged = deepMerge(defaultConfig, userConfig ?? {}) as AppConfig;
  const parsed = appConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }

  return ensureToken(parsed.data, configPath, userConfig);
};
