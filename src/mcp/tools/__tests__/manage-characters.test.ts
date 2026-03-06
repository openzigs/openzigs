import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCharacterTools } from "../character-tools.js";

describe("Tier 2: manage-characters handler", () => {
  const mockRepo = {
    getAll: vi.fn().mockReturnValue([
      { id: "c1", name: "Alex", triggerWord: "sks_alex", status: "ready" },
      { id: "c2", name: "Luna", triggerWord: "sks_luna", status: "training" },
    ]),
    getById: vi.fn().mockReturnValue(
      { id: "c1", name: "Alex", triggerWord: "sks_alex", status: "ready", trainedLoraPath: "/models/lora/alex.safetensors" },
    ),
    getByStatus: vi.fn().mockReturnValue([
      { id: "c1", name: "Alex", triggerWord: "sks_alex", status: "ready" },
    ]),
  };

  let handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createCharacterTools({ characterRepo: mockRepo as never });
    handler = tools[0].handler;
  });

  it("lists all characters", async () => {
    const result = await handler({ action: "list" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(2);
  });

  it("gets a character by id", async () => {
    const result = await handler({ action: "get", id: "c1" });
    expect(mockRepo.getById).toHaveBeenCalledWith("c1");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toHaveProperty("name", "Alex");
  });

  it("returns error when character not found", async () => {
    mockRepo.getById.mockReturnValueOnce(null);
    const result = await handler({ action: "get", id: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  it("requires id for get action", async () => {
    const result = await handler({ action: "get" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("required");
  });

  it("lists ready characters", async () => {
    const result = await handler({ action: "get_ready" });
    expect(mockRepo.getByStatus).toHaveBeenCalledWith("ready");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
  });
});
