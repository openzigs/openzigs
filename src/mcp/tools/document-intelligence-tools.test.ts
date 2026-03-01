import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock docx module to avoid actual file generation
vi.mock("docx", () => ({
  Document: vi.fn().mockImplementation(() => ({})),
  Packer: {
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("fake-docx")),
  },
  Paragraph: vi.fn().mockImplementation((opts) => opts),
  HeadingLevel: {
    HEADING_1: "HEADING_1",
    HEADING_2: "HEADING_2",
    HEADING_3: "HEADING_3",
    HEADING_4: "HEADING_4",
    HEADING_5: "HEADING_5",
    HEADING_6: "HEADING_6",
  },
  TextRun: vi.fn().mockImplementation((opts) => opts),
}));

// Mock node:fs to avoid actual file operations
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from("PDF content here")),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(Buffer.from("PDF content here")),
  writeFileSync: vi.fn(),
}));

import { createDocumentIntelligenceTools } from "./document-intelligence-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("document-intelligence-tools", () => {
  it("returns 11 tool definitions", () => {
    const tools = createDocumentIntelligenceTools({});
    expect(tools).toHaveLength(11);
  });

  it("returns correct tool names", () => {
    const tools = createDocumentIntelligenceTools({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("read-pdf");
    expect(names).toContain("create-word-doc");
    expect(names).toContain("word-add-heading");
    expect(names).toContain("word-add-paragraph");
    expect(names).toContain("word-add-table");
    expect(names).toContain("word-read-doc");
    expect(names).toContain("word-to-pdf");
    expect(names).toContain("calendar-list");
    expect(names).toContain("calendar-create");
    expect(names).toContain("calendar-search");
    expect(names).toContain("calendar-freebusy");
  });

  it("all tools have category documents", () => {
    const tools = createDocumentIntelligenceTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("documents");
    }
  });

  describe("read-pdf handler", () => {
    it("extracts text from PDF file", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "read-pdf")!.handler;
      const result = await handler({ path: "/tmp/test.pdf" });
      expect(result.text).toBeDefined();
      expect(result.isError).toBeUndefined();
    });

    it("handles file not found error", async () => {
      const { readFileSync } = await import("node:fs");
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      });

      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "read-pdf")!.handler;
      const result = await handler({ path: "/nonexistent/file.pdf" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Failed to read PDF");
    });

    it("filters by query when provided", async () => {
      const { readFileSync } = await import("node:fs");
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        Buffer.from("line one\nmatching query here\nline three")
      );

      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "read-pdf")!.handler;
      const result = await handler({ path: "/tmp/test.pdf", query: "matching" });
      expect(result.text).toContain("matching");
    });
  });

  describe("create-word-doc handler", () => {
    it("creates a word document successfully", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "create-word-doc")!.handler;
      const result = await handler({ content: "# Heading\nParagraph text", output_path: "/tmp/test.docx" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("created");
    });
  });

  describe("word tools (delegating to local server)", () => {
    it("word-add-heading returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "word-add-heading")!.handler;
      const result = await handler({ text: "Test Heading" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not configured");
    });

    it("word-add-paragraph returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "word-add-paragraph")!.handler;
      const result = await handler({ text: "Test Paragraph" });
      expect(result.isError).toBe(true);
    });

    it("word-add-table returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "word-add-table")!.handler;
      const result = await handler({ headers: ["A", "B"], rows: [["1", "2"]] });
      expect(result.isError).toBe(true);
    });

    it("word-read-doc returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "word-read-doc")!.handler;
      const result = await handler({ file_path: "/tmp/test.docx" });
      expect(result.isError).toBe(true);
    });

    it("word-to-pdf returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "word-to-pdf")!.handler;
      const result = await handler({ input_path: "/tmp/test.docx" });
      expect(result.isError).toBe(true);
    });

    it("word-add-heading delegates to local server when configured", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: "Heading added" } });
      const tools = createDocumentIntelligenceTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "word-add-heading")!.handler;
      const result = await handler({ text: "Test Heading", level: 2 });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe("Heading added");
    });

    it("word tools return error when server is not running", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createDocumentIntelligenceTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "word-add-heading")!.handler;
      const result = await handler({ text: "Test" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not running");
    });
  });

  describe("calendar tools (delegating to local server)", () => {
    it("calendar-list returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "calendar-list")!.handler;
      const result = await handler({});
      expect(result.isError).toBe(true);
    });

    it("calendar-create returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "calendar-create")!.handler;
      const result = await handler({ summary: "Meeting", startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T11:00:00Z" });
      expect(result.isError).toBe(true);
    });

    it("calendar-search returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "calendar-search")!.handler;
      const result = await handler({ query: "meeting" });
      expect(result.isError).toBe(true);
    });

    it("calendar-freebusy returns error without server manager", async () => {
      const tools = createDocumentIntelligenceTools({});
      const handler = tools.find((t) => t.name === "calendar-freebusy")!.handler;
      const result = await handler({ startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T18:00:00Z" });
      expect(result.isError).toBe(true);
    });

    it("calendar-list delegates to local server when configured", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '[{"summary": "Meeting"}]' } });
      const tools = createDocumentIntelligenceTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "calendar-list")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toContain("Meeting");
    });
  });
});
