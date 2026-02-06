import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createApp } from "../app.js";
import { loadConfig, type AppConfig } from "../config/index.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-auth-"));
};

const closeServer = (server: Server) => {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const startServer = (config: AppConfig) => {
  const app = createApp(config);
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
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("accepts valid bearer token", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${config.auth.token}` }
      });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("blocks viewer role from admin endpoints", async () => {
    const initialConfig = await loadConfig({ configPath });
    const viewerConfig: AppConfig = {
      ...initialConfig,
      auth: {
        ...initialConfig.auth,
        role: "viewer"
      }
    };

    const { server, baseUrl } = startServer(viewerConfig);

    try {
      const response = await fetch(`${baseUrl}/api/tools/test/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${initialConfig.auth.token}` }
      });

      expect(response.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it("rate limits repeated failed auth attempts", async () => {
    const config = await loadConfig({ configPath });
    const { server, baseUrl } = startServer(config);

    try {
      let status = 0;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/health`);
        status = response.status;
      }

      expect(status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });
});
