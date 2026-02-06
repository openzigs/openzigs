import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
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

export type AppConfig = {
  server: {
    port: number;
  };
  logging: {
    level: string;
  };
  auth: AuthConfig;
};

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

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
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

const ensureToken = async (config: AppConfig, configPath: string) => {
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

  await writeJsonFile(configPath, updated);
  logger.info(`Generated local auth token in ${configPath}`);
  return updated;
};

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<AppConfig> => {
  const configPath = options.configPath
    ?? process.env.OPENZIGS_CONFIG_PATH
    ?? defaultConfigPath();

  const defaultConfigRaw = await readJsonFile<Record<string, unknown>>(defaultConfigFile());
  const defaultConfig = applyEnv(defaultConfigRaw ?? {}) as Record<string, unknown>;
  const userConfig = await readJsonFile<Record<string, unknown>>(configPath);

  const merged = deepMerge(defaultConfig, userConfig ?? {}) as AppConfig;

  return ensureToken(merged, configPath);
};
