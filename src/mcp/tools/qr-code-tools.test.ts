import { describe, it, expect, vi, beforeEach } from "vitest";
import { createQrCodeTools } from "./qr-code-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import fs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 4096 }),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock("qrcode", () => ({
  default: {
    toFile: vi.fn().mockResolvedValue(undefined),
    toString: vi.fn().mockResolvedValue("<svg>mock</svg>"),
    QRErrorCorrectionLevel: { L: 0, M: 1, Q: 2, H: 3 },
  },
}));

describe("QR Code Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createQrCodeTools();
    vi.clearAllMocks();
  });

  it("should create 1 tool", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("generate-qr-code");
  });

  describe("generate-qr-code", () => {
    const tool = () => tools.find((t) => t.name === "generate-qr-code")!;

    it("should generate PNG QR code", async () => {
      const result = await tool().handler({ content: "https://example.com" });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.format).toBe("png");
      expect(parsed.content).toBe("https://example.com");
    });

    it("should generate SVG QR code", async () => {
      const result = await tool().handler({
        content: "test data",
        format: "svg",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.format).toBe("svg");
    });

    it("should generate terminal QR code", async () => {
      const result = await tool().handler({
        content: "hello",
        format: "terminal",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.format).toBe("terminal");
      expect(parsed.content).toBe("hello");
    });

    it("should reject invalid dark color", async () => {
      const result = await tool().handler({
        content: "test",
        color_dark: "not-a-color",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Invalid dark color");
    });

    it("should reject invalid light color", async () => {
      const result = await tool().handler({
        content: "test",
        color_light: "xyz",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Invalid light color");
    });

    it("should use custom width and error correction", async () => {
      const result = await tool().handler({
        content: "test",
        width: 800,
        error_correction: "H",
        margin: 2,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.width).toBe(800);
    });
  });
});
