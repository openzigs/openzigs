/**
 * Video Pipeline API — Unit Tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { createVideoPipelineRouter } from "./video-pipeline.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Mock workers
function createMockExtractor() {
  const emitter = new EventEmitter();
  const jobs = new Map<string, unknown>();
  return Object.assign(emitter, {
    async submit() {
      const id = "clip-001";
      jobs.set(id, { id, status: "queued", clips: [] });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id) ?? null;
    },
  });
}

function createMockReframeWorker() {
  const emitter = new EventEmitter();
  const jobs = new Map<string, unknown>();
  return Object.assign(emitter, {
    async submit() {
      const id = "reframe-001";
      jobs.set(id, { id, status: "queued" });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id) ?? null;
    },
  });
}

function createMockAudioCleaner() {
  const emitter = new EventEmitter();
  const jobs = new Map<string, unknown>();
  return Object.assign(emitter, {
    async submit() {
      const id = "audio-001";
      jobs.set(id, { id, status: "queued" });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id) ?? null;
    },
  });
}

function createMockBRollPipeline() {
  const emitter = new EventEmitter();
  const jobs = new Map<string, unknown>();
  return Object.assign(emitter, {
    async submit() {
      const id = "broll-001";
      jobs.set(id, { id, status: "queued", suggestions: [] });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id) ?? null;
    },
  });
}

describe("createVideoPipelineRouter", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    const router = createVideoPipelineRouter({
      clipExtractor: createMockExtractor() as never,
      reframeWorker: createMockReframeWorker() as never,
      audioCleaner: createMockAudioCleaner() as never,
      brollPipeline: createMockBRollPipeline() as never,
    });
    app.use("/pipeline", router);
  });

  // ── Clip ──
  it("POST /clip submits a job", async () => {
    const res = await request(app)
      .post("/pipeline/clip")
      .send({ source: "/tmp/test.mp4" });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("clip-001");
    expect(res.body.status).toBe("queued");
  });

  it("POST /clip rejects invalid body", async () => {
    const res = await request(app).post("/pipeline/clip").send({});
    expect(res.status).toBe(400);
  });

  it("GET /clip/:jobId returns job", async () => {
    await request(app).post("/pipeline/clip").send({ source: "/tmp/test.mp4" });
    const res = await request(app).get("/pipeline/clip/clip-001");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("clip-001");
  });

  it("GET /clip/:jobId returns 404 for missing job", async () => {
    const res = await request(app).get("/pipeline/clip/nonexistent");
    expect(res.status).toBe(404);
  });

  // ── Reframe ──
  it("POST /reframe submits a job", async () => {
    const res = await request(app)
      .post("/pipeline/reframe")
      .send({ source: "/tmp/test.mp4", targetAspect: "9:16" });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("reframe-001");
  });

  it("POST /reframe rejects invalid aspect", async () => {
    const res = await request(app)
      .post("/pipeline/reframe")
      .send({ source: "/tmp/test.mp4", targetAspect: "invalid" });
    expect(res.status).toBe(400);
  });

  // ── Clean Audio ──
  it("POST /clean-audio submits a job", async () => {
    const res = await request(app)
      .post("/pipeline/clean-audio")
      .send({ source: "/tmp/test.mp3" });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("audio-001");
  });

  // ── B-Roll ──
  it("POST /broll submits a job", async () => {
    const res = await request(app)
      .post("/pipeline/broll")
      .send({ source: "/tmp/test.mp4" });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("broll-001");
  });

  // ── Caption Templates ──
  it("GET /caption-templates returns all templates", async () => {
    const res = await request(app).get("/pipeline/caption-templates");
    expect(res.status).toBe(200);
    expect(res.body.templates).toBeInstanceOf(Array);
    expect(res.body.templates.length).toBeGreaterThan(0);
    const ids = res.body.templates.map((t: { id: string }) => t.id);
    expect(ids).toContain("hormozi");
    expect(ids).toContain("minimal");
  });

  // ── Export ──
  it("POST /export generates FCP XML", async () => {
    const res = await request(app)
      .post("/pipeline/export")
      .send({
        manifest: {
          composition: { fps: 30, width: 1920, height: 1080 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "fcpxml",
      });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("fcpxml");
    expect(res.body.status).toBe("complete");
  });

  it("POST /export generates EDL", async () => {
    const res = await request(app)
      .post("/pipeline/export")
      .send({
        manifest: {
          composition: { fps: 30 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "edl",
      });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("edl");
  });

  it("POST /export rejects invalid format", async () => {
    const res = await request(app)
      .post("/pipeline/export")
      .send({ manifest: {}, format: "invalid" });
    expect(res.status).toBe(400);
  });
});
