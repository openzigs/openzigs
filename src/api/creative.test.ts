import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createCreativeRouter } from "./creative.js";

// Create a tiny test image in a temp directory
let tmpDir: string;
let testImagePath: string;
let testWatermarkPath: string;

function createTestApp() {
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
    }),
  );
  return app;
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

    app = createTestApp();
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
