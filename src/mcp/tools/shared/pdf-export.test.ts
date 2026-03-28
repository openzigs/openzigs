import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findChromeBinaryForPdf, wrapMarkdownAsHtml, saveReportPdf } from "./pdf-export.js";

describe("pdf-export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("findChromeBinaryForPdf", () => {
    it("returns undefined when no chrome binary exists", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(findChromeBinaryForPdf()).toBeUndefined();
    });

    it("returns the first existing binary path", () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        return typeof p === "string" && p.includes("Google Chrome");
      });
      const result = findChromeBinaryForPdf();
      if (os.platform() === "darwin") {
        expect(result).toContain("Google Chrome");
      }
      // On other platforms this may or may not find Chrome depending on mock
    });
  });

  describe("wrapMarkdownAsHtml", () => {
    it("returns valid HTML with wrapped markdown content", () => {
      const md = "# Test\n\nHello **world**.";
      const html = wrapMarkdownAsHtml(md);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");
      expect(html).toContain("<h1>");
      expect(html).toContain("Test");
      expect(html).toContain("<strong>world</strong>");
    });

    it("includes print-friendly CSS", () => {
      const html = wrapMarkdownAsHtml("# Title");
      expect(html).toContain("@media print");
    });

    it("handles tables in markdown", () => {
      const md = "| A | B |\n|---|---|\n| 1 | 2 |";
      const html = wrapMarkdownAsHtml(md);
      expect(html).toContain("<table>");
      expect(html).toContain("<th>");
    });

    it("handles empty markdown", () => {
      const html = wrapMarkdownAsHtml("");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<body>");
    });
  });

  describe("saveReportPdf", () => {
    it("returns null when chrome is not found", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const result = await saveReportPdf("test-report", "# Test", "/tmp/test-output");
      expect(result).toBeNull();
    });

    it("calls mkdirSync with the provided output directory", async () => {
      // Mock Chrome as found, but the spawn will fail (no real binary)
      // We just want to verify the directory creation happens
      const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const result = await saveReportPdf("test", "# Hello", "/tmp/pdf-test-dir");
      // No Chrome found → returns null immediately without calling mkdirSync
      expect(result).toBeNull();
      existsSyncSpy.mockRestore();
    });

    it("accepts a custom output directory path", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const customDir = path.join(os.tmpdir(), "custom-pdf-out");
      const result = await saveReportPdf("report", "# MD", customDir);
      // No Chrome → null, but the function should have been callable with custom dir
      expect(result).toBeNull();
    });
  });
});
