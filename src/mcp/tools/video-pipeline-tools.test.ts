/**
 * Video Pipeline MCP Tools — Unit Tests
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createVideoPipelineTools } from "./video-pipeline-tools.js";

// Minimal mock workers
function makeMockClipExtractor() {
  const emitter = new EventEmitter();
  const jobs = new Map<
    string,
    { id: string; status: string; clips: unknown[] }
  >();
  return Object.assign(emitter, {
    async submit(_req: { source: string }) {
      const id = `clip-test-${Date.now()}`;
      jobs.set(id, { id, status: "complete", clips: [] });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id);
    },
    async waitForCompletion(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error("not found");
      return job;
    },
  });
}

function makeMockReframeWorker() {
  const emitter = new EventEmitter();
  const jobs = new Map<
    string,
    {
      id: string;
      status: string;
      outputPath: string;
      targetAspect: string;
      detectedLayout: string;
    }
  >();
  return Object.assign(emitter, {
    async submit(_req: { source: string }) {
      const id = `reframe-test-${Date.now()}`;
      jobs.set(id, {
        id,
        status: "complete",
        outputPath: "/tmp/out.mp4",
        targetAspect: "9:16",
        detectedLayout: "single-speaker",
      });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id);
    },
    async waitForCompletion(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error("not found");
      return job;
    },
  });
}

function makeMockAudioCleaner() {
  const emitter = new EventEmitter();
  const jobs = new Map<
    string,
    {
      id: string;
      status: string;
      outputPath: string;
      removedFillers: number;
      silenceTrimmed: number;
      durationSaved: number;
    }
  >();
  return Object.assign(emitter, {
    async submit(_req: { source: string }) {
      const id = `audio-test-${Date.now()}`;
      jobs.set(id, {
        id,
        status: "complete",
        outputPath: "/tmp/clean.mp4",
        removedFillers: 12,
        silenceTrimmed: 3,
        durationSaved: 8.5,
      });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id);
    },
    async waitForCompletion(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error("not found");
      return job;
    },
  });
}

function makeMockBRollPipeline() {
  const emitter = new EventEmitter();
  const jobs = new Map<
    string,
    {
      id: string;
      status: string;
      suggestions: {
        timestamp: number;
        duration: number;
        query: string;
        context: string;
        assetPath?: string;
      }[];
    }
  >();
  return Object.assign(emitter, {
    async submit(_req: { source: string }) {
      const id = `broll-test-${Date.now()}`;
      jobs.set(id, {
        id,
        status: "complete",
        suggestions: [
          {
            timestamp: 30,
            duration: 5,
            query: "city",
            context: "establishing",
          },
        ],
      });
      return id;
    },
    getJob(id: string) {
      return jobs.get(id);
    },
    async waitForCompletion(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error("not found");
      return job;
    },
  });
}

describe("createVideoPipelineTools", () => {
  beforeAll(() => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  it("returns all tools when all workers provided", () => {
    const tools = createVideoPipelineTools({
      clipExtractor: makeMockClipExtractor() as never,
      reframeWorker: makeMockReframeWorker() as never,
      audioCleaner: makeMockAudioCleaner() as never,
      brollPipeline: makeMockBRollPipeline() as never,
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("clip-video");
    expect(names).toContain("reframe-video");
    expect(names).toContain("clean-audio");
    expect(names).toContain("add-captions");
    expect(names).toContain("auto-broll");
    expect(names).toContain("export-timeline");
    expect(names).toContain("generate-thumbnail");
  });

  it("skips worker tools when workers not provided", () => {
    const tools = createVideoPipelineTools({});
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("clip-video");
    expect(names).not.toContain("reframe-video");
    expect(names).not.toContain("clean-audio");
    expect(names).not.toContain("auto-broll");
    // These don't need workers:
    expect(names).toContain("add-captions");
    expect(names).toContain("export-timeline");
    expect(names).toContain("generate-thumbnail");
  });

  it("clip-video handler returns clips", async () => {
    const tools = createVideoPipelineTools({
      clipExtractor: makeMockClipExtractor() as never,
    });
    const tool = tools.find((t) => t.name === "clip-video")!;
    const result = await tool.handler({ source: "/tmp/test.mp4" });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed).toHaveProperty("clipCount");
  });

  it("reframe-video handler returns output", async () => {
    const tools = createVideoPipelineTools({
      reframeWorker: makeMockReframeWorker() as never,
    });
    const tool = tools.find((t) => t.name === "reframe-video")!;
    const result = await tool.handler({
      source: "/tmp/test.mp4",
      target_aspect: "9:16",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed.outputPath).toBe("/tmp/out.mp4");
  });

  it("clean-audio handler returns summary", async () => {
    const tools = createVideoPipelineTools({
      audioCleaner: makeMockAudioCleaner() as never,
    });
    const tool = tools.find((t) => t.name === "clean-audio")!;
    const result = await tool.handler({ source: "/tmp/test.mp4" });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed.removedFillers).toBe(12);
  });

  it("add-captions handler returns config", async () => {
    const tools = createVideoPipelineTools({});
    const tool = tools.find((t) => t.name === "add-captions")!;
    const result = await tool.handler({
      source: "/tmp/test.mp4",
      template: "hormozi",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("configured");
    expect(parsed.template).toBe("hormozi");
  });

  it("auto-broll handler returns suggestions", async () => {
    const tools = createVideoPipelineTools({
      brollPipeline: makeMockBRollPipeline() as never,
    });
    const tool = tools.find((t) => t.name === "auto-broll")!;
    const result = await tool.handler({ source: "/tmp/test.mp4" });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed.suggestionCount).toBe(1);
  });

  it("export-timeline handler writes FCPXML", async () => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const tools = createVideoPipelineTools({});
    const tool = tools.find((t) => t.name === "export-timeline")!;
    const manifest = JSON.stringify({
      composition: { fps: 30, width: 1920, height: 1080 },
      timeline: [
        { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
      ],
      title: "Test",
    });
    const result = await tool.handler({
      manifest_json: manifest,
      format: "fcpxml",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed.format).toBe("fcpxml");
  });

  it("export-timeline handler writes EDL", async () => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const tools = createVideoPipelineTools({});
    const tool = tools.find((t) => t.name === "export-timeline")!;
    const manifest = JSON.stringify({
      composition: { fps: 30 },
      timeline: [
        { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
      ],
    });
    const result = await tool.handler({
      manifest_json: manifest,
      format: "edl",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("complete");
    expect(parsed.format).toBe("edl");
  });

  it("export-timeline handler rejects invalid JSON", async () => {
    const tools = createVideoPipelineTools({});
    const tool = tools.find((t) => t.name === "export-timeline")!;
    const result = await tool.handler({
      manifest_json: "NOT JSON",
      format: "fcpxml",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid manifest JSON");
  });

  it("generate-thumbnail handler returns config", async () => {
    const tools = createVideoPipelineTools({});
    const tool = tools.find((t) => t.name === "generate-thumbnail")!;
    const result = await tool.handler({
      source: "/tmp/test.mp4",
      template: "reaction",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.status).toBe("configured");
  });

  it("handler returns error for missing source", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const tools = createVideoPipelineTools({
      clipExtractor: makeMockClipExtractor() as never,
    });
    const tool = tools.find((t) => t.name === "clip-video")!;
    const result = await tool.handler({ source: "/nonexistent.mp4" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });
});
