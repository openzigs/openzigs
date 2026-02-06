import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { createModelsRouter } from "./models.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { CopilotModel } from "../copilot/copilot-wrapper.js";

class FakeCopilot implements CopilotWrapper {
  models: CopilotModel[];

  constructor(models: CopilotModel[] = [{ id: "gpt-4.1" }, { id: "claude-sonnet-4" }]) {
    this.models = models;
  }

  async authenticate() {
    return { verificationUri: "", userCode: "" };
  }

  async waitForAuth(): Promise<void> {}

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  async *chat(): AsyncGenerator<string> {
    yield "hi";
  }

  async listModels(): Promise<CopilotModel[]> {
    return this.models;
  }

  async onToolCall(): Promise<void> {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonFetch = async (url: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init
  });
  const body = await res.json();
  return { status: res.status, body };
};

describe("Models API", () => {
  const cleanupDirs: string[] = [];
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    for (const s of servers.splice(0)) {
      s.close();
    }
  });

  const startApp = async (copilot: CopilotWrapper, userConfigPath: string): Promise<string> => {
    const app = express();
    app.use(express.json());
    app.use("/api/models", createModelsRouter({ copilot, userConfigPath }));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  };

  it("GET /api/models returns model list", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-models-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "user.json");

    const copilot = new FakeCopilot();
    const base = await startApp(copilot, configPath);

    const { status, body } = await jsonFetch(`${base}/api/models`);
    expect(status).toBe(200);
    expect(body.models).toHaveLength(2);
    expect(body.models[0].id).toBe("gpt-4.1");
    expect(body.selectedModel).toBeNull();
  });

  it("POST /api/models/select persists selection", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-models-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "user.json");

    const copilot = new FakeCopilot();
    const base = await startApp(copilot, configPath);

    const { status: selectStatus, body: selectBody } = await jsonFetch(`${base}/api/models/select`, {
      method: "POST",
      body: JSON.stringify({ modelId: "claude-sonnet-4" })
    });
    expect(selectStatus).toBe(200);
    expect(selectBody.selectedModel).toBe("claude-sonnet-4");

    // Verify it persisted
    const { body: getBody } = await jsonFetch(`${base}/api/models`);
    expect(getBody.selectedModel).toBe("claude-sonnet-4");

    // Verify file was written
    const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(saved.selectedModel).toBe("claude-sonnet-4");
  });

  it("POST /api/models/select rejects missing modelId", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-models-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "user.json");

    const copilot = new FakeCopilot();
    const base = await startApp(copilot, configPath);

    const { status, body } = await jsonFetch(`${base}/api/models/select`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(status).toBe(400);
    expect(body.error).toBe("modelId is required");
  });

  it("GET /api/models returns selectedModel from existing config", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-models-"));
    cleanupDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "user.json");
    await fs.writeFile(configPath, JSON.stringify({ selectedModel: "gpt-4.1" }));

    const copilot = new FakeCopilot();
    const base = await startApp(copilot, configPath);

    const { body } = await jsonFetch(`${base}/api/models`);
    expect(body.selectedModel).toBe("gpt-4.1");
  });
});
