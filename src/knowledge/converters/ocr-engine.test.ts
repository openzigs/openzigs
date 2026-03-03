import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// We need to reset module state between tests since the module uses singletons
describe("ocr-engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("isTesseractAvailable", () => {
    it("returns true when tesseract.js is importable", async () => {
      const mockCreateWorker = vi.fn();
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable } = await import("./ocr-engine.js");
      const result = await isTesseractAvailable();
      expect(result).toBe(true);
    });

    it("returns false when tesseract.js import fails", async () => {
      vi.doMock("tesseract.js", () => {
        throw new Error("Module not found");
      });

      const { isTesseractAvailable } = await import("./ocr-engine.js");
      const result = await isTesseractAvailable();
      expect(result).toBe(false);
    });

    it("caches the probe result on subsequent calls", async () => {
      const mockCreateWorker = vi.fn();
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable } = await import("./ocr-engine.js");
      const first = await isTesseractAvailable();
      const second = await isTesseractAvailable();
      expect(first).toBe(true);
      expect(second).toBe(true);
    });

    it("returns false when module lacks createWorker function", async () => {
      vi.doMock("tesseract.js", () => ({ somethingElse: 42 }));

      const { isTesseractAvailable } = await import("./ocr-engine.js");
      const result = await isTesseractAvailable();
      expect(result).toBe(false);
    });
  });

  describe("getOcrWorker", () => {
    it("throws when tesseract.js is not available", async () => {
      vi.doMock("tesseract.js", () => {
        throw new Error("not installed");
      });

      const { isTesseractAvailable, getOcrWorker } = await import("./ocr-engine.js");
      await isTesseractAvailable();
      await expect(getOcrWorker()).rejects.toThrow("tesseract.js is not available");
    });

    it("creates a worker on first call and reuses it", async () => {
      const mockWorker = {
        recognize: vi.fn(),
        terminate: vi.fn(),
      };
      const mockCreateWorker = vi.fn().mockResolvedValue(mockWorker);
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable, getOcrWorker } = await import("./ocr-engine.js");
      await isTesseractAvailable();

      const w1 = await getOcrWorker();
      const w2 = await getOcrWorker();
      expect(w1).toBe(w2);
      expect(mockCreateWorker).toHaveBeenCalledTimes(1);
      expect(mockCreateWorker).toHaveBeenCalledWith("eng");
    });
  });

  describe("ocrImage", () => {
    it("recognizes text from an image buffer", async () => {
      const mockWorker = {
        recognize: vi.fn().mockResolvedValue({ data: { text: "Hello World" } }),
        terminate: vi.fn(),
      };
      const mockCreateWorker = vi.fn().mockResolvedValue(mockWorker);
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable, ocrImage } = await import("./ocr-engine.js");
      await isTesseractAvailable();

      const result = await ocrImage(Buffer.from("fake-image"));
      expect(result).toBe("Hello World");
      expect(mockWorker.recognize).toHaveBeenCalledWith(Buffer.from("fake-image"));
    });

    it("recognizes text from a file path string", async () => {
      const mockWorker = {
        recognize: vi.fn().mockResolvedValue({ data: { text: "File content" } }),
        terminate: vi.fn(),
      };
      const mockCreateWorker = vi.fn().mockResolvedValue(mockWorker);
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable, ocrImage } = await import("./ocr-engine.js");
      await isTesseractAvailable();

      const result = await ocrImage("/path/to/image.png");
      expect(result).toBe("File content");
    });
  });

  describe("terminateOcrEngine", () => {
    it("terminates the worker and clears it", async () => {
      const mockWorker = {
        recognize: vi.fn(),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
      const mockCreateWorker = vi.fn().mockResolvedValue(mockWorker);
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable, getOcrWorker, terminateOcrEngine } = await import("./ocr-engine.js");
      await isTesseractAvailable();
      await getOcrWorker();
      await terminateOcrEngine();

      expect(mockWorker.terminate).toHaveBeenCalledOnce();
    });

    it("does nothing when no worker exists", async () => {
      vi.doMock("tesseract.js", () => {
        throw new Error("not installed");
      });

      const { terminateOcrEngine } = await import("./ocr-engine.js");
      // Should not throw
      await terminateOcrEngine();
    });

    it("allows a new worker to be created after termination", async () => {
      const mockWorker1 = { recognize: vi.fn(), terminate: vi.fn().mockResolvedValue(undefined) };
      const mockWorker2 = { recognize: vi.fn(), terminate: vi.fn().mockResolvedValue(undefined) };
      const mockCreateWorker = vi.fn()
        .mockResolvedValueOnce(mockWorker1)
        .mockResolvedValueOnce(mockWorker2);
      vi.doMock("tesseract.js", () => ({ createWorker: mockCreateWorker }));

      const { isTesseractAvailable, getOcrWorker, terminateOcrEngine } = await import("./ocr-engine.js");
      await isTesseractAvailable();

      const w1 = await getOcrWorker();
      expect(w1).toBe(mockWorker1);

      await terminateOcrEngine();

      const w2 = await getOcrWorker();
      expect(w2).toBe(mockWorker2);
      expect(mockCreateWorker).toHaveBeenCalledTimes(2);
    });
  });
});
