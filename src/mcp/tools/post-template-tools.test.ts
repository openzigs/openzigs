import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPostTemplateTools } from "./post-template-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import type {
  PostTemplateRepository,
  PostTemplate,
} from "../../creative/post-template-repository.js";

const mockTemplate: PostTemplate = {
  id: "tmpl-1",
  name: "Launch Template",
  description: "For product launches",
  platform: "twitter",
  layout: "default",
  contentTemplate: "🚀 {{product}} is live! {{url}}",
  brandKitId: null,
  tags: ["launch"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("Post Template Tools", () => {
  let tools: ToolDefinition[];
  let mockRepo: {
    list: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    applyTemplate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRepo = {
      list: vi.fn().mockReturnValue([mockTemplate]),
      getById: vi.fn().mockReturnValue(mockTemplate),
      create: vi.fn().mockReturnValue(mockTemplate),
      update: vi.fn().mockReturnValue(mockTemplate),
      delete: vi.fn().mockReturnValue(true),
      applyTemplate: vi.fn().mockReturnValue({
        content: "🚀 OpenZigs is live! https://openzigs.dev",
        platform: "twitter",
      }),
    };
    tools = createPostTemplateTools({
      postTemplateRepo: mockRepo as unknown as PostTemplateRepository,
    });
  });

  it("should create 6 tools", () => {
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list-post-templates");
    expect(names).toContain("get-post-template");
    expect(names).toContain("create-post-template");
    expect(names).toContain("update-post-template");
    expect(names).toContain("delete-post-template");
    expect(names).toContain("apply-post-template");
  });

  describe("list-post-templates", () => {
    it("should list templates", async () => {
      const tool = tools.find((t) => t.name === "list-post-templates")!;
      const result = await tool.handler({});
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
    });

    it("should filter by platform", async () => {
      const tool = tools.find((t) => t.name === "list-post-templates")!;
      await tool.handler({ platform: "twitter" });
      expect(mockRepo.list).toHaveBeenCalledWith({
        platform: "twitter",
        brandKitId: undefined,
      });
    });
  });

  describe("create-post-template", () => {
    it("should create a template", async () => {
      const tool = tools.find((t) => t.name === "create-post-template")!;
      const result = await tool.handler({
        name: "Test",
        platform: "instagram",
        content_template: "Hello {{name}}",
      });
      expect(result.isError).toBeFalsy();
      expect(mockRepo.create).toHaveBeenCalled();
    });
  });

  describe("apply-post-template", () => {
    it("should apply variables to template", async () => {
      const tool = tools.find((t) => t.name === "apply-post-template")!;
      const result = await tool.handler({
        template_id: "tmpl-1",
        variables: { product: "OpenZigs", url: "https://openzigs.dev" },
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.content).toContain("OpenZigs");
    });

    it("should error for missing template", async () => {
      mockRepo.applyTemplate.mockReturnValueOnce(null);
      const tool = tools.find((t) => t.name === "apply-post-template")!;
      const result = await tool.handler({
        template_id: "missing",
        variables: {},
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("delete-post-template", () => {
    it("should delete a template", async () => {
      const tool = tools.find((t) => t.name === "delete-post-template")!;
      const result = await tool.handler({ template_id: "tmpl-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
    });
  });
});
