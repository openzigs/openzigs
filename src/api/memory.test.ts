import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createMemoryRouter } from "./memory.js";
import type { MemoryManager, MemoryConfig } from "../memory/memory-manager.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../memory/memory-manager.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../memory/memory-manager.js")>();
  return {
    ...mod,
    MEMORY_CATEGORIES: ["general", "preferences", "context", "skills", "reference"],
  };
});

// Stub fs so config writes don't touch disk
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("{}"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

function createMockMemoryManager(overrides: Partial<MemoryManager> = {}): MemoryManager {
  return {
    getConfig: vi.fn().mockReturnValue({ enabled: true, owner: "user", repo: "mem", cacheTtlMs: 60000 }),
    updateConfig: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({ connected: true, memoryCount: 3, lastSync: null }),
    setupRepo: vi.fn().mockResolvedValue({ created: true }),
    listMemories: vi.fn().mockResolvedValue([
      { id: "m1", category: "general", title: "Test", content: "hello" },
      { id: "m2", category: "preferences", title: "Pref", content: "dark mode" },
    ]),
    getMemory: vi.fn().mockResolvedValue({ id: "m1", category: "general", title: "Test", content: "hello" }),
    createMemory: vi.fn().mockResolvedValue({ id: "m3", category: "general", title: "New", content: "data" }),
    updateMemory: vi.fn().mockResolvedValue({ id: "m1", category: "general", title: "Updated", content: "new" }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MemoryManager;
}

function buildApp(managerOverrides: Partial<MemoryManager> = {}) {
  const app = express();
  app.use(express.json());
  const memoryManager = createMockMemoryManager(managerOverrides);
  const router = createMemoryRouter({ memoryManager });
  app.use("/memory", router);
  return { app, memoryManager };
}

describe("Memory API router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Config ──────────────────────────────────────────────────

  describe("GET /config", () => {
    it("returns config and status", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/config");
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ enabled: true, owner: "user", repo: "mem", cacheTtlMs: 60000 });
      expect(res.body.status.connected).toBe(true);
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        getConfig: vi.fn().mockImplementation(() => { throw new Error("boom"); }),
      });
      const res = await request(app).get("/memory/config");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("boom");
    });
  });

  describe("PUT /config", () => {
    it("updates config and persists", async () => {
      const { app, memoryManager } = buildApp();
      const res = await request(app).put("/memory/config").send({ enabled: false, owner: "newuser" });
      expect(res.status).toBe(200);
      expect(memoryManager.updateConfig).toHaveBeenCalledWith({ enabled: false, owner: "newuser" });
      expect(res.body.config).toBeDefined();
    });

    it("ignores invalid cacheTtlMs", async () => {
      const { app, memoryManager } = buildApp();
      await request(app).put("/memory/config").send({ cacheTtlMs: -1 });
      expect(memoryManager.updateConfig).toHaveBeenCalledWith({});
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        updateConfig: vi.fn().mockImplementation(() => { throw new Error("write fail"); }),
      });
      const res = await request(app).put("/memory/config").send({ enabled: true });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("write fail");
    });
  });

  // ── Setup ──────────────────────────────────────────────────

  describe("POST /setup", () => {
    it("creates repo", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/setup");
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        setupRepo: vi.fn().mockRejectedValue(new Error("GitHub error")),
      });
      const res = await request(app).post("/memory/setup");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("GitHub error");
    });
  });

  // ── Status ──────────────────────────────────────────────────

  describe("GET /status", () => {
    it("returns status", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.memoryCount).toBe(3);
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        getStatus: vi.fn().mockRejectedValue(new Error("status fail")),
      });
      const res = await request(app).get("/memory/status");
      expect(res.status).toBe(500);
    });
  });

  // ── Categories ──────────────────────────────────────────────

  describe("GET /categories", () => {
    it("returns category list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/categories");
      expect(res.status).toBe(200);
      expect(res.body.categories).toContain("general");
      expect(res.body.categories).toContain("preferences");
    });
  });

  // ── Memories CRUD ──────────────────────────────────────────

  describe("GET /memories", () => {
    it("returns all memories", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/memories");
      expect(res.status).toBe(200);
      expect(res.body.memories).toHaveLength(2);
    });

    it("filters by category", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/memories?category=general");
      expect(res.status).toBe(200);
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].category).toBe("general");
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        listMemories: vi.fn().mockRejectedValue(new Error("list fail")),
      });
      const res = await request(app).get("/memory/memories");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /memories/:id", () => {
    it("returns a single memory", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/memory/memories/m1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("m1");
    });

    it("returns 404 when not found", async () => {
      const { app } = buildApp({
        getMemory: vi.fn().mockResolvedValue(null),
      });
      const res = await request(app).get("/memory/memories/missing");
      expect(res.status).toBe(404);
    });

    it("returns 500 on error", async () => {
      const { app } = buildApp({
        getMemory: vi.fn().mockRejectedValue(new Error("get fail")),
      });
      const res = await request(app).get("/memory/memories/m1");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /memories", () => {
    it("creates a memory", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/memories").send({
        category: "general",
        title: "New Memory",
        content: "Some content",
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("m3");
    });

    it("rejects invalid category", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/memories").send({
        category: "invalid",
        title: "Test",
        content: "data",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid category");
    });

    it("rejects missing title", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/memories").send({
        category: "general",
        content: "data",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Title is required");
    });

    it("rejects empty title", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/memories").send({
        category: "general",
        title: "   ",
        content: "data",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing content", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/memory/memories").send({
        category: "general",
        title: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Content is required");
    });

    it("returns 500 on create error", async () => {
      const { app } = buildApp({
        createMemory: vi.fn().mockRejectedValue(new Error("create fail")),
      });
      const res = await request(app).post("/memory/memories").send({
        category: "general",
        title: "Test",
        content: "data",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /memories/:id", () => {
    it("updates a memory", async () => {
      const { app, memoryManager } = buildApp();
      const res = await request(app).put("/memory/memories/m1").send({ title: "Updated" });
      expect(res.status).toBe(200);
      expect(memoryManager.updateMemory).toHaveBeenCalledWith("m1", { title: "Updated" });
    });

    it("returns 404 when not found", async () => {
      const { app } = buildApp({
        updateMemory: vi.fn().mockRejectedValue(new Error("Memory not found")),
      });
      const res = await request(app).put("/memory/memories/missing").send({ title: "X" });
      expect(res.status).toBe(404);
    });

    it("returns 500 on other errors", async () => {
      const { app } = buildApp({
        updateMemory: vi.fn().mockRejectedValue(new Error("db fail")),
      });
      const res = await request(app).put("/memory/memories/m1").send({ title: "X" });
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /memories/:id", () => {
    it("deletes a memory", async () => {
      const { app, memoryManager } = buildApp();
      const res = await request(app).delete("/memory/memories/m1");
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(memoryManager.deleteMemory).toHaveBeenCalledWith("m1");
    });

    it("returns 404 when not found", async () => {
      const { app } = buildApp({
        deleteMemory: vi.fn().mockRejectedValue(new Error("Memory not found")),
      });
      const res = await request(app).delete("/memory/memories/missing");
      expect(res.status).toBe(404);
    });

    it("returns 500 on other errors", async () => {
      const { app } = buildApp({
        deleteMemory: vi.fn().mockRejectedValue(new Error("db fail")),
      });
      const res = await request(app).delete("/memory/memories/m1");
      expect(res.status).toBe(500);
    });
  });
});
