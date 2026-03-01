import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./text-converter.js", () => ({
  createTextConverter: vi.fn(() => ({
    name: "text",
    extensions: [".txt", ".md", ".json"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "text content", success: true, converter: "text" }),
  })),
}));

vi.mock("./pdf-converter.js", () => ({
  createPdfConverter: vi.fn().mockResolvedValue({
    name: "pdf",
    extensions: [".pdf"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "pdf content", success: true, converter: "pdf" }),
  }),
}));

vi.mock("./docx-converter.js", () => ({
  createDocxConverter: vi.fn().mockResolvedValue({
    name: "docx",
    extensions: [".docx"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "docx content", success: true, converter: "docx" }),
  }),
}));

vi.mock("./xlsx-converter.js", () => ({
  createXlsxConverter: vi.fn().mockResolvedValue({
    name: "xlsx",
    extensions: [".xlsx", ".xls"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "xlsx content", success: true, converter: "xlsx" }),
  }),
}));

vi.mock("./media-converter.js", () => ({
  createMediaConverter: vi.fn().mockResolvedValue({
    name: "media",
    extensions: [".mp4", ".mp3", ".wav"],
    available: false,
    unavailableReason: "ffmpeg not found",
    convert: vi.fn().mockResolvedValue({ text: "", success: false, converter: "media" }),
  }),
}));

vi.mock("./sidecar-media-converter.js", () => ({
  createSidecarMediaConverter: vi.fn().mockResolvedValue({
    name: "sidecar-media",
    extensions: [".mp4", ".mp3", ".wav"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "transcription", success: true, converter: "sidecar-media" }),
  }),
}));

vi.mock("./image-ocr-converter.js", () => ({
  createImageOcrConverter: vi.fn().mockResolvedValue({
    name: "image-ocr",
    extensions: [".png", ".jpg", ".jpeg"],
    available: true,
    convert: vi.fn().mockResolvedValue({ text: "ocr content", success: true, converter: "image-ocr" }),
  }),
}));

vi.mock("./ocr-engine.js", () => ({
  terminateOcrEngine: vi.fn().mockResolvedValue(undefined),
}));

import { ConverterRegistry, createDefaultRegistry, shutdownConverters } from "./converter-registry.js";
import { terminateOcrEngine } from "./ocr-engine.js";
import type { ConverterRegistration } from "./types.js";

describe("ConverterRegistry", () => {
  let registry: ConverterRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ConverterRegistry();
  });

  describe("register", () => {
    it("registers a converter for given extensions", () => {
      const reg: ConverterRegistration = {
        name: "test",
        extensions: [".txt", ".md"],
        available: true,
        convert: vi.fn(),
      };
      registry.register(reg);
      expect(registry.canConvert("file.txt")).toBe(true);
      expect(registry.canConvert("file.md")).toBe(true);
    });

    it("normalizes extensions without leading dot", () => {
      const reg: ConverterRegistration = {
        name: "test",
        extensions: ["txt"],
        available: true,
        convert: vi.fn(),
      };
      registry.register(reg);
      expect(registry.canConvert("file.txt")).toBe(true);
    });

    it("handles case-insensitive extensions", () => {
      const reg: ConverterRegistration = {
        name: "test",
        extensions: [".TXT"],
        available: true,
        convert: vi.fn(),
      };
      registry.register(reg);
      expect(registry.canConvert("file.txt")).toBe(true);
    });
  });

  describe("canConvert", () => {
    it("returns false for unregistered extensions", () => {
      expect(registry.canConvert("file.xyz")).toBe(false);
    });

    it("returns false for unavailable converters", () => {
      registry.register({
        name: "test",
        extensions: [".xyz"],
        available: false,
        convert: vi.fn(),
      });
      expect(registry.canConvert("file.xyz")).toBe(false);
    });

    it("returns true for available converters", () => {
      registry.register({
        name: "test",
        extensions: [".xyz"],
        available: true,
        convert: vi.fn(),
      });
      expect(registry.canConvert("file.xyz")).toBe(true);
    });
  });

  describe("hasConverter", () => {
    it("returns true even for unavailable converters", () => {
      registry.register({
        name: "test",
        extensions: [".xyz"],
        available: false,
        convert: vi.fn(),
      });
      expect(registry.hasConverter("file.xyz")).toBe(true);
    });

    it("returns false for unregistered extensions", () => {
      expect(registry.hasConverter("file.xyz")).toBe(false);
    });
  });

  describe("getConverter", () => {
    it("returns the registration for a known extension", () => {
      const reg: ConverterRegistration = {
        name: "test",
        extensions: [".xyz"],
        available: true,
        convert: vi.fn(),
      };
      registry.register(reg);
      expect(registry.getConverter("file.xyz")).toBe(reg);
    });

    it("returns undefined for unknown extensions", () => {
      expect(registry.getConverter("file.xyz")).toBeUndefined();
    });
  });

  describe("convert", () => {
    it("converts a file using the registered converter", async () => {
      const mockConvert = vi.fn().mockResolvedValue({ text: "hello", success: true, converter: "test" });
      registry.register({
        name: "test",
        extensions: [".txt"],
        available: true,
        convert: mockConvert,
      });
      const result = await registry.convert("file.txt");
      expect(result.success).toBe(true);
      expect(result.text).toBe("hello");
      expect(mockConvert).toHaveBeenCalledWith("file.txt");
    });

    it("returns error for unregistered extension", async () => {
      const result = await registry.convert("file.xyz");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No converter registered");
    });

    it("returns error for unavailable converter", async () => {
      registry.register({
        name: "test",
        extensions: [".xyz"],
        available: false,
        unavailableReason: "not installed",
        convert: vi.fn(),
      });
      const result = await registry.convert("file.xyz");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });

    it("returns error when converter throws", async () => {
      registry.register({
        name: "test",
        extensions: [".txt"],
        available: true,
        convert: vi.fn().mockRejectedValue(new Error("parse failed")),
      });
      const result = await registry.convert("file.txt");
      expect(result.success).toBe(false);
      expect(result.error).toContain("parse failed");
    });

    it("handles non-Error thrown values", async () => {
      registry.register({
        name: "test",
        extensions: [".txt"],
        available: true,
        convert: vi.fn().mockRejectedValue("string error"),
      });
      const result = await registry.convert("file.txt");
      expect(result.success).toBe(false);
      expect(result.error).toContain("string error");
    });

    it("returns unavailable message without explicit reason", async () => {
      registry.register({
        name: "test",
        extensions: [".xyz"],
        available: false,
        convert: vi.fn(),
      });
      const result = await registry.convert("file.xyz");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
    });
  });

  describe("listConverters", () => {
    it("lists all registered converters", () => {
      registry.register({ name: "a", extensions: [".txt"], available: true, convert: vi.fn() });
      registry.register({ name: "b", extensions: [".pdf"], available: false, unavailableReason: "missing", convert: vi.fn() });
      const list = registry.listConverters();
      expect(list).toHaveLength(2);
      expect(list.find((c) => c.name === "a")?.available).toBe(true);
      expect(list.find((c) => c.name === "b")?.reason).toBe("missing");
    });

    it("deduplicates converters registered for multiple extensions", () => {
      registry.register({ name: "test", extensions: [".txt", ".md"], available: true, convert: vi.fn() });
      const list = registry.listConverters();
      expect(list).toHaveLength(1);
      expect(list[0].extensions).toContain(".txt");
      expect(list[0].extensions).toContain(".md");
    });

    it("returns empty list for empty registry", () => {
      expect(registry.listConverters()).toHaveLength(0);
    });
  });
});

describe("createDefaultRegistry", () => {
  it("creates a registry with all built-in converters", async () => {
    const registry = await createDefaultRegistry();
    const list = registry.listConverters();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((c) => c.name === "text")).toBe(true);
    expect(list.some((c) => c.name === "pdf")).toBe(true);
  });

  it("registers sidecar media converter when audioSidecarUrl is provided", async () => {
    const registry = await createDefaultRegistry({ audioSidecarUrl: "http://localhost:8000" });
    expect(registry.canConvert("test.mp4")).toBe(true);
  });

  it("falls back to whisper-node media converter when no sidecar", async () => {
    const registry = await createDefaultRegistry();
    const list = registry.listConverters();
    expect(list.some((c) => c.name === "media")).toBe(true);
  });
});

describe("shutdownConverters", () => {
  it("calls terminateOcrEngine", async () => {
    await shutdownConverters();
    expect(terminateOcrEngine).toHaveBeenCalled();
  });
});
