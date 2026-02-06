import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import * as z from "zod";
import { ToolRegistry, type ToolDefinition } from "../mcp/tool-registry.js";
import { CopilotWrapperService } from "./copilot-wrapper.js";

class FakeSession {
  private handlers = new Map<string, Array<(event: { data?: { deltaContent?: string } }) => void>>();

  on(event: string, handler: (event: { data?: { deltaContent?: string } }) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async sendAndWait({ prompt }: { prompt: string }) {
    if (!prompt) {
      throw new Error("Missing prompt");
    }
    this.emit("assistant.message_delta", { data: { deltaContent: "hello" } });
    this.emit("session.idle", {});
  }

  private emit(event: string, payload: { data?: { deltaContent?: string } }) {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }
}

class FakeCopilotClient {
  public lastSessionConfig: { tools?: unknown[]; model?: string } | null = null;

  async start() {
    return undefined;
  }

  async createSession(config: { tools?: unknown[]; model?: string }) {
    this.lastSessionConfig = config;
    return new FakeSession();
  }

  async stop() {
    return [] as Error[];
  }

  async startDeviceAuth() {
    return { verificationUri: "https://github.com/login/device", userCode: "ABCD-1234" };
  }

  async waitForAuth() {
    return { token: "token-123", expiresAt: Date.now() + 60_000 };
  }

  async listModels() {
    return [{ id: "gpt-4.1" }, { id: "claude-sonnet-4" }];
  }
}

const buildTool = (name: string): ToolDefinition => {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    zodSchema: z.object({}),
    category: "filesystem",
    riskLevel: "low",
    handler: async () => ({ text: "ok" })
  };
};

describe("copilot wrapper", () => {
  it("persists auth token with restricted permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-auth-"));
    const authPath = path.join(tmpDir, "auth.json");
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({
      client,
      authPath,
      clientId: "client-id"
    });

    const authInfo = await wrapper.authenticate();
    expect(authInfo.verificationUri).toContain("github.com");
    expect(authInfo.userCode.length).toBeGreaterThanOrEqual(8);

    await wrapper.waitForAuth();
    const saved = JSON.parse(await fs.readFile(authPath, "utf-8")) as { token: string };
    expect(saved.token).toBe("token-123");

    const stat = await fs.stat(authPath);
    expect(stat.mode & 0o077).toBe(0);
    expect(await wrapper.isAuthenticated()).toBe(true);
  });

  it("streams chat output and passes tools to the SDK", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-test-"));
    const registry = new ToolRegistry({
      statePath: path.join(tmpDir, "tool-registry.json"),
      defaultEnabledTools: ["read-file"]
    });
    registry.registerTool(buildTool("read-file"));

    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({
      client,
      toolRegistry: registry
    });

    const chunks: string[] = [];
    for await (const chunk of wrapper.chat("Hello")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("hello");
    expect(client.lastSessionConfig?.tools?.length).toBe(1);
  });

  it("passes model override to createSession", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    const chunks: string[] = [];
    for await (const chunk of wrapper.chat("Hello", undefined, "claude-sonnet-4")) {
      chunks.push(chunk);
    }

    expect(client.lastSessionConfig?.model).toBe("claude-sonnet-4");
  });

  it("uses default model when no override is provided", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client, model: "gpt-4.1" });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of wrapper.chat("Hello")) {
      // drain
    }

    expect(client.lastSessionConfig?.model).toBe("gpt-4.1");
  });

  it("lists available models from the client", async () => {
    const client = new FakeCopilotClient();
    const wrapper = new CopilotWrapperService({ client });

    const models = await wrapper.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4.1");
    expect(models[1].id).toBe("claude-sonnet-4");
  });

  it("returns fallback model when client has no listModels", async () => {
    const client = {
      async start() { return undefined; },
      async createSession(config: { tools?: unknown[]; model?: string }) {
        return new FakeSession();
      },
      async stop() { return [] as Error[]; }
    };
    const wrapper = new CopilotWrapperService({ client, model: "gpt-4.1" });

    const models = await wrapper.listModels();
    expect(models).toEqual([{ id: "gpt-4.1" }]);
  });
});
