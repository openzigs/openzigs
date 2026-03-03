import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createGalleryRouter } from "./gallery.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockCopilot() {
  return {
    chat: vi.fn(async function* () {
      yield '```json\n{"enhanced_prompt":"A beautiful sunset","thinking":"Enhanced","suggested_parameters":{}}\n```';
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockToolRegistry() {
  return {
    getToolDefinition: vi.fn(() => null),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const copilot = createMockCopilot();
  const toolRegistry = createMockToolRegistry();
  app.use("/gallery", createGalleryRouter({
    copilot: copilot as never,
    toolRegistry: toolRegistry as never,
  }));
  return { app, copilot };
}

describe("Gallery API router", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /enhance-prompt", () => {
    it("rejects missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/gallery/enhance-prompt").send({});
      expect(res.status).toBe(400);
    });

    it("rejects empty prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/gallery/enhance-prompt").send({ raw_prompt: "  " });
      expect(res.status).toBe(400);
    });

    it("enhances a prompt", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/gallery/enhance-prompt").send({
        raw_prompt: "sunset over mountains",
        model: "flux-schnell",
        mode: "txt2img",
      });
      expect(res.status).toBe(200);
      expect(res.body.enhanced_prompt).toBeDefined();
    });
  });
});
