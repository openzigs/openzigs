import { describe, it, expect, vi } from "vitest";
import { createCharacterTools } from "./character-tools.js";

function mockRepo() {
  return {
    getAll: vi.fn().mockReturnValue([
      { id: "c1", name: "Alice", triggerWord: "ALICE_TOK", status: "ready" },
      { id: "c2", name: "Bob", triggerWord: "BOB_TOK", status: "pending" },
    ]),
    getById: vi.fn((id: string) =>
      id === "c1" ? { id: "c1", name: "Alice", triggerWord: "ALICE_TOK", status: "ready" } : null,
    ),
    getByStatus: vi.fn((status: string) =>
      status === "ready"
        ? [{ id: "c1", name: "Alice", triggerWord: "ALICE_TOK", status: "ready" }]
        : [],
    ),
  } as any;
}

describe("character-tools", () => {
  it("returns one tool definition", () => {
    const tools = createCharacterTools({ characterRepo: mockRepo() });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("manage-characters");
  });

  describe("list action", () => {
    it("lists all characters", async () => {
      const repo = mockRepo();
      const [tool] = createCharacterTools({ characterRepo: repo });
      const result = await tool.handler({ action: "list" });
      const parsed = JSON.parse(result.text);
      expect(parsed.count).toBe(2);
      expect(repo.getAll).toHaveBeenCalled();
    });
  });

  describe("get action", () => {
    it("returns character by id", async () => {
      const [tool] = createCharacterTools({ characterRepo: mockRepo() });
      const result = await tool.handler({ action: "get", id: "c1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.name).toBe("Alice");
    });

    it("returns error when id missing", async () => {
      const [tool] = createCharacterTools({ characterRepo: mockRepo() });
      const result = await tool.handler({ action: "get" });
      expect(result.isError).toBe(true);
    });

    it("returns error when character not found", async () => {
      const [tool] = createCharacterTools({ characterRepo: mockRepo() });
      const result = await tool.handler({ action: "get", id: "nonexistent" });
      expect(result.isError).toBe(true);
    });
  });

  describe("get_ready action", () => {
    it("returns only ready characters", async () => {
      const repo = mockRepo();
      const [tool] = createCharacterTools({ characterRepo: repo });
      const result = await tool.handler({ action: "get_ready" });
      const parsed = JSON.parse(result.text);
      expect(parsed.count).toBe(1);
      expect(repo.getByStatus).toHaveBeenCalledWith("ready");
    });
  });

  it("returns error for invalid args", async () => {
    const [tool] = createCharacterTools({ characterRepo: mockRepo() });
    const result = await tool.handler({ action: 123 });
    expect(result.isError).toBe(true);
  });
});
