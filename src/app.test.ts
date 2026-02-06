import { describe, expect, it, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { AuditLogger } from "./logging/audit-logger.js";
import { ApprovalQueue } from "./approvals/index.js";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-app-"));
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

const startServer = (app: ReturnType<typeof createApp>) => {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
};

describe("/api/logs", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("returns filtered audit logs", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const configPath = path.join(configDir, "config.json");

    const config = await loadConfig({ configPath });
    const auditLogger = new AuditLogger({ baseDir: logDir, clock: () => new Date("2026-02-03T10:00:00Z") });

    await auditLogger.log({
      level: "security",
      category: "tool",
      event: "shell_execute",
      details: { command: "ls" }
    });

    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);

    try {
      const response = await fetch(`${baseUrl}/api/logs?category=tool`, {
        headers: { Authorization: `Bearer ${config.auth.token}` }
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { entries: Array<{ category: string }> };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].category).toBe("tool");
    } finally {
      await closeServer(server);
    }
  });
});

describe("/api/approvals", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("lists pending approvals and records decisions", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const configPath = path.join(configDir, "config.json");

    const config = await loadConfig({ configPath });
    const auditLogger = new AuditLogger({ baseDir: logDir, clock: () => new Date("2026-02-03T10:00:00Z") });
    const approvalQueue = new ApprovalQueue({ auditLogger, timeoutMs: 1000 });

    const approvalPromise = approvalQueue.requestApproval({
      tool: "shell-execute",
      args: { command: "ls" },
      riskLevel: "high",
      explanation: "Test approval"
    });

    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);

    try {
      const listResponse = await fetch(`${baseUrl}/api/approvals`, {
        headers: { Authorization: `Bearer ${config.auth.token}` }
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as { approvals: Array<{ id: string }> };
      expect(listBody.approvals).toHaveLength(1);

      const approvalId = listBody.approvals[0].id;
      const decisionResponse = await fetch(`${baseUrl}/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.auth.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ approved: true, decidedBy: "tester", decidedVia: "web" })
      });
      expect(decisionResponse.status).toBe(200);

      const result = await approvalPromise;
      expect(result.status).toBe("approved");
    } finally {
      await closeServer(server);
    }
  });
});
