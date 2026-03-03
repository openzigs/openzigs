import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDocxConverter } from "./docx-converter.js";

const mockExtractRawText = vi.fn();

vi.mock("mammoth", () => ({
  default: {
    extractRawText: (...args: unknown[]) => mockExtractRawText(...args),
  },
}));

describe("createDocxConverter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an available converter when mammoth is installed", async () => {
    const reg = await createDocxConverter();
    expect(reg.name).toBe("docx");
    expect(reg.extensions).toEqual([".docx"]);
    expect(reg.available).toBe(true);
  });

  it("converts a docx file successfully", async () => {
    mockExtractRawText.mockResolvedValue({
      value: "Hello World\n\nThis is a test document.",
      messages: [],
    });

    const reg = await createDocxConverter();
    const result = await reg.convert("/docs/report.docx");

    expect(result.success).toBe(true);
    expect(result.converter).toBe("docx");
    expect(result.text).toContain("# report");
    expect(result.text).toContain("Hello World");
    expect(result.text).toContain("This is a test document.");
    expect(result.metadata?.messageCount).toBe(0);
  });

  it("passes file path to mammoth", async () => {
    mockExtractRawText.mockResolvedValue({ value: "text", messages: [] });

    const reg = await createDocxConverter();
    await reg.convert("/docs/my-file.docx");

    expect(mockExtractRawText).toHaveBeenCalledWith({ path: "/docs/my-file.docx" });
  });

  it("trims whitespace from extracted text", async () => {
    mockExtractRawText.mockResolvedValue({
      value: "  text with whitespace  \n\n",
      messages: [],
    });

    const reg = await createDocxConverter();
    const result = await reg.convert("/docs/test.docx");

    expect(result.text).toBe("# test\n\ntext with whitespace");
  });

  it("strips .docx from filename for header", async () => {
    mockExtractRawText.mockResolvedValue({ value: "content", messages: [] });

    const reg = await createDocxConverter();
    const result = await reg.convert("/path/to/My Document.docx");

    expect(result.text.startsWith("# My Document\n\n")).toBe(true);
  });

  it("includes message count in metadata", async () => {
    mockExtractRawText.mockResolvedValue({
      value: "text",
      messages: [{ type: "warning", message: "something" }, { type: "warning", message: "else" }],
    });

    const reg = await createDocxConverter();
    const result = await reg.convert("/docs/warnings.docx");

    expect(result.metadata?.messageCount).toBe(2);
  });

  it("propagates errors from mammoth", async () => {
    mockExtractRawText.mockRejectedValue(new Error("Corrupt file"));

    const reg = await createDocxConverter();
    await expect(reg.convert("/docs/bad.docx")).rejects.toThrow("Corrupt file");
  });
});
