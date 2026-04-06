import { describe, it, expect, vi, beforeEach } from "vitest";
import { createImageUpscaleTools } from "./image-upscale-tools.js";
import { createBackgroundRemovalTools } from "./background-removal-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

const mockExistsSync = vi.fn().mockReturnValue(true);
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi
  .fn()
  .mockReturnValue(Buffer.from("fake-image-data"));
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Image Upscale Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createImageUpscaleTools({ sidecarUrl: "http://localhost:5010" });
    mockFetch.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  it("should create 1 tool", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("upscale-image");
  });

  it("should upscale an image via sidecar", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        image: Buffer.from("upscaled").toString("base64"),
        width: 1600,
        height: 1200,
      }),
    });

    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/test.png", scale: 2 });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.success).toBe(true);
    expect(parsed.scale).toBe(2);
    expect(parsed.width).toBe(1600);
  });

  it("should error for missing file", async () => {
    mockExistsSync.mockReturnValueOnce(false);
    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/missing.png" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("File not found");
  });

  it("should handle sidecar error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/test.png" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sidecar error");
  });
});

describe("Background Removal Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createBackgroundRemovalTools({
      sidecarUrl: "http://localhost:5010",
    });
    mockFetch.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  it("should create 1 tool", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("remove-background");
  });

  it("should remove background via sidecar", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        image: Buffer.from("nobg").toString("base64"),
        width: 800,
        height: 600,
      }),
    });

    const tool = tools[0];
    const result = await tool.handler({
      file_path: "/tmp/photo.jpg",
      model: "u2net",
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.success).toBe(true);
    expect(parsed.model).toBe("u2net");
  });

  it("should error for missing file", async () => {
    mockExistsSync.mockReturnValueOnce(false);
    const tool = tools[0];
    const result = await tool.handler({ file_path: "/tmp/missing.jpg" });
    expect(result.isError).toBe(true);
  });
});
