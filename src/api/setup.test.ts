import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock file-permissions to no-op on all platforms during tests
vi.mock("../config/file-permissions.js", () => ({
  secureDirOptions: () => ({ recursive: true }),
  secureWriteOptions: () => ({ encoding: "utf-8" }),
  chmodSecureFile: async () => {},
}));

// Mock platform capabilities
vi.mock("../config/platform.js", () => ({
  getPlatformCapabilities: vi.fn().mockResolvedValue({
    os: "darwin",
    arch: "arm64",
    dockerAvailable: true,
    sidecarsSupported: true,
    chromePath: "/usr/bin/chromium",
    isWindows: false,
    isMacOS: true,
    isLinux: false,
  }),
}));

// Mock logger
vi.mock("../logging/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/index.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// Use a temporary directory for test file operations
const TEST_DIR = path.join(os.tmpdir(), `openzigs-setup-test-${Date.now()}`);

describe("Setup API", () => {
  let app: express.Express;

  beforeEach(async () => {
    // Clean up test directory
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });

    // Remove the setup-complete flag so tests start in "not-yet-setup" state.
    // The setup module reads the real ~/.openzigs/.setup-complete flag.
    const realSetupFlag = path.join(
      os.homedir(),
      ".openzigs",
      ".setup-complete",
    );
    await fs.unlink(realSetupFlag).catch(() => {});

    mockLoadConfig.mockResolvedValue({
      auth: {
        token: "test-secret-token",
        mode: "local",
        rateLimit: { windowMs: 60000, max: 10 },
      },
    });

    // Import fresh module with mocks
    const module = await import("./setup.js");
    app = express();
    app.use(express.json());
    app.use("/api/setup", module.default);
  });

  afterAll(async () => {
    // Restore the setup-complete flag that beforeEach removes, so running
    // tests doesn't leave the user's real OpenZigs install in "needs setup" state.
    const realSetupFlag = path.join(
      os.homedir(),
      ".openzigs",
      ".setup-complete",
    );
    await fs.writeFile(realSetupFlag, new Date().toISOString()).catch(() => {});
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("GET /api/setup/status returns setup state", async () => {
    const res = await request(app).get("/api/setup/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("setupComplete");
    expect(res.body).toHaveProperty("hasConfig");
    expect(res.body).toHaveProperty("configPath");
  });

  it("GET /api/setup/prerequisites returns system checks", async () => {
    const res = await request(app).get("/api/setup/prerequisites");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("node");
    expect(res.body.node).toHaveProperty("ok");
    expect(res.body.node).toHaveProperty("version");
    expect(res.body).toHaveProperty("docker");
    expect(res.body).toHaveProperty("git");
    expect(res.body).toHaveProperty("platform");
  });

  it("POST /api/setup/config saves configuration when setup is not complete", async () => {
    const res = await request(app)
      .post("/api/setup/config")
      .send({ copilot: { githubToken: "test-token" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/setup/config rejects non-object body", async () => {
    const res = await request(app)
      .post("/api/setup/config")
      .set("Content-Type", "application/json")
      .send(JSON.stringify("just-a-string"));
    expect(res.status).toBe(400);
  });

  it("POST /api/setup/complete marks setup as done", async () => {
    const res = await request(app).post("/api/setup/complete");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/setup/reset clears setup flag", async () => {
    // First complete setup
    await request(app).post("/api/setup/complete");
    // Then reset (setup-complete flag now exists, so need auth)
    const res = await request(app)
      .post("/api/setup/reset")
      .set("Authorization", "Bearer test-secret-token");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  describe("setup auth gate", () => {
    it("POST /api/setup/config requires auth when setup IS complete", async () => {
      // Mark setup as complete first
      await request(app).post("/api/setup/complete");

      // Now POST without auth should be rejected
      const res = await request(app)
        .post("/api/setup/config")
        .send({ auth: { token: "hacked" } });
      expect(res.status).toBe(401);
    });

    it("POST /api/setup/config succeeds with correct auth when setup IS complete", async () => {
      await request(app).post("/api/setup/complete");

      const res = await request(app)
        .post("/api/setup/config")
        .set("Authorization", "Bearer test-secret-token")
        .send({ copilot: { provider: null } });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("POST /api/setup/config rejects wrong token when setup IS complete", async () => {
      await request(app).post("/api/setup/complete");

      const res = await request(app)
        .post("/api/setup/config")
        .set("Authorization", "Bearer wrong-token")
        .send({ auth: { token: "hacked" } });
      expect(res.status).toBe(401);
    });

    it("POST /api/setup/reset requires auth when setup IS complete", async () => {
      await request(app).post("/api/setup/complete");

      const res = await request(app).post("/api/setup/reset");
      expect(res.status).toBe(401);
    });

    it("POST /api/setup/complete requires auth when setup IS already complete", async () => {
      await request(app).post("/api/setup/complete");

      const res = await request(app).post("/api/setup/complete");
      expect(res.status).toBe(401);
    });

    it("GET routes work without auth regardless of setup state", async () => {
      await request(app).post("/api/setup/complete");

      const statusRes = await request(app).get("/api/setup/status");
      expect(statusRes.status).toBe(200);

      const prereqRes = await request(app).get("/api/setup/prerequisites");
      expect(prereqRes.status).toBe(200);
    });
  });
});
