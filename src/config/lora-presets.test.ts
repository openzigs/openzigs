import { describe, it, expect, beforeEach } from "vitest";
import {
  loadLoraPresets,
  _resetLoraPresetsCache,
} from "./lora-presets.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadLoraPresets (WS3-D #933)", () => {
  beforeEach(() => {
    _resetLoraPresetsCache();
  });

  it("loads bundled config/lora-presets.json from project root by default", () => {
    const presets = loadLoraPresets();
    expect(presets.presets.sdxl).toBeDefined();
    expect(presets.presets.sdxl.rank).toBe(16);
    expect(presets.presets.sdxl.loraAlpha).toBe(32);
  });

  it("returns SDXL/FLUX/SD15 entries with industry-default alpha = 2*rank", () => {
    const { presets } = loadLoraPresets();
    for (const key of ["sdxl", "flux-dev", "flux-schnell", "sd15"]) {
      const p = presets[key];
      expect(p).toBeDefined();
      expect(p.loraAlpha).toBe(2 * p.rank);
      expect(p.baseModel).toBe(key);
    }
  });

  it("caches the parsed result across calls", () => {
    const a = loadLoraPresets();
    const b = loadLoraPresets();
    expect(a).toBe(b);
  });

  it("falls back to built-in presets when file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openzigs-lora-"));
    try {
      const presets = loadLoraPresets(dir);
      expect(presets.presets.sdxl).toBeDefined();
      expect(presets.presets.sdxl.label).toMatch(/SDXL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to built-in presets when JSON is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "openzigs-lora-"));
    try {
      writeFileSync(join(dir, "lora-presets.json"), "{ not json", "utf-8");
      const presets = loadLoraPresets(dir);
      expect(presets.presets.sdxl).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back when JSON is valid but missing 'presets' key", () => {
    const dir = mkdtempSync(join(tmpdir(), "openzigs-lora-"));
    try {
      writeFileSync(join(dir, "lora-presets.json"), JSON.stringify({}), "utf-8");
      const presets = loadLoraPresets(dir);
      expect(presets.presets.sdxl).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads custom presets from a user-provided directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "openzigs-lora-"));
    try {
      writeFileSync(
        join(dir, "lora-presets.json"),
        JSON.stringify({
          presets: {
            custom: {
              label: "Custom",
              description: "user override",
              baseModel: "sdxl",
              rank: 32,
              loraAlpha: 64,
              learningRate: 5e-5,
              steps: 1500,
              batchSize: 2,
              gradientAccumulationSteps: 2,
              mixedPrecision: "bf16",
              resolution: 1024,
            },
          },
        }),
        "utf-8",
      );
      const presets = loadLoraPresets(dir);
      expect(presets.presets.custom).toBeDefined();
      expect(presets.presets.custom.rank).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
