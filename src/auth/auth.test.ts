import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import type { AddressInfo } from "node:net";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-auth-"));
};

const startServer = async (configPath: string) => {
  const app = await createApp({ configPath });
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
};

describe("auth middleware", () => {
  const cleanupDirs: string[] = [];
  let configPath = "";

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanupDirs.push(dir);
    configPath = path.join(dir, "config.json");
  });

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("generates a local token on first run", async () => {
    const config = await loadConfig({ configPath });
    expect(config.auth.token).toMatch(/^[a-f0-9]{64}$/i);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { auth?: { token?: string } };
    expect(parsed.auth?.token).toBe(config.auth.token);
  });

  it("rejects requests without auth header", async () => {
    const { server, baseUrl } = await startServer(configPath);

    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(401);

    server.close();
  });

  it("accepts valid bearer token", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = await startServer(configPath);

    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${config.auth.token}` }
    });
    expect(response.status).toBe(200);

    server.close();
  });

  it("blocks viewer role from admin endpoints", async () => {
    await loadConfig({ configPath });
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.auth = {
      ...(parsed.auth as Record<string, unknown>),
      role: "viewer"
    };
    await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), "utf-8");

    const config = await loadConfig({ configPath });
    const { server, baseUrl } = await startServer(configPath);

    const response = await fetch(`${baseUrl}/api/tools/test/toggle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.auth.token}` }
    });

    expect(response.status).toBe(403);
    server.close();
  });

  it("rate limits repeated failed auth attempts", async () => {
    const { server, baseUrl } = await startServer(configPath);

    let status = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/health`);
      status = response.status;
    }

    expect(status).toBe(429);
    server.close();
  });
});
