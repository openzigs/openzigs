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
import { ToolRegistry } from "./mcp/tool-registry.js";
import { registerToolCatalog } from "./mcp/tool-catalog.js";

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

const createToolRegistry = async () => {
  const registryDir = await createTempDir();
  const statePath = path.join(registryDir, "tools.json");
  const registry = new ToolRegistry({ statePath });
  registerToolCatalog(registry);
  return { registry, registryDir };
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

describe("/api/tools", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("lists tools and toggles enablement", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const { registry, registryDir } = await createToolRegistry();
    cleanupDirs.push(registryDir);

    const configPath = path.join(configDir, "config.json");
    const config = await loadConfig({ configPath });
    const auditLogger = new AuditLogger({ baseDir: logDir, clock: () => new Date("2026-02-03T10:00:00Z") });

    const app = createApp(config, { auditLogger, toolRegistry: registry });
    const { server, baseUrl } = startServer(app);

    try {
      const listResponse = await fetch(`${baseUrl}/api/tools`, {
        headers: { Authorization: `Bearer ${config.auth.token}` }
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as { tools: Record<string, Array<{ name: string }>> };
      expect(listBody.tools.filesystem.map((tool) => tool.name)).toContain("read-file");

      const toggleResponse = await fetch(`${baseUrl}/api/tools/write-file/toggle`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.auth.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ enabled: true })
      });
      expect(toggleResponse.status).toBe(200);
      expect(registry.isEnabled("write-file")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});

describe("/health endpoints", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 200 on /health without auth", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });

  it("returns 200 on /api/health with auth", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});

describe("/api/tools - no registry", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 503 on GET /api/tools without registry", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tools`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(503);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 503 on POST toggle without registry", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tools/x/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(503);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for invalid toggle body", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const { registry, registryDir } = await createToolRegistry();
    cleanupDirs.push(registryDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config, { toolRegistry: registry });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tools/write-file/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "not-boolean" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

describe("/api/approvals edge cases", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 for invalid status filter", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/approvals?status=invalid`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns approvals with status=all", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/approvals?status=all`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { approvals: unknown[] };
      expect(body.approvals).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for non-boolean approved flag", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/approvals/some-id/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: "yes" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 when approval not found", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/approvals/nonexistent/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 409 when approval already decided", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger, timeoutMs: 5000 });
    void approvalQueue.requestApproval({ tool: "test", args: {}, riskLevel: "medium", explanation: "test" });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const list = await fetch(`${baseUrl}/api/approvals`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      const items = ((await list.json()) as { approvals: Array<{ id: string }> }).approvals;
      const id = items[0].id;
      await fetch(`${baseUrl}/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      const res = await fetch(`${baseUrl}/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false }),
      });
      expect(res.status).toBe(409);
    } finally {
      await closeServer(server);
    }
  });
});

describe("/api/logs edge cases", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 for invalid level", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs?level=INVALID`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for invalid since date", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs?since=not-a-date`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for invalid until date", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs?until=not-a-date`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("respects limit parameter", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const clock = () => new Date("2026-02-03T10:00:00Z");
    const auditLogger = new AuditLogger({ baseDir: logDir, clock });
    for (let i = 0; i < 5; i++) {
      await auditLogger.log({ level: "info", category: "system", event: `event-${i}`, details: {} });
    }
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs?limit=2`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: unknown[] };
      expect(body.entries.length).toBeLessThanOrEqual(2);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Prompts API ──

describe("/api/prompts", () => {
  const cleanupDirs: string[] = [];
  const cleanupDbs: Array<{ close(): void }> = [];
  afterEach(async () => {
    for (const db of cleanupDbs.splice(0)) {
      try { db.close(); } catch { /* ignore */ }
    }
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const setupWithPromptManager = async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const { PromptManager } = await import("./productivity/prompt-manager.js");
    const dbDir = await createTempDir();
    cleanupDirs.push(dbDir);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(dbDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        template TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const promptManager = new PromptManager({ db });
    cleanupDbs.push(db);
    const app = createApp(config, { promptManager });
    const { server, baseUrl } = startServer(app);
    return { server, baseUrl, config, promptManager };
  };

  it("creates and lists prompts", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const createRes = await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-prompt", template: "Hello {{name}}" }),
      });
      expect(createRes.status).toBe(201);

      const listRes = await fetch(`${baseUrl}/api/prompts`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { prompts: Array<{ name: string }> };
      expect(body.prompts.some((p) => p.name === "test-prompt")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for missing name or template", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const res = await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for excessively long template", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const res = await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "big", template: "x".repeat(100_001) }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 for non-existent prompt GET", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const res = await fetch(`${baseUrl}/api/prompts/nonexistent`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("updates a prompt", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const createRes = await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "updatable", template: "v1" }),
      });
      const created = (await createRes.json()) as { id: string };

      const updateRes = await fetch(`${baseUrl}/api/prompts/${created.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ template: "v2" }),
      });
      expect(updateRes.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("deletes a prompt", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const createRes = await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deletable", template: "bye" }),
      });
      const created = (await createRes.json()) as { id: string };

      const delRes = await fetch(`${baseUrl}/api/prompts/${created.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(delRes.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 for deleting non-existent prompt", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      const res = await fetch(`${baseUrl}/api/prompts/missing`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("searches prompts with query parameter", async () => {
    const { server, baseUrl, config } = await setupWithPromptManager();
    try {
      await fetch(`${baseUrl}/api/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "search-target", template: "findme" }),
      });

      const res = await fetch(`${baseUrl}/api/prompts?query=search-target`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompts: Array<{ name: string }> };
      expect(body.prompts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Chat Upload ──

describe("/api/chat/upload", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 when no files uploaded", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/chat/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Auth and 401 ──

describe("auth middleware", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 401 for missing auth token on protected routes", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs`);
      expect(res.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 401 for invalid auth token", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config);
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Invalid decidedVia ──

describe("/api/approvals decision edge cases", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 for invalid decidedVia channel", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const approvalQueue = new ApprovalQueue({ auditLogger, timeoutMs: 5000 });
    void approvalQueue.requestApproval({ tool: "test", args: {}, riskLevel: "medium", explanation: "t" });
    const app = createApp(config, { auditLogger, approvalQueue });
    const { server, baseUrl } = startServer(app);
    try {
      const list = await fetch(`${baseUrl}/api/approvals`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      const items = ((await list.json()) as { approvals: Array<{ id: string }> }).approvals;
      const res = await fetch(`${baseUrl}/api/approvals/${items[0].id}/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, decidedVia: "invalid-channel" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Logs with valid category ──

describe("/api/logs valid filters", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 for invalid category", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/logs?category=BOGUS`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("returns logs with valid since and until params", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir, clock: () => new Date("2026-02-03T10:00:00Z") });
    await auditLogger.log({ level: "info", category: "system", event: "test", details: {} });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(
        `${baseUrl}/api/logs?since=2026-02-03T00:00:00Z&until=2026-02-04T00:00:00Z`,
        { headers: { Authorization: `Bearer ${config.auth.token}` } },
      );
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("returns empty entries with very narrow time window", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const logDir = await createTempDir();
    cleanupDirs.push(logDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const auditLogger = new AuditLogger({ baseDir: logDir, clock: () => new Date("2026-02-03T10:00:00Z") });
    await auditLogger.log({ level: "info", category: "system", event: "test", details: {} });
    const app = createApp(config, { auditLogger });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(
        `${baseUrl}/api/logs?since=2020-01-01T00:00:00Z&until=2020-01-01T00:00:01Z`,
        { headers: { Authorization: `Bearer ${config.auth.token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: unknown[] };
      expect(body.entries).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: tool toggle error (unknown tool) ──

describe("/api/tools toggle error", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("returns 400 when toggling an unknown tool", async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const { registry, registryDir } = await createToolRegistry();
    cleanupDirs.push(registryDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const app = createApp(config, { toolRegistry: registry });
    const { server, baseUrl } = startServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tools/nonexistent-tool-xyz/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

// ── New tests: Scheduled Jobs API ──

describe("/api/jobs", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const setupWithScheduler = async () => {
    const configDir = await createTempDir();
    cleanupDirs.push(configDir);
    const config = await loadConfig({ configPath: path.join(configDir, "config.json") });
    const { Scheduler } = await import("./productivity/scheduler.js");
    const { createTestDatabase } = await import("./productivity/database.js");
    const db = createTestDatabase();
    const scheduler = new Scheduler({
      db,
      clock: () => new Date("2026-03-01T12:00:00Z"),
      auditLogDir: path.join(configDir, "audit"),
    });
    const app = createApp(config, { scheduler });
    const { server, baseUrl } = startServer(app);
    return { server, baseUrl, config, scheduler, db };
  };

  it("lists jobs (empty initially)", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: unknown[] };
      expect(body.jobs).toEqual([]);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("creates a job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-job", cronExpression: "0 9 * * *", actionPayload: {} }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { name: string; enabled: boolean };
      expect(body.name).toBe("test-job");
      expect(body.enabled).toBe(true);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("returns 400 for invalid cron expression", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad", cronExpression: "not-cron", actionPayload: {} }),
      });
      expect(res.status).toBe(400);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("gets a job by id", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fetch-me", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("fetch-me");
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("returns 404 for non-existent job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const res = await fetch(`${baseUrl}/api/jobs/nonexistent`, {
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("patches a job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "patch-me", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "patched" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("patched");
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("returns 400 for invalid cron on patch", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-patch", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression: "invalid" }),
      });
      expect(res.status).toBe(400);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("deletes a job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "delete-me", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("returns 404 for deleting non-existent job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const res = await fetch(`${baseUrl}/api/jobs/nonexistent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.auth.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("toggles a job", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "toggle-me", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean };
      expect(body.enabled).toBe(false);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });

  it("returns 400 for toggle without enabled boolean", async () => {
    const { server, baseUrl, config, scheduler } = await setupWithScheduler();
    try {
      const createRes = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-toggle", cronExpression: "0 0 * * *", actionPayload: {} }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/jobs/${created.id}/toggle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      scheduler.stopAll();
      await closeServer(server);
    }
  });
});
