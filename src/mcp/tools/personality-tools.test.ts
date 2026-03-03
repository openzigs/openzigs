import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPersonalityTools, type PersonalityToolsOptions } from "./personality-tools.js";

describe("personality-tools", () => {
  const mockPersonalityManager = {
    getConfig: vi.fn(),
    update: vi.fn(),
    reset: vi.fn(),
  };

  const options: PersonalityToolsOptions = {
    personalityManager: mockPersonalityManager as unknown as PersonalityToolsOptions["personalityManager"],
  };

  let tools: ReturnType<typeof createPersonalityTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createPersonalityTools(options);
  });

  it("creates three tools", () => {
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["get-personality", "set-personality", "reset-personality"]);
  });

  describe("get-personality", () => {
    it("has correct metadata", () => {
      const tool = tools.find((t) => t.name === "get-personality")!;
      expect(tool.category).toBe("productivity");
      expect(tool.riskLevel).toBe("low");
    });

    it("returns current personality config as JSON", async () => {
      const config = {
        systemInstruction: "You are helpful",
        prePrompt: "Context:",
        postPrompt: "",
        enabled: true,
      };
      mockPersonalityManager.getConfig.mockReturnValue(config);

      const tool = tools.find((t) => t.name === "get-personality")!;
      const result = await tool.handler({});

      expect(result.text).toBe(JSON.stringify(config));
      expect(result.isError).toBeUndefined();
    });
  });

  describe("set-personality", () => {
    it("has medium risk level", () => {
      const tool = tools.find((t) => t.name === "set-personality")!;
      expect(tool.riskLevel).toBe("medium");
    });

    it("updates personality with partial input", async () => {
      const updated = { systemInstruction: "Be concise", prePrompt: "", postPrompt: "", enabled: true };
      mockPersonalityManager.update.mockReturnValue(updated);

      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = await tool.handler({ systemInstruction: "Be concise" });

      expect(mockPersonalityManager.update).toHaveBeenCalledWith({ systemInstruction: "Be concise" });
      expect(result.text).toBe(JSON.stringify(updated));
    });

    it("updates all fields at once", async () => {
      const input = {
        systemInstruction: "AI assistant",
        prePrompt: "Before",
        postPrompt: "After",
        enabled: false,
      };
      mockPersonalityManager.update.mockReturnValue(input);

      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = await tool.handler(input);

      expect(mockPersonalityManager.update).toHaveBeenCalledWith(input);
      expect(result.text).toBe(JSON.stringify(input));
    });

    it("returns error when update throws", async () => {
      mockPersonalityManager.update.mockImplementation(() => {
        throw new Error("Invalid personality config");
      });

      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = await tool.handler({ systemInstruction: "" });

      expect(result.isError).toBe(true);
      expect(result.text).toBe("Invalid personality config");
    });

    it("handles non-Error throws", async () => {
      mockPersonalityManager.update.mockImplementation(() => {
        throw "string error";
      });

      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      expect(result.text).toBe("string error");
    });
  });

  describe("reset-personality", () => {
    it("resets personality to defaults", async () => {
      const defaults = {
        systemInstruction: "",
        prePrompt: "",
        postPrompt: "",
        enabled: false,
      };
      mockPersonalityManager.reset.mockReturnValue(defaults);

      const tool = tools.find((t) => t.name === "reset-personality")!;
      const result = await tool.handler({});

      expect(mockPersonalityManager.reset).toHaveBeenCalled();
      expect(result.text).toBe(JSON.stringify(defaults));
    });

    it("has medium risk level", () => {
      const tool = tools.find((t) => t.name === "reset-personality")!;
      expect(tool.riskLevel).toBe("medium");
    });
  });

  describe("schema validation", () => {
    it("set-personality schema accepts valid input", () => {
      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = tool.zodSchema.safeParse({
        systemInstruction: "test",
        enabled: true,
      });
      expect(result.success).toBe(true);
    });

    it("set-personality schema accepts empty object", () => {
      const tool = tools.find((t) => t.name === "set-personality")!;
      const result = tool.zodSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("get-personality schema accepts empty object", () => {
      const tool = tools.find((t) => t.name === "get-personality")!;
      const result = tool.zodSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
