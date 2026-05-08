/**
 * Admin router: /api/admin/local-llm/*
 *
 * Local LLM provider management (epic #1053). Mounted in `src/server.ts`
 * alongside the other dedicated admin routers; deliberately not added to
 * the already-bloated `src/api/admin.ts` per copilot-instructions guidance.
 *
 * Endpoints:
 *   GET  /autodetect           — probe Ollama + vLLM, return discovered endpoints (#1058).
 *   GET  /status               — current provider, health badge state, privacy mode (#1057).
 *   POST /provider             — set the active local-copilot provider (#1057).
 *   DELETE /provider           — clear the active local-copilot provider.
 *   POST /privacy/global       — set the global lockdown switch (#1057).
 *   POST /vllm-key/rotate      — regenerate the persisted vLLM API key (#1058 decision).
 *   GET  /vllm-key             — return masked vLLM API key + creation hint.
 */

import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  secureDirOptions,
  secureWriteOptions,
  chmodSecureFile,
} from "../config/file-permissions.js";
import {
  localCopilotProviderSchema,
  type LocalCopilotProviderConfig,
  type LocalLlmConfig,
} from "../config/local-llm-schema.js";
import {
  autodetectEndpoints,
  type AutodetectResult,
} from "../copilot/providers/autodetect.js";
import { logger } from "../logging/logger.js";
import type { AuditLogger } from "../logging/audit-logger.js";

export type LocalLlmDeps = {
  /** Path to ~/.openzigs/config.json. Override in tests. */
  configPath?: string;
  /** Audit logger. */
  auditLogger?: AuditLogger;
  /** Local-LLM health monitor (read-only state read for /status). */
  healthMonitor?: {
    getState(): {
      status: "healthy" | "degraded" | "failed-over" | "disabled";
      lastProbeAt: string | null;
      consecutiveFailures: number;
      consecutiveSuccesses: number;
      failoverActive: boolean;
    };
  };
  /** Override fetch (autodetect). */
  fetchImpl?: typeof fetch;
};

const defaultConfigPath = () =>
  path.join(os.homedir(), ".openzigs", "config.json");

const VLLM_KEY_BYTES = 32;
const generateVllmApiKey = () => randomBytes(VLLM_KEY_BYTES).toString("base64url");

const maskKey = (key: string | undefined): string | null => {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
};

const readJson = async (
  filePath: string,
): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    throw err;
  }
};

const writeJson = async (filePath: string, data: unknown) => {
  await fs.mkdir(path.dirname(filePath), secureDirOptions());
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), secureWriteOptions());
  await fs.rename(tmp, filePath);
  await chmodSecureFile(filePath);
};

/**
 * Read the `localLlm` block from disk (returns sensible defaults if missing).
 * We deliberately read the raw user config file rather than going through
 * `loadConfig` so we don't have to round-trip the entire config object on every
 * write — that would risk losing keys this router doesn't know about.
 */
async function readLocalLlmBlock(
  configPath: string,
): Promise<{ raw: Record<string, unknown>; localLlm: LocalLlmConfig }> {
  const raw = await readJson(configPath);
  const block = (raw.localLlm ?? {}) as Partial<LocalLlmConfig>;
  return {
    raw,
    localLlm: {
      autodetect: block.autodetect ?? true,
      provider: (block.provider ?? null) as LocalCopilotProviderConfig | null,
      vllmApiKey: typeof block.vllmApiKey === "string" ? block.vllmApiKey : undefined,
      privacyMode: block.privacyMode ?? { globalLockdown: false },
      smartRouter: block.smartRouter ?? { enabled: true, cloudThresholdTokens: 4096 },
      costMeter: block.costMeter ?? { enabled: true, fetchLivePricing: true },
    },
  };
}

async function persistLocalLlmBlock(
  configPath: string,
  raw: Record<string, unknown>,
  next: LocalLlmConfig,
): Promise<void> {
  const updated = { ...raw, localLlm: next };
  await writeJson(configPath, updated);
}

/**
 * Ensure a vLLM API key exists in config; create one and persist if missing.
 * Idempotent. Per planner decision: 32 random bytes → base64url, 0o600 perms.
 */
export async function ensureVllmApiKey(
  configPath: string,
): Promise<{ apiKey: string; created: boolean }> {
  const { raw, localLlm } = await readLocalLlmBlock(configPath);
  if (localLlm.vllmApiKey && localLlm.vllmApiKey.length >= 16) {
    return { apiKey: localLlm.vllmApiKey, created: false };
  }
  const apiKey = generateVllmApiKey();
  await persistLocalLlmBlock(configPath, raw, { ...localLlm, vllmApiKey: apiKey });
  return { apiKey, created: true };
}

const setProviderBodySchema = localCopilotProviderSchema;

const privacyBodySchema = z.object({
  globalLockdown: z.boolean(),
});

export function createLocalLlmRouter(deps: LocalLlmDeps = {}): Router {
  const router = Router();
  const configPath = deps.configPath ?? defaultConfigPath();
  const audit = deps.auditLogger;

  router.get("/autodetect", async (_req: Request, res: Response) => {
    try {
      const { localLlm } = await readLocalLlmBlock(configPath);
      if (localLlm.autodetect === false) {
        const empty: AutodetectResult = { ollama: null, vllm: null };
        res.json({ ...empty, skipped: true });
        return;
      }
      const result = await autodetectEndpoints({ fetchImpl: deps.fetchImpl });
      if (audit) {
        await audit.log({
          level: "info",
          category: "system",
          event: "provider.autodetected",
          details: {
            ollama: result.ollama?.endpoint ?? null,
            vllm: result.vllm?.endpoint ?? null,
            ollamaModels: result.ollama?.models?.length ?? 0,
            vllmModels: result.vllm?.models?.length ?? 0,
          },
        });
      }
      res.json(result);
    } catch (err) {
      logger.warn("local-llm autodetect failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "autodetect_failed" });
    }
  });

  router.get("/status", async (_req: Request, res: Response) => {
    const { localLlm } = await readLocalLlmBlock(configPath);
    const provider = localLlm.provider ?? null;
    res.json({
      provider: provider
        ? {
            type: provider.type,
            endpoint: provider.endpoint,
            model: provider.model,
            timeoutMs: provider.timeoutMs,
            hasApiKey: !!provider.apiKey,
          }
        : null,
      privacyMode: localLlm.privacyMode ?? { globalLockdown: false },
      health: deps.healthMonitor?.getState() ?? {
        status: "disabled",
        lastProbeAt: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        failoverActive: false,
      },
      vllmKey: {
        masked: maskKey(localLlm.vllmApiKey),
        present: !!localLlm.vllmApiKey,
      },
    });
  });

  router.post("/provider", async (req: Request, res: Response): Promise<void> => {
    const parsed = setProviderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_provider",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { raw, localLlm } = await readLocalLlmBlock(configPath);
    await persistLocalLlmBlock(configPath, raw, {
      ...localLlm,
      provider: parsed.data,
    });
    if (audit) {
      await audit.log({
        level: "info",
        category: "session",
        event: "provider.registered",
        details: {
          type: parsed.data.type,
          endpoint: parsed.data.endpoint,
          model: parsed.data.model,
          // apiKey deliberately omitted from audit details
        },
      });
    }
    res.json({ ok: true });
  });

  router.delete("/provider", async (_req: Request, res: Response) => {
    const { raw, localLlm } = await readLocalLlmBlock(configPath);
    await persistLocalLlmBlock(configPath, raw, { ...localLlm, provider: null });
    if (audit) {
      await audit.log({
        level: "info",
        category: "session",
        event: "provider.cleared",
        details: { type: "local-copilot" },
      });
    }
    res.json({ ok: true });
  });

  router.post("/privacy/global", async (req: Request, res: Response): Promise<void> => {
    const parsed = privacyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_privacy", details: parsed.error.flatten() });
      return;
    }
    const { raw, localLlm } = await readLocalLlmBlock(configPath);
    await persistLocalLlmBlock(configPath, raw, {
      ...localLlm,
      privacyMode: { globalLockdown: parsed.data.globalLockdown },
    });
    if (audit) {
      await audit.log({
        level: "security",
        category: "security",
        event: parsed.data.globalLockdown
          ? "privacy.global_lockdown_enabled"
          : "privacy.global_lockdown_disabled",
        details: { globalLockdown: parsed.data.globalLockdown },
      });
    }
    res.json({ ok: true, globalLockdown: parsed.data.globalLockdown });
  });

  router.post("/vllm-key/rotate", async (_req: Request, res: Response) => {
    const { raw, localLlm } = await readLocalLlmBlock(configPath);
    const apiKey = generateVllmApiKey();
    await persistLocalLlmBlock(configPath, raw, { ...localLlm, vllmApiKey: apiKey });
    if (audit) {
      await audit.log({
        level: "security",
        category: "security",
        event: "vllm_api_key.rotated",
        details: { masked: maskKey(apiKey) },
      });
    }
    // Surface the plaintext key ONCE on rotation (planner decision).
    res.json({ apiKey, masked: maskKey(apiKey) });
  });

  router.get("/vllm-key", async (_req: Request, res: Response) => {
    const { localLlm } = await readLocalLlmBlock(configPath);
    res.json({
      masked: maskKey(localLlm.vllmApiKey),
      present: !!localLlm.vllmApiKey,
    });
  });

  return router;
}
