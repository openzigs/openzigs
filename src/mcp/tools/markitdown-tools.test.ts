import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMarkItDownTools } from "./markitdown-tools.js";

describe("MarkItDown Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create one tool: convert-to-markdown", () => {
    const tools = createMarkItDownTools({ sidecarUrl: "http://localhost:5301" });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("convert-to-markdown");
    expect(tools[0].category).toBe("documents");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("should return error when sidecar URL is not configured", async () => {
    const tools = createMarkItDownTools({});
    const result = await tools[0].handler({ filePath: "/data/test.pdf" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not configured");
  });

  it("should call sidecar with correct parameters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "# Converted Markdown\n\nContent here." }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createMarkItDownTools({ sidecarUrl: "http://localhost:5301" });
    const result = await tools[0].handler({ filePath: "/data/report.pdf" });

    expect(result.text).toBe("# Converted Markdown\n\nContent here.");
    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:5301/mcp");
    const body = JSON.parse(opts.body);
    expect(body.method).toBe("convert_to_markdown");
    expect(body.params.file_path).toBe("/data/report.pdf");
  });

  it("should handle sidecar connection errors gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const tools = createMarkItDownTools({ sidecarUrl: "http://localhost:5301" });
    const result = await tools[0].handler({ filePath: "/data/test.pdf" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Failed to reach MarkItDown sidecar");
  });

  it("should pass OCR options when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "OCR text" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createMarkItDownTools({ sidecarUrl: "http://localhost:5301" });
    await tools[0].handler({
      filePath: "/data/image.png",
      options: { enableOcr: true },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.enableOcr).toBe(true);
  });
});
