import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {
  createCreativeRouter,
  validatePath,
  resolveImagePath,
  SAFE_BASE,
} from "./creative.js";

// Create a tiny test image in a temp directory
let tmpDir: string;
let testImagePath: string;
let testWatermarkPath: string;

function createMockCopilotWrapper(
  response = "a tabby cat with detailed fur texture, warm natural lighting",
) {
  return {
    chat: vi.fn(async function* () {
      yield response;
    }),
  };
}

function createTestApp(withCopilot = false) {
  const mockMediaQueueRepo = {
    createJob: vi.fn(() => ({
      id: "job-1",
      status: "pending",
    })),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/creative",
    createCreativeRouter({
      mediaQueueRepo: mockMediaQueueRepo as never,
      copilotWrapper: withCopilot
        ? (createMockCopilotWrapper() as never)
        : undefined,
    }),
  );
  return { app, mockMediaQueueRepo };
}

describe("Creative Image Manipulation API (Issue #811)", () => {
  let app: express.Express;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.homedir(), ".openzigs", "test-creative-"),
    );
    // Create a small test PNG
    testImagePath = path.join(tmpDir, "test.png");
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(testImagePath);

    // Create a small watermark PNG
    testWatermarkPath = path.join(tmpDir, "watermark.png");
    await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0.5 },
      },
    })
      .png()
      .toFile(testWatermarkPath);

    ({ app } = createTestApp());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("POST /creative/resize", () => {
    it("resizes an image", async () => {
      const res = await request(app).post("/creative/resize").send({
        file_path: testImagePath,
        width: 50,
        height: 50,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.width).toBeLessThanOrEqual(50);
      expect(res.body.height).toBeLessThanOrEqual(50);
    });

    it("returns 400 when file_path is missing", async () => {
      const res = await request(app)
        .post("/creative/resize")
        .send({ width: 50 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("file_path");
    });

    it("returns 400 when neither width nor height provided", async () => {
      const res = await request(app).post("/creative/resize").send({
        file_path: testImagePath,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("width or height");
    });

    it("returns 404 for non-existent file", async () => {
      const res = await request(app)
        .post("/creative/resize")
        .send({
          file_path: path.join(tmpDir, "nonexistent.png"),
          width: 50,
        });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /creative/crop", () => {
    it("crops an image", async () => {
      const res = await request(app).post("/creative/crop").send({
        file_path: testImagePath,
        left: 10,
        top: 10,
        width: 50,
        height: 50,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.width).toBe(50);
      expect(res.body.height).toBe(50);
    });

    it("returns 400 when dimensions are missing", async () => {
      const res = await request(app).post("/creative/crop").send({
        file_path: testImagePath,
        left: 0,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /creative/filter", () => {
    it("applies grayscale filter", async () => {
      const res = await request(app).post("/creative/filter").send({
        file_path: testImagePath,
        filter: "grayscale",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.filter).toBe("grayscale");
    });

    it("applies blur filter with intensity", async () => {
      const res = await request(app).post("/creative/filter").send({
        file_path: testImagePath,
        filter: "blur",
        intensity: 5,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 400 for invalid filter", async () => {
      const res = await request(app).post("/creative/filter").send({
        file_path: testImagePath,
        filter: "invalid_filter",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filter must be");
    });
  });

  describe("POST /creative/convert", () => {
    it("converts PNG to JPEG", async () => {
      const res = await request(app).post("/creative/convert").send({
        file_path: testImagePath,
        format: "jpeg",
        quality: 90,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.format).toBe("jpeg");
    });

    it("returns 400 for invalid format", async () => {
      const res = await request(app).post("/creative/convert").send({
        file_path: testImagePath,
        format: "bmp",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("format must be");
    });
  });

  describe("POST /creative/watermark", () => {
    it("adds a watermark", async () => {
      const res = await request(app).post("/creative/watermark").send({
        file_path: testImagePath,
        watermark_path: testWatermarkPath,
        position: "bottom-right",
        opacity: 0.5,
        scale: 0.2,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.position).toBe("bottom-right");
    });

    it("returns 400 when watermark_path is missing", async () => {
      const res = await request(app).post("/creative/watermark").send({
        file_path: testImagePath,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("watermark_path");
    });

    it("returns 404 when source file not found", async () => {
      const res = await request(app)
        .post("/creative/watermark")
        .send({
          file_path: path.join(tmpDir, "missing.png"),
          watermark_path: testWatermarkPath,
        });
      expect(res.status).toBe(404);
    });
  });
});

describe("Creative — GET /image-models", () => {
  it("returns the list of available image generation models", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/creative/image-models");
    expect(res.status).toBe(200);
    expect(res.body.models).toBeInstanceOf(Array);
    expect(res.body.models.length).toBeGreaterThan(0);
    const modelIds = res.body.models.map((m: { id: string }) => m.id);
    expect(modelIds).toContain("flux-kontext");
    for (const model of res.body.models) {
      expect(model).toHaveProperty("id");
      expect(model).toHaveProperty("name");
      expect(model).toHaveProperty("description");
    }
  });
});

describe("Creative — POST /enhance-prompt", () => {
  it("returns 503 when no copilotWrapper is configured", async () => {
    const { app } = createTestApp(false);
    const res = await request(app)
      .post("/creative/enhance-prompt")
      .send({ prompt: "a cat" });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("not available");
  });

  it("returns the enhanced prompt when copilotWrapper is available", async () => {
    const { app } = createTestApp(true);
    const res = await request(app)
      .post("/creative/enhance-prompt")
      .send({ prompt: "a cat" });
    expect(res.status).toBe(200);
    expect(res.body.enhancedPrompt).toBeTruthy();
    expect(typeof res.body.enhancedPrompt).toBe("string");
  });

  it("returns 400 when prompt is missing", async () => {
    const { app } = createTestApp(true);
    const res = await request(app).post("/creative/enhance-prompt").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("prompt is required");
  });

  it("returns 400 when prompt exceeds 2000 characters", async () => {
    const { app } = createTestApp(true);
    const res = await request(app)
      .post("/creative/enhance-prompt")
      .send({ prompt: "a".repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("2000");
  });
});

describe("Creative — POST /inpaint model selection", () => {
  let tmpTestDir: string;

  beforeEach(() => {
    tmpTestDir = fs.mkdtempSync(
      path.join(os.homedir(), ".openzigs", "test-inpaint-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  });

  async function buildSmallPng(): Promise<Buffer> {
    return sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();
  }

  it("defaults to flux-kontext when no model is specified", async () => {
    const { app, mockMediaQueueRepo } = createTestApp();
    const imgBuf = await buildSmallPng();
    const res = await request(app)
      .post("/creative/inpaint")
      .attach("image", imgBuf, {
        filename: "test.png",
        contentType: "image/png",
      })
      .field("prompt", "a golden retriever");
    expect(res.status).toBe(202);
    expect(mockMediaQueueRepo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: "flux-kontext" }),
    );
  });

  it("uses the specified valid model", async () => {
    const { app, mockMediaQueueRepo } = createTestApp();
    const imgBuf = await buildSmallPng();
    const res = await request(app)
      .post("/creative/inpaint")
      .attach("image", imgBuf, {
        filename: "test.png",
        contentType: "image/png",
      })
      .field("prompt", "a golden retriever")
      .field("model", "flux-dev");
    expect(res.status).toBe(202);
    expect(mockMediaQueueRepo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: "flux-dev" }),
    );
  });

  it("falls back to flux-kontext for an unknown model", async () => {
    const { app, mockMediaQueueRepo } = createTestApp();
    const imgBuf = await buildSmallPng();
    const res = await request(app)
      .post("/creative/inpaint")
      .attach("image", imgBuf, {
        filename: "test.png",
        contentType: "image/png",
      })
      .field("prompt", "a golden retriever")
      .field("model", "fake-model-xyz");
    expect(res.status).toBe(202);
    expect(mockMediaQueueRepo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: "flux-kontext" }),
    );
  });
});

// ── Path-traversal regression suite (sub-issue #907) ───────────────────────
//
// These tests pin the contract of the JS-side path-resolution helpers used
// throughout the Creative Studio routes.  Each case exercises a known
// path-traversal vector and asserts the helper rejects it (or contains it
// inside SAFE_BASE).  Running this suite against a build where the
// startsWith(SAFE_BASE) check or the realpath() symlink resolution has been
// reverted causes one or more cases to fail.
describe("creative path-traversal helpers (sub-issue #907)", () => {
  const galleryDir = path.join(os.homedir(), ".openzigs", "gallery");
  let traversalTmpDir: string;

  beforeEach(() => {
    fs.mkdirSync(galleryDir, { recursive: true });
    traversalTmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "creative-traversal-"),
    );
  });

  afterEach(() => {
    fs.rmSync(traversalTmpDir, { recursive: true, force: true });
  });

  describe("validatePath", () => {
    it("rejects parent-directory traversal", () => {
      expect(() => validatePath("../../etc/passwd")).toThrow(
        /Path not allowed/,
      );
    });

    it("rejects an absolute POSIX path outside SAFE_BASE", () => {
      expect(() => validatePath("/etc/passwd")).toThrow(/Path not allowed/);
    });

    it("rejects a Windows drive-letter path outside SAFE_BASE", () => {
      // path.resolve normalises this on both POSIX and Windows; on POSIX it
      // becomes a relative-looking string that still resolves outside
      // SAFE_BASE because the cwd of the test isn't ~/.openzigs.
      expect(() => validatePath("C:\\Windows\\System32\\drivers\\etc\\hosts"))
        .toThrow(/Path not allowed/);
    });

    it("rejects a path containing a NUL byte", () => {
      expect(() => validatePath(`${SAFE_BASE}/foo\x00.png`)).toThrow(
        /null bytes/,
      );
    });

    it("rejects a non-string input", () => {
      // A regression where typeof check is removed would let undefined / null
      // / objects sneak past and crash deeper in path.resolve.
      // @ts-expect-error — exercising the runtime guard.
      expect(() => validatePath(undefined)).toThrow();
    });

    it("accepts a happy-path file inside SAFE_BASE", () => {
      const target = path.join(SAFE_BASE, "gallery");
      const out = validatePath(target);
      // realpath() may rewrite the prefix on macOS (/var → /private/var) but
      // the result must still resolve under the canonical SAFE_BASE.
      expect(
        out === fs.realpathSync(SAFE_BASE) ||
          out.startsWith(fs.realpathSync(SAFE_BASE) + path.sep),
      ).toBe(true);
    });

    it("rejects a symlink inside SAFE_BASE that escapes via realpath", () => {
      // Plant a symlink under the gallery that points at a directory outside
      // SAFE_BASE.  The helper must follow the link via realpath and refuse
      // to return a path whose canonical form lives outside SAFE_BASE.
      // Skipping on Windows when symlink creation requires elevation.
      const linkPath = path.join(galleryDir, `escape-link-${Date.now()}`);
      const targetOutside = traversalTmpDir; // outside ~/.openzigs
      try {
        fs.symlinkSync(targetOutside, linkPath, "dir");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // EPERM on Windows without Developer Mode / admin → skip case.
        if (/EPERM|operation not permitted/i.test(message)) return;
        throw err;
      }
      try {
        expect(() => validatePath(linkPath)).toThrow(/Path not allowed/);
      } finally {
        fs.unlinkSync(linkPath);
      }
    });
  });

  describe("resolveImagePath", () => {
    it("rejects a relative path that traverses out of the gallery", () => {
      expect(() => resolveImagePath("../../etc/passwd")).toThrow(
        /Path not allowed/,
      );
    });

    it("rejects an absolute path outside SAFE_BASE", () => {
      expect(() => resolveImagePath("/etc/passwd")).toThrow(/Path not allowed/);
    });

    it("rejects a NUL byte in the relative path", () => {
      expect(() => resolveImagePath("foo\x00.png")).toThrow(/null bytes/);
    });

    it("resolves a relative gallery file inside SAFE_BASE", () => {
      const out = resolveImagePath("legit.png");
      const realBase = fs.realpathSync(SAFE_BASE);
      expect(out.startsWith(realBase + path.sep)).toBe(true);
    });
  });
});
