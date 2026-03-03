import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createVoiceRouter } from "./voice.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../voice/index.js", () => ({
  AVAILABLE_VOICES: [{ id: "en-US-Neural2-F", description: "Female" }],
  AVAILABLE_LOCAL_VOICES: [{ id: "af_heart", description: "Heart" }],
}));

function createMockVoiceService() {
  return {
    isReady: vi.fn(() => true),
    getConfig: vi.fn(() => ({
      enabled: true,
      voiceName: "af_heart",
      speakingRate: 1.0,
      pitch: 0,
      maxCacheSizeMb: 100,
      maxTextLength: 5000,
    })),
    getProvider: vi.fn((): string => "local"),
    getSidecarUrl: vi.fn(() => "http://127.0.0.1:5006"),
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from("audio-data"),
      contentType: "audio/wav",
      cached: false,
      durationMs: 1200,
    }),
    transcribe: vi.fn().mockResolvedValue({ text: "hello world", language: "en" }),
    getLocalVoices: vi.fn().mockResolvedValue([{ id: "af_heart" }]),
    getSidecarHealth: vi.fn().mockResolvedValue({ status: "ok", engine: "kokoro" }),
    unloadSidecarModels: vi.fn().mockResolvedValue({ freed: true }),
    getCacheStats: vi.fn().mockResolvedValue({ entries: 5, sizeMb: 10 }),
    clearCache: vi.fn().mockResolvedValue(undefined),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const vs = createMockVoiceService();
  app.use("/voice", createVoiceRouter({ voiceService: vs as never }));
  return { app, vs };
}

describe("Voice API router", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /speak", () => {
    it("synthesizes text", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/speak").send({ text: "hello" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio/wav");
    });

    it("returns 503 when not ready", async () => {
      const { app, vs } = buildApp();
      vs.isReady.mockReturnValue(false);
      const res = await request(app).post("/voice/speak").send({ text: "hello" });
      expect(res.status).toBe(503);
    });

    it("rejects empty text", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/speak").send({ text: "" });
      expect(res.status).toBe(400);
    });

    it("rejects oversized text", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/speak").send({ text: "x".repeat(5001) });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /config", () => {
    it("returns voice config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/voice/config");
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("local");
      expect(res.body.ready).toBe(true);
    });
  });

  describe("GET /voices", () => {
    it("returns local voices", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/voice/voices");
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("local");
    });
  });

  describe("GET /health", () => {
    it("returns health with sidecar status", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/voice/health");
      expect(res.status).toBe(200);
      expect(res.body.sidecar.status).toBe("ok");
    });

    it("handles sidecar unreachable", async () => {
      const { app, vs } = buildApp();
      vs.getSidecarHealth.mockRejectedValue(new Error("connect refused"));
      const res = await request(app).get("/voice/health");
      expect(res.status).toBe(200);
      expect(res.body.sidecar.status).toBe("unreachable");
    });
  });

  describe("POST /preview", () => {
    it("synthesizes preview", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/preview").send({ text: "test" });
      expect(res.status).toBe(200);
    });

    it("rejects long preview text", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/preview").send({ text: "x".repeat(201) });
      expect(res.status).toBe(400);
    });

    it("returns 503 if not ready", async () => {
      const { app, vs } = buildApp();
      vs.isReady.mockReturnValue(false);
      const res = await request(app).post("/voice/preview").send({ text: "test" });
      expect(res.status).toBe(503);
    });
  });

  describe("POST /unload", () => {
    it("unloads models", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/unload?model=all");
      expect(res.status).toBe(200);
    });

    it("rejects invalid model param", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/unload?model=bad");
      expect(res.status).toBe(400);
    });

    it("rejects non-local provider", async () => {
      const { app, vs } = buildApp();
      vs.getProvider.mockReturnValue("google");
      const res = await request(app).post("/voice/unload?model=all");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /transcribe", () => {
    it("returns 503 when not ready", async () => {
      const { app, vs } = buildApp();
      vs.isReady.mockReturnValue(false);
      const res = await request(app).post("/voice/transcribe");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /cache", () => {
    it("returns cache stats", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/voice/cache");
      expect(res.status).toBe(200);
      expect(res.body.entries).toBe(5);
    });
  });

  describe("DELETE /cache", () => {
    it("clears cache", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/voice/cache");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 500 on cache clear error", async () => {
      const { app, vs } = buildApp();
      vs.clearCache.mockRejectedValue(new Error("disk full"));
      const res = await request(app).delete("/voice/cache");
      expect(res.status).toBe(500);
    });
  });

  describe("/speak error branches", () => {
    it("returns 429 on quota exhaustion", async () => {
      const { app, vs } = buildApp();
      vs.synthesize.mockRejectedValue(new Error("quota RESOURCE_EXHAUSTED"));
      const res = await request(app).post("/voice/speak").send({ text: "hi" });
      expect(res.status).toBe(429);
    });

    it("returns 503 on credentials error", async () => {
      const { app, vs } = buildApp();
      vs.synthesize.mockRejectedValue(new Error("UNAUTHENTICATED credentials"));
      const res = await request(app).post("/voice/speak").send({ text: "hi" });
      expect(res.status).toBe(503);
    });

    it("returns 502 on sidecar error", async () => {
      const { app, vs } = buildApp();
      vs.synthesize.mockRejectedValue(new Error("sidecar connection refused"));
      const res = await request(app).post("/voice/speak").send({ text: "hi" });
      expect(res.status).toBe(502);
      expect(res.body.error).toContain("sidecar");
    });

    it("returns 502 on generic synthesis error", async () => {
      const { app, vs } = buildApp();
      vs.synthesize.mockRejectedValue(new Error("unknown failure"));
      const res = await request(app).post("/voice/speak").send({ text: "hi" });
      expect(res.status).toBe(502);
    });
  });

  describe("/transcribe additional branches", () => {
    it("rejects non-local provider", async () => {
      const { app, vs } = buildApp();
      vs.getProvider.mockReturnValue("google");
      const res = await request(app).post("/voice/transcribe");
      expect(res.status).toBe(400);
    });

    it("rejects missing audio file", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/voice/transcribe");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No audio file");
    });

    it("returns 502 on transcription error", async () => {
      const { app, vs } = buildApp();
      vs.transcribe.mockRejectedValue(new Error("whisper crashed"));
      const res = await request(app)
        .post("/voice/transcribe")
        .attach("audio", Buffer.from("fake-audio"), "test.wav");
      expect(res.status).toBe(502);
    });
  });

  describe("/voices google path", () => {
    it("returns google voices for google provider", async () => {
      const { app, vs } = buildApp();
      vs.getProvider.mockReturnValue("google");
      const res = await request(app).get("/voice/voices");
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("google");
    });

    it("falls back to static list when local voices empty", async () => {
      const { app, vs } = buildApp();
      vs.getLocalVoices.mockResolvedValue([]);
      const res = await request(app).get("/voice/voices");
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("local");
    });
  });

  describe("/health non-local", () => {
    it("returns null sidecar for google provider", async () => {
      const { app, vs } = buildApp();
      vs.getProvider.mockReturnValue("google");
      const res = await request(app).get("/voice/health");
      expect(res.status).toBe(200);
      expect(res.body.sidecar).toBeNull();
    });
  });

  describe("/preview edge cases", () => {
    it("uses default preview text when none provided", async () => {
      const { app, vs } = buildApp();
      const res = await request(app).post("/voice/preview").send({});
      expect(res.status).toBe(200);
      expect(vs.synthesize).toHaveBeenCalledWith("Hello! This is a voice preview.", undefined);
    });

    it("returns 502 on preview synthesis error", async () => {
      const { app, vs } = buildApp();
      vs.synthesize.mockRejectedValue(new Error("engine down"));
      const res = await request(app).post("/voice/preview").send({ text: "test" });
      expect(res.status).toBe(502);
    });
  });

  describe("/unload error", () => {
    it("returns 502 on unload failure", async () => {
      const { app, vs } = buildApp();
      vs.unloadSidecarModels.mockRejectedValue(new Error("timeout"));
      const res = await request(app).post("/voice/unload?model=tts");
      expect(res.status).toBe(502);
    });
  });

  describe("/cache error", () => {
    it("returns 500 on cache stats error", async () => {
      const { app, vs } = buildApp();
      vs.getCacheStats.mockRejectedValue(new Error("db locked"));
      const res = await request(app).get("/voice/cache");
      expect(res.status).toBe(500);
    });
  });
});
