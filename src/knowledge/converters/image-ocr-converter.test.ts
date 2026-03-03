import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockIsTesseractAvailable, mockOcrImage } = vi.hoisted(() => ({
  mockIsTesseractAvailable: vi.fn(),
  mockOcrImage: vi.fn(),
}));

vi.mock("./ocr-engine.js", () => ({
  isTesseractAvailable: mockIsTesseractAvailable,
  ocrImage: mockOcrImage,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from "node:fs/promises";
import { createImageOcrConverter } from "./image-ocr-converter.js";

describe("image-ocr-converter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createImageOcrConverter — unavailable", () => {
    it("returns unavailable registration when tesseract is not installed", async () => {
      mockIsTesseractAvailable.mockResolvedValue(false);

      const reg = await createImageOcrConverter();
      expect(reg.name).toBe("image-ocr");
      expect(reg.available).toBe(false);
      expect(reg.unavailableReason).toContain("tesseract.js");
      expect(reg.extensions).toContain(".jpg");
      expect(reg.extensions).toContain(".png");
    });

    it("convert returns failure result when unavailable", async () => {
      mockIsTesseractAvailable.mockResolvedValue(false);

      const reg = await createImageOcrConverter();
      const result = await reg.convert("/path/to/image.png");

      expect(result.success).toBe(false);
      expect(result.converter).toBe("image-ocr");
      expect(result.error).toContain("not installed");
      expect(result.text).toBe("");
    });
  });

  describe("createImageOcrConverter — available", () => {
    beforeEach(() => {
      mockIsTesseractAvailable.mockResolvedValue(true);
    });

    it("returns available registration with correct extensions", async () => {
      const reg = await createImageOcrConverter();
      expect(reg.available).toBe(true);
      expect(reg.name).toBe("image-ocr");
      expect(reg.extensions).toEqual(
        expect.arrayContaining([".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp", ".gif"]),
      );
    });

    it("converts an image file successfully", async () => {
      const fakeBuffer = Buffer.from("fake-image-data");
      vi.mocked(fs.readFile).mockResolvedValue(fakeBuffer);
      mockOcrImage.mockResolvedValue("  Detected text from image  ");

      const reg = await createImageOcrConverter();
      const result = await reg.convert("/path/to/photo.jpg");

      expect(result.success).toBe(true);
      expect(result.converter).toBe("image-ocr");
      expect(result.text).toContain("# photo");
      expect(result.text).toContain("Detected text from image");
      expect(result.text).toContain("photo.jpg");
      expect(result.metadata).toEqual({
        originalFile: "photo.jpg",
        textLength: 24,
      });
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith("/path/to/photo.jpg");
      expect(mockOcrImage).toHaveBeenCalledWith(fakeBuffer);
    });

    it("returns failure when no text is detected", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("blank-image"));
      mockOcrImage.mockResolvedValue("   \n  \t  ");

      const reg = await createImageOcrConverter();
      const result = await reg.convert("/path/to/empty.png");

      expect(result.success).toBe(false);
      expect(result.error).toBe("No text detected in image");
      expect(result.text).toBe("");
    });

    it("includes OCR source metadata in output", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data"));
      mockOcrImage.mockResolvedValue("Some OCR text");

      const reg = await createImageOcrConverter();
      const result = await reg.convert("/documents/scan.tiff");

      expect(result.text).toContain("OCR (tesseract.js)");
      expect(result.text).toContain("scan.tiff");
    });

    it("strips the extension from the header name", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data"));
      mockOcrImage.mockResolvedValue("Invoice total: $42.00");

      const reg = await createImageOcrConverter();
      const result = await reg.convert("/receipts/invoice.png");

      expect(result.text).toMatch(/^# invoice\n/);
    });
  });
});
