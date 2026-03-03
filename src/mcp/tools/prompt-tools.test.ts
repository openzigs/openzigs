import { describe, expect, it, vi } from "vitest";
import { createPromptTools } from "./prompt-tools.js";

const fakePrompt = {
  id: "p1",
  name: "test-prompt",
  template: "Hello {{name}}",
  description: "A test prompt",
  tags: ["test"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function createMockPromptManager() {
  return {
    create: vi.fn().mockReturnValue(fakePrompt),
    getByName: vi.fn().mockReturnValue(fakePrompt),
    list: vi.fn().mockReturnValue([fakePrompt]),
    search: vi.fn().mockReturnValue([fakePrompt]),
    update: vi.fn().mockReturnValue({ ...fakePrompt, name: "updated" }),
    delete: vi.fn().mockReturnValue(true),
    resolve: vi.fn().mockReturnValue("Hello World"),
    getById: vi.fn(),
    importTemplate: vi.fn(),
    exportTemplate: vi.fn(),
  };
}

describe("prompt-tools", () => {
  it("returns 6 tool definitions", () => {
    const tools = createPromptTools({ promptManager: createMockPromptManager() as never });
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("save-prompt");
    expect(names).toContain("get-prompt");
    expect(names).toContain("list-prompts");
    expect(names).toContain("update-prompt");
    expect(names).toContain("delete-prompt");
    expect(names).toContain("run-prompt");
  });

  it("all tools have category productivity and valid riskLevel", () => {
    const tools = createPromptTools({ promptManager: createMockPromptManager() as never });
    for (const tool of tools) {
      expect(tool.category).toBe("productivity");
      expect(["low", "medium", "high"]).toContain(tool.riskLevel);
    }
  });

  describe("save-prompt handler", () => {
    it("calls promptManager.create and returns JSON", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "save-prompt")!.handler;
      const result = await handler({ name: "test-prompt", template: "Hello {{name}}" });
      expect(pm.create).toHaveBeenCalledWith({ name: "test-prompt", template: "Hello {{name}}" });
      expect(JSON.parse(result.text)).toEqual(fakePrompt);
    });
  });

  describe("get-prompt handler", () => {
    it("returns prompt JSON when found", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "get-prompt")!.handler;
      const result = await handler({ name: "test-prompt" });
      expect(pm.getByName).toHaveBeenCalledWith("test-prompt");
      expect(JSON.parse(result.text)).toEqual(fakePrompt);
    });

    it("returns error when prompt not found", async () => {
      const pm = createMockPromptManager();
      pm.getByName.mockReturnValue(null);
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "get-prompt")!.handler;
      const result = await handler({ name: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Prompt not found");
    });
  });

  describe("list-prompts handler", () => {
    it("calls list() when no query", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "list-prompts")!.handler;
      await handler({});
      expect(pm.list).toHaveBeenCalled();
      expect(pm.search).not.toHaveBeenCalled();
    });

    it("calls search() when query is provided", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "list-prompts")!.handler;
      await handler({ query: "test" });
      expect(pm.search).toHaveBeenCalledWith("test");
      expect(pm.list).not.toHaveBeenCalled();
    });
  });

  describe("update-prompt handler", () => {
    it("calls update and returns updated prompt", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "update-prompt")!.handler;
      const result = await handler({ id: "p1", name: "updated" });
      expect(pm.update).toHaveBeenCalledWith("p1", { name: "updated" });
      expect(result.isError).toBeUndefined();
    });

    it("returns error when update throws", async () => {
      const pm = createMockPromptManager();
      pm.update.mockImplementation(() => { throw new Error("Not found"); });
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "update-prompt")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Not found");
    });
  });

  describe("delete-prompt handler", () => {
    it("returns success message when deleted", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "delete-prompt")!.handler;
      const result = await handler({ id: "p1" });
      expect(result.text).toBe("Prompt deleted");
    });

    it("returns not found when delete returns false", async () => {
      const pm = createMockPromptManager();
      pm.delete.mockReturnValue(false);
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "delete-prompt")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.text).toBe("Prompt not found");
    });
  });

  describe("run-prompt handler", () => {
    it("resolves prompt with variables and returns text", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "run-prompt")!.handler;
      const result = await handler({ name: "test-prompt", variables: { name: "World" } });
      expect(pm.resolve).toHaveBeenCalledWith("test-prompt", { name: "World" });
      expect(result.text).toBe("Hello World");
    });

    it("returns error when prompt not found", async () => {
      const pm = createMockPromptManager();
      pm.resolve.mockReturnValue(null);
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "run-prompt")!.handler;
      const result = await handler({ name: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Prompt not found");
    });

    it("defaults variables to empty object", async () => {
      const pm = createMockPromptManager();
      const tools = createPromptTools({ promptManager: pm as never });
      const handler = tools.find((t) => t.name === "run-prompt")!.handler;
      await handler({ name: "test-prompt" });
      expect(pm.resolve).toHaveBeenCalledWith("test-prompt", {});
    });
  });
});
