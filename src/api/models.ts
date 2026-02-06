import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

export type ModelsRouterOptions = {
  copilot: CopilotWrapper;
  userConfigPath?: string;
};

const defaultUserConfigPath = () => path.resolve(process.cwd(), "config", "user.json");

const readUserConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeUserConfig = async (configPath: string, data: Record<string, unknown>) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), "utf-8");
};

export const createModelsRouter = ({ copilot, userConfigPath }: ModelsRouterOptions): Router => {
  const router = Router();
  const configPath = userConfigPath ?? defaultUserConfigPath();

  router.get("/", async (_req, res) => {
    try {
      const models = await copilot.listModels();
      const userConfig = await readUserConfig(configPath);
      const selectedModel = typeof userConfig.selectedModel === "string" ? userConfig.selectedModel : null;
      return res.status(200).json({ models, selectedModel });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
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
      return res.status(200).json({ ok: true, selectedModel: modelId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  return router;
};
