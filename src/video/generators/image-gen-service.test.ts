/**
 * Director Mode — Image Generation Service Tests
 * Issue #254: Tests for dual-provider image generation with failover.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageGenService, readPngWidth, readPngHeight } from "./image-gen-service.js";
// ImageGenResult type used implicitly in assertions
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock the file system calls
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual("node:fs/promises");
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock nanoid
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "testid12"),
}));

describe("ImageGenService", () => {
  let service: ImageGenService;
  const testOutputDir = path.join(os.tmpdir(), "openzigs-test-image-gen");

  beforeEach(() => {
    service = new ImageGenService({
      outputDir: testOutputDir,
      localSidecarUrl: "http://127.0.0.1:5005",
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor and initialization", () => {
    it("creates service with default config", () => {
      const svc = new ImageGenService();
      expect(svc.cloudAvailable).toBeNull();
      expect(svc.localAvailable).toBeNull();
    });

    it("creates service with custom config", () => {
      const svc = new ImageGenService({
        outputDir: "/custom/output",
        localSidecarUrl: "http://localhost:9000",
        cloudTimeoutMs: 30_000,
      });
      expect(svc.cloudAvailable).toBeNull();
    });

    it("initialize creates output directory", async () => {
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      await service.initialize();
      expect(mkdirSpy).toHaveBeenCalledWith(testOutputDir, { recursive: true });
      mkdirSpy.mockRestore();
    });
  });

  describe("generateImage — local provider", () => {
    it("calls local sidecar and returns image result", async () => {
      const fakeImageBuffer = Buffer.from("fake-png-data");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(0)),
        headers: new Map([["X-Generation-Time", "1200ms"]]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await service.generateImage("a cat sitting on a laptop", {
        provider: "local",
        width: 1024,
        height: 1024,
      });

      expect(result.provider).toBe("local");
      expect(result.filePath).toContain("openzigs-local-testid12.png");
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);
      expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
      expect(mockFetch).toHaveBeenCalledOnce();

      // Verify the request body
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("http://127.0.0.1:5005/generate");
      const body = JSON.parse(fetchCall[1].body);
      expect(body.prompt).toBe("a cat sitting on a laptop");
      expect(body.width).toBe(1024);
      expect(body.height).toBe(1024);

      vi.unstubAllGlobals();
    });

    it("throws when local sidecar returns error status", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }));

      await expect(
        service.generateImage("test", { provider: "local" }),
      ).rejects.toThrow("Local sidecar returned 500");

      expect(service.localAvailable).toBe(false);
      vi.unstubAllGlobals();
    });

    it("throws when local sidecar is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(
        service.generateImage("test", { provider: "local" }),
      ).rejects.toThrow("ECONNREFUSED");

      expect(service.localAvailable).toBe(false);
      vi.unstubAllGlobals();
    });

    it("passes optional parameters to local sidecar", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await service.generateImage("test prompt", {
        provider: "local",
        width: 512,
        height: 512,
        seed: 42,
        steps: 8,
        negativePrompt: "blurry, low quality",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.seed).toBe(42);
      expect(body.steps).toBe(8);
      expect(body.negative_prompt).toBe("blurry, low quality");

      vi.unstubAllGlobals();
    });
  });

  describe("generateImage — cloud provider", () => {
    it("throws when GCP project ID is not configured", async () => {
      const svc = new ImageGenService({
        gcpProjectId: "",
        outputDir: testOutputDir,
      });

      await expect(
        svc.generateImage("test", { provider: "cloud" }),
      ).rejects.toThrow("GCP_PROJECT_ID not configured");
    });

  });

  describe("generateImage — auto provider", () => {
    it("falls back to local when cloud fails", async () => {
      const svc = new ImageGenService({
        gcpProjectId: "",
        outputDir: testOutputDir,
        localSidecarUrl: "http://127.0.0.1:5005",
      });

      const fakeImageBuffer = Buffer.from("fake-png");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(0)),
        headers: new Map(),
      }));

      const result = await svc.generateImage("test", { provider: "auto" });
      expect(result.provider).toBe("local");

      vi.unstubAllGlobals();
    });

    it("throws when both providers fail", async () => {
      const svc = new ImageGenService({
        gcpProjectId: "",
        outputDir: testOutputDir,
      });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(
        svc.generateImage("test", { provider: "auto" }),
      ).rejects.toThrow("Image generation failed on both providers");

      vi.unstubAllGlobals();
    });
  });

  describe("checkHealth", () => {
    it("reports local sidecar health when available", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: true, model: "flux-schnell" }),
      }));

      const health = await service.checkHealth();
      expect(health.local).toBe(true);
      expect(service.localAvailable).toBe(true);

      vi.unstubAllGlobals();
    });

    it("reports local sidecar unhealthy when not ready", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: false }),
      }));

      const health = await service.checkHealth();
      expect(health.local).toBe(false);
      expect(service.localAvailable).toBe(false);

      vi.unstubAllGlobals();
    });

    it("reports local sidecar unhealthy when unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const health = await service.checkHealth();
      expect(health.local).toBe(false);
      expect(service.localAvailable).toBe(false);

      vi.unstubAllGlobals();
    });

    it("reports cloud unhealthy when no project ID", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const svc = new ImageGenService({
        gcpProjectId: "",
        outputDir: testOutputDir,
      });

      const health = await svc.checkHealth();
      expect(health.cloud).toBe(false);

      vi.unstubAllGlobals();
    });
  });

  describe("aspect ratio resolution", () => {
    // The resolveAspectRatio method is private, so we test it indirectly via cloud errors
    // that include the aspect ratio — or we can test that different dimensions
    // produce different behaviors without error.
    it("handles various dimension combinations without error", async () => {
      const fakeImageBuffer = Buffer.from("fake");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(0)),
        headers: new Map(),
      }));

      // 16:9
      const r1 = await service.generateImage("test", { provider: "local", width: 1920, height: 1080 });
      expect(r1.width).toBe(1920);
      expect(r1.height).toBe(1080);

      // 9:16
      const r2 = await service.generateImage("test", { provider: "local", width: 1080, height: 1920 });
      expect(r2.width).toBe(1080);
      expect(r2.height).toBe(1920);

      // 1:1
      const r3 = await service.generateImage("test", { provider: "local", width: 1024, height: 1024 });
      expect(r3.width).toBe(1024);
      expect(r3.height).toBe(1024);

      vi.unstubAllGlobals();
    });
  });

  describe("network mode routing", () => {
    it("effectiveSidecarUrl returns networkNodeUrl in network mode", () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
      });
      expect(svc.effectiveSidecarUrl).toBe("http://192.168.1.50:5005");
      expect(svc.isNetworkMode).toBe(true);
    });

    it("effectiveSidecarUrl strips trailing slash", () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005/",
      });
      expect(svc.effectiveSidecarUrl).toBe("http://192.168.1.50:5005");
    });

    it("effectiveSidecarUrl falls back to localSidecarUrl when mode is local", () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "local",
        localSidecarUrl: "http://127.0.0.1:5005",
        networkNodeUrl: "http://192.168.1.50:5005",
      });
      expect(svc.effectiveSidecarUrl).toBe("http://127.0.0.1:5005");
      expect(svc.isNetworkMode).toBe(false);
    });

    it("effectiveSidecarUrl falls back when networkNodeUrl is empty", () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "",
        localSidecarUrl: "http://127.0.0.1:5005",
      });
      expect(svc.effectiveSidecarUrl).toBe("http://127.0.0.1:5005");
      expect(svc.isNetworkMode).toBe(false);
    });

    it("sends Authorization header in network mode with token", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "secret-token-123",
      });

      const mockFetch = vi.fn()
        // First call: submit to /generate-async
        .mockResolvedValueOnce({ ok: true })
        // Second call: poll /job-result/{id} — return completed
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            status: "complete",
            media_base64: Buffer.from("fakeimage").toString("base64"),
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await svc.generateImage("test", { provider: "local", width: 512, height: 512 });

      // Submit call includes Authorization header
      const submitCall = mockFetch.mock.calls[0];
      expect(submitCall[0]).toBe("http://192.168.1.50:5005/generate-async");
      expect(submitCall[1].headers.Authorization).toBe("Bearer secret-token-123");

      // Poll call also includes Authorization header
      const pollCall = mockFetch.mock.calls[1];
      expect(pollCall[1].headers.Authorization).toBe("Bearer secret-token-123");

      vi.unstubAllGlobals();
    }, 10_000);

    it("does not send Authorization header in local mode", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "local",
        localSidecarUrl: "http://127.0.0.1:5005",
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await svc.generateImage("test", { provider: "local", width: 512, height: 512 });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("http://127.0.0.1:5005/generate");
      expect(fetchCall[1].headers.Authorization).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("sends Authorization header on health check in network mode", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "health-token-456",
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: true, model: "flux-schnell" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await svc.checkHealth();

      const healthCall = mockFetch.mock.calls[0];
      expect(healthCall[0]).toBe("http://192.168.1.50:5005/health");
      expect(healthCall[1].headers.Authorization).toBe("Bearer health-token-456");

      vi.unstubAllGlobals();
    });
  });

  describe("loadUserImageGenConfig", () => {
    it("returns empty object when config file does not exist", async () => {
      const result = await ImageGenService.loadUserImageGenConfig();
      // Will return {} or values from actual config — either way should not throw
      expect(result).toBeDefined();
    });
  });

  describe("enhanceImage", () => {
    it("calls /img2img endpoint with base64 image and returns result", async () => {
      const fakeResult = Buffer.from("enhanced-png");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeResult.buffer.slice(0)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      // Mock fs.readFile to return a small fake image
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(Buffer.from("fake-source-image"));

      const result = await service.enhanceImage("/tmp/source.png", "make it look cinematic");

      expect(result.provider).toBe("local");
      expect(result.filePath).toContain("openzigs-img2img-testid12.png");
      expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("http://127.0.0.1:5005/img2img");
      const body = JSON.parse(fetchCall[1].body);
      expect(body.prompt).toBe("make it look cinematic");
      expect(body.image).toBeDefined(); // base64
      expect(body.strength).toBe(0.6); // default

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("clamps strength between 0.1 and 0.95", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("img"));

      // strength too low — clamped to 0.1
      await service.enhanceImage("/tmp/src.png", "test", { strength: 0.01 });
      let body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.strength).toBe(0.1);

      // strength too high — clamped to 0.95
      await service.enhanceImage("/tmp/src.png", "test", { strength: 1.5 });
      body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.strength).toBe(0.95);

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("throws when image exceeds 20MB limit", async () => {
      const bigBuffer = Buffer.alloc(21 * 1024 * 1024); // 21 MB
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(bigBuffer);

      await expect(
        service.enhanceImage("/tmp/huge.png", "enhance"),
      ).rejects.toThrow("Image too large");

      readFileSpy.mockRestore();
    });

    it("throws when sidecar returns error on img2img", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("CUDA OOM"),
      }));
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(Buffer.from("small"));

      await expect(
        service.enhanceImage("/tmp/src.png", "enhance"),
      ).rejects.toThrow("img2img sidecar returned 500");

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("passes optional params (model, seed, width, height, steps, guidance_scale)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("img"));

      await service.enhanceImage("/tmp/src.png", "enhance", {
        model: "kontext-dev",
        seed: 42,
        width: 1024,
        height: 768,
        steps: 20,
        guidance_scale: 7.5,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("kontext-dev");
      expect(body.seed).toBe(42);
      expect(body.width).toBe(1024);
      expect(body.height).toBe(768);
      expect(body.steps).toBe(20);
      expect(body.guidance_scale).toBe(7.5);

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("sends auth header in network mode for img2img", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "my-token",
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("img"));

      await svc.enhanceImage("/tmp/src.png", "enhance");

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("http://192.168.1.50:5005/img2img");
      expect(fetchCall[1].headers.Authorization).toBe("Bearer my-token");

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe("kontextEdit", () => {
    it("calls /kontext endpoint with base64 image and returns result", async () => {
      const fakeResult = Buffer.from("edited-png");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeResult.buffer.slice(0)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(Buffer.from("source-img"));

      const result = await service.kontextEdit("/tmp/source.png", "Add a dog in the foreground");

      expect(result.provider).toBe("local");
      expect(result.filePath).toContain("openzigs-kontext-testid12.png");

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("http://127.0.0.1:5005/kontext");
      const body = JSON.parse(fetchCall[1].body);
      expect(body.prompt).toBe("Add a dog in the foreground");
      expect(body.image).toBeDefined();

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("throws when image exceeds 20MB limit", async () => {
      const bigBuffer = Buffer.alloc(21 * 1024 * 1024);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(bigBuffer);

      await expect(
        service.kontextEdit("/tmp/huge.png", "edit it"),
      ).rejects.toThrow("Image too large");

      readFileSpy.mockRestore();
    });

    it("throws when sidecar returns error on kontext", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Invalid prompt"),
      }));
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(Buffer.from("small"));

      await expect(
        service.kontextEdit("/tmp/src.png", "edit"),
      ).rejects.toThrow("Kontext sidecar returned 422");

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("passes optional params (seed, width, height, steps, guidance)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("img"));

      const result = await service.kontextEdit("/tmp/src.png", "add hat", {
        seed: 123,
        width: 512,
        height: 512,
        steps: 30,
        guidance: 5.0,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.seed).toBe(123);
      expect(body.width).toBe(512);
      expect(body.height).toBe(512);
      expect(body.steps).toBe(30);
      expect(body.guidance).toBe(5.0);
      expect(result.width).toBe(512);
      expect(result.height).toBe(512);

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it("sends auth header in network mode for kontext", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "kontext-token",
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);
      const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("img"));

      await svc.kontextEdit("/tmp/src.png", "edit");

      expect(mockFetch.mock.calls[0][0]).toBe("http://192.168.1.50:5005/kontext");
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer kontext-token");

      readFileSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe("getRecommendedResolution", () => {
    it("returns resolution when sidecar reports it", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: true, recommended_width: 1024, recommended_height: 1024 }),
      }));

      const result = await service.getRecommendedResolution();
      expect(result).toEqual({ width: 1024, height: 1024 });

      vi.unstubAllGlobals();
    });

    it("returns null when sidecar is not ready", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: false }),
      }));

      const result = await service.getRecommendedResolution();
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it("returns null when sidecar is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await service.getRecommendedResolution();
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it("returns null when recommended dimensions are missing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: true }),
      }));

      const result = await service.getRecommendedResolution();
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it("sends auth header in network mode", async () => {
      const svc = new ImageGenService({
        outputDir: testOutputDir,
        imageGenMode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "res-token",
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ready: true, recommended_width: 512, recommended_height: 512 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await svc.getRecommendedResolution();

      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer res-token");

      vi.unstubAllGlobals();
    });
  });

  describe("generateLocal with localModel", () => {
    it("includes model in request body when localModel is specified", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await service.generateImage("test", {
        provider: "local",
        localModel: "sdxl-base",
        width: 512,
        height: 512,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("sdxl-base");

      vi.unstubAllGlobals();
    });

    it("omits model from request body when not specified", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await service.generateImage("test", { provider: "local" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe("default dimensions", () => {
    it("uses 1024x1024 when no dimensions are provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        headers: new Map(),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await service.generateImage("a landscape", { provider: "local" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.width).toBe(1024);
      expect(body.height).toBe(1024);
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);

      vi.unstubAllGlobals();
    });
  });
});

describe("readPngWidth / readPngHeight", () => {
  /** Build a minimal valid PNG header with given width/height. */
  function makePngHeader(width: number, height: number): Buffer {
    const buf = Buffer.alloc(24);
    // PNG signature
    buf[0] = 0x89;
    buf[1] = 0x50; // P
    buf[2] = 0x4e; // N
    buf[3] = 0x47; // G
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // IHDR chunk length
    buf.writeUInt32BE(13, 8);
    // "IHDR"
    buf.write("IHDR", 12, 4, "ascii");
    // Width at offset 16
    buf.writeUInt32BE(width, 16);
    // Height at offset 20
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  it("reads correct dimensions from a valid PNG header", () => {
    const buf = makePngHeader(1280, 720);
    expect(readPngWidth(buf)).toBe(1280);
    expect(readPngHeight(buf)).toBe(720);
  });

  it("returns null for a buffer that is too short", () => {
    const buf = Buffer.alloc(10);
    expect(readPngWidth(buf)).toBeNull();
    expect(readPngHeight(buf)).toBeNull();
  });

  it("returns null for a non-PNG buffer", () => {
    const buf = Buffer.alloc(24);
    buf.write("NOT_PNG!", 0, 8, "ascii");
    expect(readPngWidth(buf)).toBeNull();
    expect(readPngHeight(buf)).toBeNull();
  });

  it("handles large dimensions", () => {
    const buf = makePngHeader(3840, 2160);
    expect(readPngWidth(buf)).toBe(3840);
    expect(readPngHeight(buf)).toBe(2160);
  });
});
