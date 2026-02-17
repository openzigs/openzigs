/**
 * Director Mode — Image Generation Service Tests
 * Issue #254: Tests for dual-provider image generation with failover.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageGenService } from "./image-gen-service.js";
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
});
