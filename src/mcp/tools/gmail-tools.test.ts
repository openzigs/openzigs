import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGmailTools } from "./gmail-tools.js";

describe("Gmail Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create four tools", () => {
    const tools = createGmailTools({ sidecarUrl: "http://localhost:5302" });
    expect(tools).toHaveLength(4);

    const names = tools.map((t) => t.name);
    expect(names).toContain("gmail-search");
    expect(names).toContain("gmail-read");
    expect(names).toContain("gmail-draft");
    expect(names).toContain("gmail-send");
  });

  it("should assign correct risk levels", () => {
    const tools = createGmailTools({ sidecarUrl: "http://localhost:5302" });
    const riskMap = Object.fromEntries(tools.map((t) => [t.name, t.riskLevel]));

    expect(riskMap["gmail-search"]).toBe("low");
    expect(riskMap["gmail-read"]).toBe("low");
    expect(riskMap["gmail-draft"]).toBe("medium");
    expect(riskMap["gmail-send"]).toBe("high");
  });

  it("should categorize all tools as documents", () => {
    const tools = createGmailTools({ sidecarUrl: "http://localhost:5302" });
    for (const tool of tools) {
      expect(tool.category).toBe("documents");
    }
  });

  it("should return not-configured error when sidecar URL missing", async () => {
    const tools = createGmailTools({});
    for (const tool of tools) {
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not configured");
    }
  });

  it("gmail-search should call sidecar with query parameters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: [{ id: "msg1", subject: "Test Email" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createGmailTools({ sidecarUrl: "http://localhost:5302" });
    const searchTool = tools.find((t) => t.name === "gmail-search")!;
    const result = await searchTool.handler({ query: "from:test@example.com", maxResults: 5 });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("gmail_search");
    expect(body.params.query).toBe("from:test@example.com");
    expect(body.params.maxResults).toBe(5);
  });

  it("gmail-send should properly proxy to sidecar", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { messageId: "sent-1", status: "sent" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createGmailTools({ sidecarUrl: "http://localhost:5302" });
    const sendTool = tools.find((t) => t.name === "gmail-send")!;
    const result = await sendTool.handler({
      to: "user@example.com",
      subject: "Hello",
      body: "Test message",
    });

    expect(result.isError).toBeUndefined();
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.method).toBe("gmail_send");
    expect(sentBody.params.to).toBe("user@example.com");
    expect(sentBody.params.subject).toBe("Hello");
  });
});
