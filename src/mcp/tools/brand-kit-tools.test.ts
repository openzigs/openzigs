import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBrandKitTools } from "./brand-kit-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrandKitRepository, BrandKit } from "../../video/brand-kit.js";

const mockKit: BrandKit = {
  id: "kit-1",
  name: "Test Brand",
  primaryColor: "#ff0000",
  secondaryColor: "#00ff00",
  accentColor: "#0000ff",
  fontFamily: "Inter",
  logoPath: null,
  watermarkPath: null,
  introTemplateId: null,
  outroTemplateId: null,
  fontHeading: null,
  fontBody: null,
  footerText: null,
  defaultLogoPlacement: null,
  showSlideNumbers: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("Brand Kit Tools", () => {
  let tools: ToolDefinition[];
  let mockRepo: {
    getAll: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRepo = {
      getAll: vi.fn().mockReturnValue([mockKit]),
      getById: vi.fn().mockReturnValue(mockKit),
      create: vi.fn().mockReturnValue(mockKit),
      update: vi.fn().mockReturnValue(mockKit),
      delete: vi.fn().mockReturnValue(true),
    };
    tools = createBrandKitTools({
      brandKitRepo: mockRepo as unknown as BrandKitRepository,
    });
  });

  it("should create 5 tools", () => {
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list-brand-kits");
    expect(names).toContain("get-brand-kit");
    expect(names).toContain("create-brand-kit");
    expect(names).toContain("update-brand-kit");
    expect(names).toContain("delete-brand-kit");
  });

  describe("list-brand-kits", () => {
    it("should return all kits", async () => {
      const tool = tools.find((t) => t.name === "list-brand-kits")!;
      const result = await tool.handler({});
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Test Brand");
    });
  });

  describe("get-brand-kit", () => {
    it("should return a kit by ID", async () => {
      const tool = tools.find((t) => t.name === "get-brand-kit")!;
      const result = await tool.handler({ kit_id: "kit-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.id).toBe("kit-1");
    });

    it("should error for missing kit", async () => {
      mockRepo.getById.mockReturnValueOnce(null);
      const tool = tools.find((t) => t.name === "get-brand-kit")!;
      const result = await tool.handler({ kit_id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  describe("create-brand-kit", () => {
    it("should create a brand kit", async () => {
      const tool = tools.find((t) => t.name === "create-brand-kit")!;
      const result = await tool.handler({
        name: "New Brand",
        primary_color: "#112233",
        secondary_color: "#445566",
        accent_color: "#778899",
      });
      expect(result.isError).toBeFalsy();
      expect(mockRepo.create).toHaveBeenCalled();
    });

    it("should reject invalid color format", async () => {
      const tool = tools.find((t) => t.name === "create-brand-kit")!;
      const result = await tool.handler({
        name: "Bad",
        primary_color: "not-hex",
        secondary_color: "#000000",
        accent_color: "#ffffff",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("update-brand-kit", () => {
    it("should update a brand kit", async () => {
      const tool = tools.find((t) => t.name === "update-brand-kit")!;
      const result = await tool.handler({ kit_id: "kit-1", name: "Updated" });
      expect(result.isError).toBeFalsy();
      expect(mockRepo.update).toHaveBeenCalled();
    });

    it("should error for missing kit", async () => {
      mockRepo.update.mockReturnValueOnce(null);
      const tool = tools.find((t) => t.name === "update-brand-kit")!;
      const result = await tool.handler({ kit_id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  describe("delete-brand-kit", () => {
    it("should delete a brand kit", async () => {
      const tool = tools.find((t) => t.name === "delete-brand-kit")!;
      const result = await tool.handler({ kit_id: "kit-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
    });

    it("should error for missing kit", async () => {
      mockRepo.delete.mockReturnValueOnce(false);
      const tool = tools.find((t) => t.name === "delete-brand-kit")!;
      const result = await tool.handler({ kit_id: "missing" });
      expect(result.isError).toBe(true);
    });
  });
});
