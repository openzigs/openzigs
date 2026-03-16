/**
 * Shared utility for reading the user's selected LLM model from config/user.json.
 * All copilot.chat() call sites should use this to respect the user's admin selection
 * instead of falling back to the hardcoded default (gpt-4.1).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../project-root.js";

const defaultUserConfigPath = () => path.resolve(PROJECT_ROOT, "config", "user.json");

/**
 * Read the user's selected model from config/user.json.
 * Returns undefined if no model is selected or file doesn't exist.
 */
export async function getUserSelectedModel(configPath?: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(configPath ?? defaultUserConfigPath(), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    return typeof config.selectedModel === "string" ? config.selectedModel : undefined;
  } catch {
    return undefined;
  }
}
