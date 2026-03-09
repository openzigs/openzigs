import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSocialMediaTools } from "./social-media-tools.js";

describe("social-media-tools", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns 5 tool definitions", () => {
    const tools = createSocialMediaTools({});
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("social-post");
    expect(names).toContain("social-timeline");
    expect(names).toContain("social-profile");
    expect(names).toContain("pinterest-boards");
    expect(names).toContain("pinterest-pins");
  });

  it("all tools have category social", () => {
    const tools = createSocialMediaTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  describe("social-post handler", () => {
    it("returns error when sidecar URL is not configured", async () => {
      const tools = createSocialMediaTools({});
      const handler = tools.find((t) => t.name === "social-post")!.handler;
      const result = await handler({ platform: "linkedin", content: "Hello" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not configured");
    });

    it("calls sidecar and returns result on success", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "Posted successfully" }),
      });

      const tools = createSocialMediaTools({ linkedinSidecarUrl: "http://localhost:5001" });
      const handler = tools.find((t) => t.name === "social-post")!.handler;
      const result = await handler({ platform: "linkedin", content: "Hello" });
      expect(result.text).toContain("Posted successfully");
      expect(result.isError).toBeUndefined();
    });

    it("returns error when sidecar returns non-ok response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const tools = createSocialMediaTools({ twitterSidecarUrl: "http://localhost:5002" });
      const handler = tools.find((t) => t.name === "social-post")!.handler;
      const result = await handler({ platform: "twitter", content: "Hello" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Sidecar error");
    });

    it("handles fetch failure gracefully", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const tools = createSocialMediaTools({ facebookSidecarUrl: "http://localhost:5003" });
      const handler = tools.find((t) => t.name === "social-post")!.handler;
      const result = await handler({ platform: "facebook", content: "Hello" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Connection refused");
    });
  });

  describe("social-timeline handler", () => {
    it("returns error when sidecar not configured", async () => {
      const tools = createSocialMediaTools({});
      const handler = tools.find((t) => t.name === "social-timeline")!.handler;
      const result = await handler({ platform: "twitter" });
      expect(result.isError).toBe(true);
    });

    it("returns timeline data on success", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: JSON.stringify([{ id: "1", text: "Tweet" }]) }),
      });

      const tools = createSocialMediaTools({ twitterSidecarUrl: "http://localhost:5002" });
      const handler = tools.find((t) => t.name === "social-timeline")!.handler;
      const result = await handler({ platform: "twitter", count: 10 });
      expect(result.isError).toBeUndefined();
    });
  });

  describe("social-profile handler", () => {
    it("returns error when sidecar not configured", async () => {
      const tools = createSocialMediaTools({});
      const handler = tools.find((t) => t.name === "social-profile")!.handler;
      const result = await handler({ platform: "linkedin" });
      expect(result.isError).toBe(true);
    });

    it("returns profile data on success", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: JSON.stringify({ name: "Test User" }) }),
      });

      const tools = createSocialMediaTools({ linkedinSidecarUrl: "http://localhost:5001" });
      const handler = tools.find((t) => t.name === "social-profile")!.handler;
      const result = await handler({ platform: "linkedin" });
      expect(result.isError).toBeUndefined();
    });
  });

  describe("pinterest-boards handler", () => {
    it("returns error when no token configured", async () => {
      const origToken = process.env.PINTEREST_ACCESS_TOKEN;
      delete process.env.PINTEREST_ACCESS_TOKEN;
      try {
        const tools = createSocialMediaTools({});
        const handler = tools.find((t) => t.name === "pinterest-boards")!.handler;
        const result = await handler({ action: "list" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
      } finally {
        if (origToken !== undefined) process.env.PINTEREST_ACCESS_TOKEN = origToken;
      }
    });

    it("calls Pinterest API v5 directly when token exists", async () => {
      const origToken = process.env.PINTEREST_ACCESS_TOKEN;
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      try {
        const tools = createSocialMediaTools({});
        const handler = tools.find((t) => t.name === "pinterest-boards")!.handler;
        const result = await handler({ action: "list" });
        expect(result.isError).toBeUndefined();
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("api.pinterest.com/v5/boards"),
          expect.objectContaining({ method: "GET" }),
        );
      } finally {
        if (origToken !== undefined) process.env.PINTEREST_ACCESS_TOKEN = origToken;
        else delete process.env.PINTEREST_ACCESS_TOKEN;
      }
    });
  });

  describe("pinterest-pins handler", () => {
    it("returns error when no token configured", async () => {
      const origToken = process.env.PINTEREST_ACCESS_TOKEN;
      delete process.env.PINTEREST_ACCESS_TOKEN;
      try {
        const tools = createSocialMediaTools({});
        const handler = tools.find((t) => t.name === "pinterest-pins")!.handler;
        const result = await handler({ action: "list", boardId: "123" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("PINTEREST_ACCESS_TOKEN");
      } finally {
        if (origToken !== undefined) process.env.PINTEREST_ACCESS_TOKEN = origToken;
      }
    });

    it("calls Pinterest API v5 directly when token exists", async () => {
      const origToken = process.env.PINTEREST_ACCESS_TOKEN;
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      try {
        const tools = createSocialMediaTools({});
        const handler = tools.find((t) => t.name === "pinterest-pins")!.handler;
        const result = await handler({ action: "list", boardId: "123" });
        expect(result.isError).toBeUndefined();
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("api.pinterest.com/v5/boards/123/pins"),
          expect.objectContaining({ method: "GET" }),
        );
      } finally {
        if (origToken !== undefined) process.env.PINTEREST_ACCESS_TOKEN = origToken;
        else delete process.env.PINTEREST_ACCESS_TOKEN;
      }
    });
  });
});
