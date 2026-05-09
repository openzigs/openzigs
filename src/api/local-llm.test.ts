import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { createLocalLlmRouter, ensureVllmApiKey } from "./local-llm.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpConfigPath: string;
const auditLogs: Array<{
  event: string;
  details: Record<string, unknown>;
  category: string;
  level: string;
}> = [];

const fakeAuditLogger = {
  log: vi.fn(async (entry) => {
    auditLogs.push({
      event: entry.event,
      details: entry.details ?? {},
      category: entry.category,
      level: entry.level,
    });
    return entry;
  }),
};

type RouterDeps = NonNullable<Parameters<typeof createLocalLlmRouter>[0]>;

const buildApp = (deps: RouterDeps = {}) => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/local-llm",
    createLocalLlmRouter({
      configPath: tmpConfigPath,
      auditLogger: fakeAuditLogger as unknown as RouterDeps["auditLogger"],
      ...deps,
    }),
  );
  return app;
};

describe("local-llm admin router", () => {
  beforeEach(async () => {
    auditLogs.length = 0;
    fakeAuditLogger.log.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-local-llm-"));
    tmpConfigPath = path.join(dir, "config.json");
  });

  describe("GET /autodetect", () => {
    it("returns autodetect result and audit-logs the event", async () => {
      const fetchImpl = vi.fn(async (url) => {
        if (String(url).includes("11434")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "gemma4:26b" }] }),
          } as unknown as Response;
        }
        throw new Error("refused");
      });
      const app = buildApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const r = await request(app).get("/api/admin/local-llm/autodetect");
      expect(r.status).toBe(200);
      expect(r.body.ollama?.endpoint).toBe("http://127.0.0.1:11434/v1");
      expect(auditLogs.some((l) => l.event === "provider.autodetected")).toBe(
        true,
      );
    });

    it("returns skipped:true when localLlm.autodetect is false", async () => {
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({ localLlm: { autodetect: false } }),
        "utf-8",
      );
      const fetchImpl = vi.fn();
      const app = buildApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const r = await request(app).get("/api/admin/local-llm/autodetect");
      expect(r.status).toBe(200);
      expect(r.body.skipped).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("GET /status", () => {
    it("returns null provider and disabled health when no config", async () => {
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/status");
      expect(r.status).toBe(200);
      expect(r.body.provider).toBeNull();
      expect(r.body.privacyMode.globalLockdown).toBe(false);
      expect(r.body.health.status).toBe("disabled");
    });

    it("masks vLLM API key in status response", async () => {
      const apiKey = randomBytes(32).toString("base64url");
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({ localLlm: { vllmApiKey: apiKey } }),
        "utf-8",
      );
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/status");
      expect(r.body.vllmKey.present).toBe(true);
      expect(r.body.vllmKey.masked).toMatch(/^.{4}.{1}.{4}$/);
      expect(r.body.vllmKey.masked).not.toContain(apiKey);
    });

    it("returns provider with hasApiKey flag (key not exposed)", async () => {
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({
          localLlm: {
            provider: {
              type: "local-copilot",
              endpoint: "http://127.0.0.1:11434/v1",
              model: "gemma4:26b",
              apiKey: "secret-leak",
              timeoutMs: 120000,
            },
          },
        }),
        "utf-8",
      );
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/status");
      expect(r.body.provider.hasApiKey).toBe(true);
      expect(r.body.provider.apiKey).toBeUndefined();
    });

    it("uses healthMonitor state when provided", async () => {
      const app = buildApp({
        healthMonitor: {
          getState: () => ({
            status: "healthy",
            lastProbeAt: "2026-05-08T12:00:00Z",
            consecutiveFailures: 0,
            consecutiveSuccesses: 10,
            failoverActive: false,
          }),
        },
      });
      const r = await request(app).get("/api/admin/local-llm/status");
      expect(r.body.health.status).toBe("healthy");
      expect(r.body.health.consecutiveSuccesses).toBe(10);
    });
  });

  describe("POST /provider", () => {
    it("persists provider and audit-logs registration", async () => {
      const app = buildApp();
      const provider = {
        type: "local-copilot",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "gemma4:26b",
        apiKey: "sekret-token",
        timeoutMs: 60000,
      };
      const r = await request(app)
        .post("/api/admin/local-llm/provider")
        .send(provider);
      expect(r.status).toBe(200);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.provider.endpoint).toBe(provider.endpoint);
      expect(onDisk.localLlm.provider.apiKey).toBe(provider.apiKey);
      const reg = auditLogs.find((l) => l.event === "provider.registered");
      expect(reg).toBeDefined();
      expect(reg?.details.endpoint).toBe(provider.endpoint);
      // apiKey is not included in the audit details payload at all.
      expect(JSON.stringify(reg?.details)).not.toContain("sekret-token");
    });

    it("rejects malformed provider with 400", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/provider")
        .send({ type: "local-copilot", model: "gemma4:26b" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_provider");
    });

    it("rejects invalid endpoint URL", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/provider")
        .send({
          type: "local-copilot",
          endpoint: "not-a-url",
          model: "gemma4:26b",
        });
      expect(r.status).toBe(400);
    });

    // Bug #1064-#9: the offline setup wizard sends `{baseUrl, modelId}` rather
    // than `{endpoint, model}`. The router must accept both shapes.
    it("accepts wizard-shaped {baseUrl, modelId} body", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/provider")
        .send({
          type: "local-copilot",
          baseUrl: "http://127.0.0.1:11434",
          modelId: "gemma4:26b",
        });
      expect(r.status).toBe(200);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      // baseUrl gets a /v1 suffix appended when persisted.
      expect(onDisk.localLlm.provider.endpoint).toBe(
        "http://127.0.0.1:11434/v1",
      );
      expect(onDisk.localLlm.provider.model).toBe("gemma4:26b");
    });
  });

  // Bug #1064-#2: wizard fetches autodetect via POST.
  describe("POST /autodetect", () => {
    it("returns the same shape as GET and triggers an audit log", async () => {
      const fetchImpl = vi.fn(async (url) => {
        if (String(url).includes("11434")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "gemma4:26b" }] }),
          } as unknown as Response;
        }
        throw new Error("refused");
      });
      const app = buildApp({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const r = await request(app)
        .post("/api/admin/local-llm/autodetect")
        .send({});
      expect(r.status).toBe(200);
      expect(r.body.ollama?.endpoint).toBe("http://127.0.0.1:11434/v1");
      // Wizard-friendly aliases.
      expect(r.body.ollama?.reachable).toBe(true);
      expect(r.body.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(r.body.vllm?.reachable).toBe(false);
      expect(auditLogs.some((l) => l.event === "provider.autodetected")).toBe(
        true,
      );
    });
  });

  // Bug #1064-#3: wizard probes GET /provider on mount.
  describe("GET /provider", () => {
    it("returns provider:null when nothing is configured", async () => {
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/provider");
      expect(r.status).toBe(200);
      expect(r.body.provider).toBeNull();
    });

    it("returns provider in {baseUrl, modelId} shape", async () => {
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({
          localLlm: {
            provider: {
              type: "local-copilot",
              endpoint: "http://127.0.0.1:11434/v1",
              model: "gemma4:26b",
            },
          },
        }),
        "utf-8",
      );
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/provider");
      expect(r.status).toBe(200);
      expect(r.body.provider).toEqual({
        type: "local-copilot",
        baseUrl: "http://127.0.0.1:11434",
        modelId: "gemma4:26b",
      });
    });
  });

  describe("DELETE /provider", () => {
    it("clears the provider and audit-logs", async () => {
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({
          localLlm: {
            provider: {
              type: "local-copilot",
              endpoint: "http://127.0.0.1:11434/v1",
              model: "gemma4:26b",
            },
          },
        }),
        "utf-8",
      );
      const app = buildApp();
      const r = await request(app).delete("/api/admin/local-llm/provider");
      expect(r.status).toBe(200);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.provider).toBeNull();
      expect(auditLogs.some((l) => l.event === "provider.cleared")).toBe(true);
    });
  });

  describe("POST /privacy/global", () => {
    it("enables global lockdown and audit-logs as security category", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/privacy/global")
        .send({ globalLockdown: true });
      expect(r.status).toBe(200);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.privacyMode.globalLockdown).toBe(true);
      const log = auditLogs.find(
        (l) => l.event === "privacy.global_lockdown_enabled",
      );
      expect(log?.category).toBe("security");
      expect(log?.level).toBe("security");
    });

    it("disables and audits the disable event", async () => {
      const app = buildApp();
      await request(app)
        .post("/api/admin/local-llm/privacy/global")
        .send({ globalLockdown: true });
      const r = await request(app)
        .post("/api/admin/local-llm/privacy/global")
        .send({ globalLockdown: false });
      expect(r.status).toBe(200);
      expect(
        auditLogs.some((l) => l.event === "privacy.global_lockdown_disabled"),
      ).toBe(true);
    });

    it("rejects non-boolean payload", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/privacy/global")
        .send({ globalLockdown: "yes" });
      expect(r.status).toBe(400);
    });
  });

  describe("vLLM API key", () => {
    it("rotate generates a new base64url key, persists, audit-logs", async () => {
      const app = buildApp();
      const r = await request(app).post("/api/admin/local-llm/vllm-key/rotate");
      expect(r.status).toBe(200);
      expect(r.body.apiKey).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset
      expect(r.body.apiKey.length).toBeGreaterThanOrEqual(32);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.vllmApiKey).toBe(r.body.apiKey);
      expect(
        auditLogs.some(
          (l) =>
            l.event === "vllm_api_key.rotated" && l.category === "security",
        ),
      ).toBe(true);
    });

    it("GET /vllm-key returns masked + present flag, never the plaintext", async () => {
      const apiKey = randomBytes(32).toString("base64url");
      await fs.writeFile(
        tmpConfigPath,
        JSON.stringify({ localLlm: { vllmApiKey: apiKey } }),
        "utf-8",
      );
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/vllm-key");
      expect(r.status).toBe(200);
      expect(r.body.present).toBe(true);
      expect(typeof r.body.masked).toBe("string");
      expect(JSON.stringify(r.body)).not.toContain(apiKey);
    });

    it("ensureVllmApiKey is idempotent (returns existing key, created=false)", async () => {
      const first = await ensureVllmApiKey(tmpConfigPath);
      expect(first.created).toBe(true);
      const second = await ensureVllmApiKey(tmpConfigPath);
      expect(second.created).toBe(false);
      expect(second.apiKey).toBe(first.apiKey);
    });

    it("ensureVllmApiKey creates a new key when missing", async () => {
      const result = await ensureVllmApiKey(tmpConfigPath);
      expect(result.created).toBe(true);
      expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]+$/);
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.vllmApiKey).toBe(result.apiKey);
    });
  });

  describe("smart router (POST /router)", () => {
    it("GET /router returns defaults when nothing on disk", async () => {
      const app = buildApp();
      const r = await request(app).get("/api/admin/local-llm/router");
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
      expect(r.body.cloudThresholdTokens).toBe(4096);
      expect(r.body.thresholdStops).toEqual([256, 1024, 4096, 8192]);
    });

    it("POST /router persists, fires runtime hook, audit-logs", async () => {
      const hookCalls: Array<{ enabled: boolean; cloudThresholdTokens: number }> =
        [];
      const app = buildApp({
        onSmartRouterChanged: (cfg) => hookCalls.push(cfg),
      });
      const r = await request(app)
        .post("/api/admin/local-llm/router")
        .send({ enabled: false, cloudThresholdTokens: 1024 });
      expect(r.status).toBe(200);
      expect(r.body.smartRouter).toEqual({
        enabled: false,
        cloudThresholdTokens: 1024,
      });
      const onDisk = JSON.parse(await fs.readFile(tmpConfigPath, "utf-8"));
      expect(onDisk.localLlm.smartRouter).toEqual({
        enabled: false,
        cloudThresholdTokens: 1024,
      });
      expect(hookCalls).toEqual([
        { enabled: false, cloudThresholdTokens: 1024 },
      ]);
      const log = auditLogs.find((l) => l.event === "router.config_changed");
      expect(log?.category).toBe("system");
      expect(log?.details).toMatchObject({
        enabled: false,
        cloudThresholdTokens: 1024,
      });
    });

    it("rejects out-of-spec threshold values", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/router")
        .send({ enabled: true, cloudThresholdTokens: 999 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_router_config");
    });

    it("rejects missing fields", async () => {
      const app = buildApp();
      const r = await request(app)
        .post("/api/admin/local-llm/router")
        .send({ enabled: true });
      expect(r.status).toBe(400);
    });
  });
});
