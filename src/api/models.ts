import { Router } from "express";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import { MODEL_CONTEXT_WINDOWS } from "../copilot/token-tracker.js";
import { PROJECT_ROOT } from "../project-root.js";

export type ModelsRouterOptions = {
  copilot: CopilotWrapper;
  userConfigPath?: string;
};

const defaultUserConfigPath = () =>
  path.resolve(PROJECT_ROOT, "config", "user.json");

const readUserConfig = async (
  configPath: string,
): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeUserConfig = async (
  configPath: string,
  data: Record<string, unknown>,
) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), "utf-8");
};

const fetchOllamaModels = (baseUrl: string): Promise<{ id: string }[]> => {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/tags", baseUrl.replace(/\/+$/, ""));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url.toString(), { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as { models?: { name: string }[] };
          const models = (parsed.models ?? []).map((m) => ({ id: m.name }));
          resolve(models);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama /api/tags timed out"));
    });
  });
};

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
};

const FALLBACK_MODELS = [
  { id: "gpt-4.1" },
  { id: "gpt-4o" },
  { id: "gpt-4.1-mini" },
  { id: "claude-sonnet-4" },
  { id: "claude-3.5-sonnet" },
  { id: "o3-mini" },
];

export const createModelsRouter = ({
  copilot,
  userConfigPath,
}: ModelsRouterOptions): Router => {
  const router = Router();
  const configPath = userConfigPath ?? defaultUserConfigPath();

  router.get("/", async (_req, res) => {
    const userConfig = await readUserConfig(configPath);
    const selectedModel =
      typeof userConfig.selectedModel === "string"
        ? userConfig.selectedModel
        : null;

    // When a BYOK Ollama provider is active, list models from Ollama instead of Copilot SDK
    const provider = copilot.getProvider();
    if (provider?.type === "ollama") {
      try {
        const models = await fetchOllamaModels(provider.baseUrl);
        const modelsWithContext = models.map((m) => ({
          ...m,
          contextWindow: MODEL_CONTEXT_WINDOWS[m.id] ?? null,
        }));
        return res
          .status(200)
          .json({ models: modelsWithContext, selectedModel });
      } catch {
        // Ollama unreachable — return the selected model so the UI is minimally functional
        const fallback = selectedModel
          ? [{ id: selectedModel, contextWindow: null }]
          : [];
        return res
          .status(200)
          .json({ models: fallback, selectedModel, fallback: true });
      }
    }

    try {
      const models = await withTimeout(
        copilot.listModels(),
        5000,
        "listModels",
      );
      const modelsWithContext = models.map((m) => ({
        ...m,
        contextWindow: MODEL_CONTEXT_WINDOWS[m.id] ?? null,
      }));
      return res.status(200).json({ models: modelsWithContext, selectedModel });
    } catch (error) {
      // SDK unavailable — return well-known fallback models so the UI is usable
      const modelsWithContext = FALLBACK_MODELS.map((m) => ({
        ...m,
        contextWindow: MODEL_CONTEXT_WINDOWS[m.id] ?? null,
      }));
      return res
        .status(200)
        .json({ models: modelsWithContext, selectedModel, fallback: true });
    }
  });

  router.post("/select", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const modelId = body.modelId;
    if (typeof modelId !== "string" || !modelId) {
      return res.status(400).json({ error: "modelId is required" });
    }

    try {
      const userConfig = await readUserConfig(configPath);
      userConfig.selectedModel = modelId;
      await writeUserConfig(configPath, userConfig);
      // Invalidate all cached sessions so subsequent messages use the new model.
      await copilot.clearAllSessions();
      return res.status(200).json({ ok: true, selectedModel: modelId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  return router;
};
