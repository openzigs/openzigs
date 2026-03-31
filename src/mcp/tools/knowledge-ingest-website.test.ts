import { describe, it, expect, vi } from "vitest";
import { createIngestWebsiteTool } from "./knowledge-ingest-website.js";
import type { KnowledgeIngestionService } from "../../knowledge/knowledge-service.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockKnowledgeService(): KnowledgeIngestionService {
  return {
    ingestText: vi.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeIngestionService;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("createIngestWebsiteTool", () => {
  it("creates a tool with correct metadata", () => {
    const tool = createIngestWebsiteTool(null);
    expect(tool.name).toBe("ingest-website");
    expect(tool.category).toBe("knowledge");
    expect(tool.riskLevel).toBe("medium");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("rejects SSRF URLs", async () => {
    const tool = createIngestWebsiteTool(null);
    const result = await tool.handler({ url: "http://localhost/admin" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("rejects internal IP addresses", async () => {
    const tool = createIngestWebsiteTool(null);
    const result = await tool.handler({ url: "http://10.0.0.1/" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SSRF blocked");
  });

  it("returns error when knowledge service is null", async () => {
    const tool = createIngestWebsiteTool(null);
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Knowledge service is not available");
  });

  it("returns error when firecrawl is disabled", async () => {
    const ks = makeMockKnowledgeService();
    const tool = createIngestWebsiteTool(ks);
    // getFirecrawlClient returns a client with enabled=false by default
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not enabled");
  });

  it("validates URL schema", async () => {
    const tool = createIngestWebsiteTool(null);
    await expect(tool.handler({ url: "not-a-url" })).rejects.toThrow();
  });
});
