import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createAdminRouter } from "./admin.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { CopilotModel, ReasoningEffort, ProviderConfig } from "../copilot/copilot-wrapper.js";

class FakeCopilot implements CopilotWrapper {
  private reasoningEffort?: ReasoningEffort;
  private provider?: ProviderConfig;
  private workingDirectory?: string;
  private maxTools = 30;

  async authenticate() { return { verificationUri: "", userCode: "" }; }
  async waitForAuth(): Promise<void> {}
  async isAuthenticated(): Promise<boolean> { return true; }
  async *chat(): AsyncGenerator<string> { yield "hi"; }
  async listModels(): Promise<CopilotModel[]> { return [{ id: "gpt-4.1" }]; }
  async onToolCall(): Promise<void> {}
  setMaxToolsPerRequest(n: number): void { this.maxTools = n; }
  getMaxToolsPerRequest(): number { return this.maxTools; }
  async destroySession(): Promise<void> {}
  hasSession(): boolean { return false; }
  async clearAllSessions(): Promise<void> {}

  getReasoningEffort(): ReasoningEffort | undefined { return this.reasoningEffort; }
  setReasoningEffort(effort: ReasoningEffort | undefined): void { this.reasoningEffort = effort; }
  getProvider(): ProviderConfig | undefined { return this.provider; }
  setProvider(provider: ProviderConfig | undefined): void { this.provider = provider; }
  getWorkingDirectory(): string | undefined { return this.workingDirectory; }
  setWorkingDirectory(dir: string | undefined): void { this.workingDirectory = dir; }
}

describe("Admin Models Config API", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const createApp = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-admin-models-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "config.json");

    // Point the admin router's config path at our temp dir
    process.env.OPENZIGS_CONFIG_PATH = configPath;

    const toolRegistry = new ToolRegistry({
      statePath: path.join(tmpDir, "tools.json"),
    });
    const copilot = new FakeCopilot();
    const router = createAdminRouter({ toolRegistry, copilot });

    const app = express();
    app.use(express.json());
    app.use("/api/admin", router);

    return { app, copilot, configPath };
  };

  it("GET /api/admin/models/config returns defaults", async () => {
    const { app } = await createApp();

    const res = await request(app).get("/api/admin/models/config");
    expect(res.status).toBe(200);
    expect(res.body.reasoningEffort).toBe("medium");
    expect(res.body.provider).toBeNull();
    expect(res.body.workingDirectory).toBeNull();
  });

  it("PUT /api/admin/models/config updates reasoning effort", async () => {
    const { app, copilot } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ reasoningEffort: "high" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reasoningEffort).toBe("high");
    expect(copilot.getReasoningEffort()).toBe("high");
  });

  it("PUT /api/admin/models/config updates working directory", async () => {
    const { app, copilot } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ workingDirectory: "/home/user/project" });

    expect(res.status).toBe(200);
    expect(res.body.workingDirectory).toBe("/home/user/project");
    expect(copilot.getWorkingDirectory()).toBe("/home/user/project");
  });

  it("PUT /api/admin/models/config sets provider", async () => {
    const { app, copilot } = await createApp();

    const provider = {
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-123",
    };

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ provider });

    expect(res.status).toBe(200);
    expect(res.body.provider).toEqual(provider);
    expect(copilot.getProvider()).toEqual(provider);
  });

  it("PUT /api/admin/models/config clears provider with null", async () => {
    const { app, copilot } = await createApp();

    // Set first
    await request(app)
      .put("/api/admin/models/config")
      .send({ provider: { type: "ollama", baseUrl: "http://localhost:11434" } });

    expect(copilot.getProvider()).toBeDefined();

    // Clear with null
    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ provider: null });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBeNull();
    expect(copilot.getProvider()).toBeUndefined();
  });

  it("PUT /api/admin/models/config persists to user config file", async () => {
    const { app, configPath } = await createApp();

    await request(app)
      .put("/api/admin/models/config")
      .send({ reasoningEffort: "xhigh", workingDirectory: "/tmp/work" });

    const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(saved.copilot.defaultReasoningEffort).toBe("xhigh");
    expect(saved.copilot.defaultWorkingDirectory).toBe("/tmp/work");
  });

  it("PUT /api/admin/models/config rejects invalid reasoning effort", async () => {
    const { app } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ reasoningEffort: "ultra" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reasoningEffort");
  });

  it("PUT /api/admin/models/config rejects provider without baseUrl", async () => {
    const { app } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ provider: { type: "openai" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("baseUrl");
  });

  it("PUT /api/admin/models/config rejects invalid provider type", async () => {
    const { app } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ provider: { type: "invalid", baseUrl: "http://localhost" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("provider.type");
  });

  it("PUT /api/admin/models/config rejects non-string workingDirectory", async () => {
    const { app } = await createApp();

    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ workingDirectory: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workingDirectory");
  });

  it("PUT /api/admin/models/config accepts null reasoning effort to reset", async () => {
    const { app, copilot } = await createApp();

    // Set first
    await request(app)
      .put("/api/admin/models/config")
      .send({ reasoningEffort: "high" });

    expect(copilot.getReasoningEffort()).toBe("high");

    // Reset with null
    const res = await request(app)
      .put("/api/admin/models/config")
      .send({ reasoningEffort: null });

    expect(res.status).toBe(200);
    expect(copilot.getReasoningEffort()).toBeUndefined();
  });
});
