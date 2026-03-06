import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getUserSelectedModel } from "./user-model.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("getUserSelectedModel", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "user-model-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the selectedModel from config", async () => {
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(configPath, JSON.stringify({ selectedModel: "gpt-5" }));

    const result = await getUserSelectedModel(configPath);
    expect(result).toBe("gpt-5");
  });

  it("returns undefined when file does not exist", async () => {
    const result = await getUserSelectedModel(path.join(tmpDir, "missing.json"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when selectedModel is not a string", async () => {
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(configPath, JSON.stringify({ selectedModel: 42 }));

    const result = await getUserSelectedModel(configPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined when selectedModel is absent", async () => {
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(configPath, JSON.stringify({ someOther: "field" }));

    const result = await getUserSelectedModel(configPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", async () => {
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(configPath, "not json at all");

    const result = await getUserSelectedModel(configPath);
    expect(result).toBeUndefined();
  });

  it("returns the correct model when config has extra fields", async () => {
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ selectedModel: "claude-sonnet-4", theme: "dark", lang: "en" }),
    );

    const result = await getUserSelectedModel(configPath);
    expect(result).toBe("claude-sonnet-4");
  });
});
