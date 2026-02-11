import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSystemConfigTools } from "./system-config-tools.js";
import type { PromptManager } from "../../productivity/prompt-manager.js";

const mockPrompt = {
  id: "test-id-1",
  name: "test-prompt",
  template: "Hello {{name}}, welcome to {{project}}!",
  description: "Test prompt | Variables: name, project",
  tags: ["greeting"],
  preferredTools: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

const createMockPromptManager = () => ({
  create: vi.fn().mockReturnValue(mockPrompt),
  getByName: vi.fn().mockReturnValue(null),
  getById: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  resolve: vi.fn(),
  resolveWithTools: vi.fn(),
});

describe("system-config-tools", () => {
  let promptManager: ReturnType<typeof createMockPromptManager>;
  let tools: ReturnType<typeof createSystemConfigTools>;

  beforeEach(() => {
    promptManager = createMockPromptManager();
    tools = createSystemConfigTools({ promptManager: promptManager as unknown as PromptManager });
  });

  it("registers create-prompt tool with correct metadata", () => {
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("create-prompt");
    expect(tool.category).toBe("productivity");
    expect(tool.riskLevel).toBe("high");
    expect(tool.inputSchema.required).toContain("name");
    expect(tool.inputSchema.required).toContain("content");
  });

  it("creates a prompt successfully", async () => {
    const result = await tools[0].handler({
      name: "test-prompt",
      content: "Hello {{name}}, welcome to {{project}}!",
      description: "Test prompt",
      tags: ["greeting"],
      variables: ["name", "project"],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.id).toBe("test-id-1");
    expect(parsed.name).toBe("test-prompt");

    expect(promptManager.create).toHaveBeenCalledWith({
      name: "test-prompt",
      template: "Hello {{name}}, welcome to {{project}}!",
      description: "Test prompt | Variables: name, project",
      tags: ["greeting"],
    });
  });

  it("rejects duplicate prompt names", async () => {
    promptManager.getByName.mockReturnValue(mockPrompt);

    const result = await tools[0].handler({
      name: "test-prompt",
      content: "Some content",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("already exists");
    expect(promptManager.create).not.toHaveBeenCalled();
  });

  it("adds system-prompt tag when systemPrompt flag is true", async () => {
    await tools[0].handler({
      name: "sys-prompt",
      content: "You are a helpful assistant.",
      systemPrompt: true,
    });

    expect(promptManager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ["system-prompt"],
      })
    );
  });

  it("creates prompt with minimal required fields", async () => {
    await tools[0].handler({
      name: "minimal",
      content: "Simple prompt content",
    });

    expect(promptManager.create).toHaveBeenCalledWith({
      name: "minimal",
      template: "Simple prompt content",
      description: undefined,
      tags: undefined,
    });
  });
});
