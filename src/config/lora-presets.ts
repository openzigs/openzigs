/**
 * WS3-D (#933) — LoRA training preset loader.
 *
 * Reads `config/lora-presets.json` (the bundled defaults) once and exposes
 * a typed accessor for the admin API and the UI training panel. Per-character
 * overrides happen in the request body of `POST /api/admin/characters/:id/train`,
 * so this loader is read-only at runtime — edit the JSON file and restart to
 * change defaults.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logging/logger.js";

export interface LoraPreset {
  label: string;
  description: string;
  baseModel: "sdxl" | "flux-dev" | "flux-schnell" | "sd15";
  rank: number;
  loraAlpha: number;
  learningRate: number;
  steps: number;
  batchSize: number;
  gradientAccumulationSteps: number;
  mixedPrecision: "fp16" | "bf16" | "no";
  resolution: number;
}

export interface LoraPresets {
  presets: Record<string, LoraPreset>;
}

const FALLBACK_PRESETS: LoraPresets = {
  presets: {
    sdxl: {
      label: "SDXL 1.0",
      description: "Built-in fallback (config/lora-presets.json missing).",
      baseModel: "sdxl",
      rank: 16,
      loraAlpha: 32,
      learningRate: 1e-4,
      steps: 700,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      mixedPrecision: "fp16",
      resolution: 1024,
    },
  },
};

let cached: LoraPresets | null = null;

/**
 * Load LoRA presets from `config/lora-presets.json`. Resolves the path
 * relative to the project root (`process.cwd()`). Returns the cached value
 * after the first call.
 */
export function loadLoraPresets(configDir?: string): LoraPresets {
  if (cached) return cached;
  const dir = configDir ?? resolve(process.cwd(), "config");
  const file = resolve(dir, "lora-presets.json");
  if (!existsSync(file)) {
    logger.warn(
      `[LoRAPresets] ${file} not found — using built-in fallback presets.`,
    );
    cached = FALLBACK_PRESETS;
    return cached;
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as LoraPresets;
    if (!parsed.presets || typeof parsed.presets !== "object") {
      throw new Error("missing 'presets' object");
    }
    cached = parsed;
    return cached;
  } catch (err) {
    logger.error(
      `[LoRAPresets] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)} — falling back to built-ins.`,
    );
    cached = FALLBACK_PRESETS;
    return cached;
  }
}

/** Test helper: clear the in-process cache so the next load reads disk again. */
export function _resetLoraPresetsCache(): void {
  cached = null;
}
