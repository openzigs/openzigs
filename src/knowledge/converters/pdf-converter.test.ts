import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetText = vi.fn();
const MockPDFParse = vi.fn().mockImplementation(() => ({ getText: mockGetText }));

vi.mock("pdf-parse", () => ({
  PDFParse: MockPDFParse,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    mkdtemp: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./ocr-engine.js", () => ({
  isTesseractAvailable: vi.fn(),
  ocrImage: vi.fn(),
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { isTesseractAvailable, ocrImage } from "./ocr-engine.js";
import { createPdfConverter } from "./pdf-converter.js";

describe("pdf-converter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OCR stack
    vi.mocked(isTesseractAvailable).mockResolvedValue(false);
    // execFile callback: magick/gs not available
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === "function") cb(new Error("not found"), "", "");
      return {} as any;
    });
  });

  it("returns available converter when pdf-parse is installed", async () => {
    mockGetText.mockResolvedValue({ pages: ["page1"], text: "Hello PDF", total: 1 });
    const reg = await createPdfConverter();
    expect(reg.name).toBe("pdf");
    expect(reg.available).toBe(true);
    expect(reg.extensions).toEqual([".pdf"]);
  });

  it("extracts text from a normal PDF", async () => {
    const buf = Buffer.from("fake-pdf-content");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({ pages: ["Page 1 text"], text: "Page 1 text", total: 1 });

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/test.pdf");

    expect(result.success).toBe(true);
    expect(result.converter).toBe("pdf");
    expect(result.text).toContain("test");
    expect(result.text).toContain("Page 1 text");
    expect(result.metadata).toEqual({ pages: 1 });
  });

  it("strips page separator markers from text", async () => {
    const buf = Buffer.from("fake");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({
      pages: ["P1", "P2"],
      text: "Page content -- 1 of 2 -- more content -- 2 of 2 -- end",
      total: 2,
    });

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/doc.pdf");

    expect(result.success).toBe(true);
    expect(result.text).not.toContain("-- 1 of 2 --");
    expect(result.text).not.toContain("-- 2 of 2 --");
  });

  it("reports failure when scanned PDF and no OCR available", async () => {
    const buf = Buffer.from("scanned");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({ pages: [""], text: "", total: 3 });

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/scanned.pdf");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No extractable text");
    expect(result.error).toContain("OCR");
    expect(result.metadata?.scanned).toBe(true);
  });

  it("reports failure when scanned PDF and OCR produces empty text", async () => {
    // Set up OCR stack as available
    vi.mocked(isTesseractAvailable).mockResolvedValue(true);
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === "function") cb(null, "ok", "");
      return {} as any;
    });

    const buf = Buffer.from("scanned");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({ pages: [""], text: "", total: 1 });
    vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/openzigs-pdf-ocr-abc");
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(ocrImage).mockResolvedValue("");

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/scanned-empty.pdf");

    expect(result.success).toBe(false);
    expect(result.converter).toBe("pdf+ocr");
    expect(result.error).toContain("no text was recognized");
  });

  it("uses OCR fallback when text extraction is empty and OCR is available", async () => {
    // Set up full OCR stack
    vi.mocked(isTesseractAvailable).mockResolvedValue(true);
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
      if (typeof cb === "function") cb(null, "ok", "");
      return {} as any;
    });

    const buf = Buffer.from("scanned-pdf");
    vi.mocked(fs.readFile).mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.endsWith(".pdf")) return buf;
      // PNG page render
      return Buffer.from("fake-png-data");
    });
    mockGetText.mockResolvedValue({ pages: [""], text: "", total: 2 });
    vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/openzigs-pdf-ocr-xyz");
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(ocrImage).mockResolvedValue("OCR extracted text from page");

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/scanned-full.pdf");

    expect(result.success).toBe(true);
    expect(result.converter).toBe("pdf+ocr");
    expect(result.text).toContain("OCR extracted text");
    expect(result.metadata?.ocrAttempted).toBe(true);
  });

  it("includes page count in metadata header", async () => {
    const buf = Buffer.from("pdf");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({ pages: ["P1", "P2", "P3"], text: "Some text", total: 3 });

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/multi.pdf");

    expect(result.text).toContain("**Pages:** 3");
  });

  it("uses filename (without extension) as document header", async () => {
    const buf = Buffer.from("pdf");
    vi.mocked(fs.readFile).mockResolvedValue(buf);
    mockGetText.mockResolvedValue({ pages: ["P1"], text: "Content", total: 1 });

    const reg = await createPdfConverter();
    const result = await reg.convert("/tmp/my-report.pdf");

    expect(result.text).toContain("# my-report");
  });
});
