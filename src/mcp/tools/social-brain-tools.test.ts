import { describe, expect, it, vi } from "vitest";
import { createSocialBrainTools } from "./social-brain-tools.js";

function createMockRepository() {
  return {
    listContacts: vi.fn().mockReturnValue({ data: [{ id: "c1", username: "testuser", platform: "twitter" }], total: 1 }),
    getMessages: vi.fn().mockReturnValue([{ id: "m1", text: "Hello", direction: "inbound" }]),
    addTag: vi.fn().mockReturnValue({ id: "c1", tags: ["vip"] }),
    getStats: vi.fn().mockReturnValue({ totalContacts: 10, activeHandoffs: 2, totalMessages: 100 }),
  };
}

function createMockHandoffManager() {
  return {
    closeHandoff: vi.fn().mockResolvedValue(true),
  };
}

describe("social-brain-tools", () => {
  it("returns 5 tool definitions", () => {
    const tools = createSocialBrainTools({ repository: createMockRepository() as never, handoffManager: createMockHandoffManager() as never });
    expect(tools).toHaveLength(5);
  });

  it("returns correct tool names", () => {
    const tools = createSocialBrainTools({ repository: createMockRepository() as never, handoffManager: createMockHandoffManager() as never });
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "social-crm-lookup", "social-crm-history", "social-crm-tag",
      "social-close-handoff", "social-brain-stats",
    ]);
  });

  it("all tools have category social", () => {
    const tools = createSocialBrainTools({ repository: createMockRepository() as never, handoffManager: createMockHandoffManager() as never });
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  describe("social-crm-lookup handler", () => {
    it("calls listContacts with username search", async () => {
      const repo = createMockRepository();
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-crm-lookup")!.handler;
      const result = await handler({ username: "testuser" });
      expect(repo.listContacts).toHaveBeenCalledWith(expect.objectContaining({ search: "testuser" }));
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
    });

    it("calls listContacts with search query", async () => {
      const repo = createMockRepository();
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-crm-lookup")!.handler;
      await handler({ search: "test", platform: "twitter" });
      expect(repo.listContacts).toHaveBeenCalledWith(expect.objectContaining({ search: "test", platform: "twitter" }));
    });
  });

  describe("social-crm-history handler", () => {
    it("calls getMessages with contactId", async () => {
      const repo = createMockRepository();
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-crm-history")!.handler;
      const result = await handler({ contactId: "c1", limit: 5 });
      expect(repo.getMessages).toHaveBeenCalledWith("c1", 5);
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
    });
  });

  describe("social-crm-tag handler", () => {
    it("adds tag to contact", async () => {
      const repo = createMockRepository();
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-crm-tag")!.handler;
      const result = await handler({ contactId: "c1", tag: "vip" });
      expect(repo.addTag).toHaveBeenCalledWith("c1", "vip");
      expect(result.isError).toBeUndefined();
    });

    it("returns error when contact not found", async () => {
      const repo = createMockRepository();
      repo.addTag.mockReturnValue(null);
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-crm-tag")!.handler;
      const result = await handler({ contactId: "missing", tag: "vip" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });
  });

  describe("social-close-handoff handler", () => {
    it("closes active handoff", async () => {
      const hm = createMockHandoffManager();
      const tools = createSocialBrainTools({ repository: createMockRepository() as never, handoffManager: hm as never });
      const handler = tools.find((t) => t.name === "social-close-handoff")!.handler;
      const result = await handler({ contactId: "c1", resolution: "resolved" });
      expect(hm.closeHandoff).toHaveBeenCalledWith("c1", "resolved");
      expect(result.text).toContain("closed");
    });

    it("returns error when no active handoff", async () => {
      const hm = createMockHandoffManager();
      hm.closeHandoff.mockResolvedValue(false);
      const tools = createSocialBrainTools({ repository: createMockRepository() as never, handoffManager: hm as never });
      const handler = tools.find((t) => t.name === "social-close-handoff")!.handler;
      const result = await handler({ contactId: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("No active handoff");
    });
  });

  describe("social-brain-stats handler", () => {
    it("returns stats JSON", async () => {
      const repo = createMockRepository();
      const tools = createSocialBrainTools({ repository: repo as never, handoffManager: createMockHandoffManager() as never });
      const handler = tools.find((t) => t.name === "social-brain-stats")!.handler;
      const result = await handler({});
      expect(repo.getStats).toHaveBeenCalled();
      const parsed = JSON.parse(result.text);
      expect(parsed.totalContacts).toBe(10);
    });
  });
});
