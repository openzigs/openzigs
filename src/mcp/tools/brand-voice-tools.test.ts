import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBrandVoiceTools } from "./brand-voice-tools.js";
import type { BrandVoiceService } from "../../personality/brand-voice-service.js";

function createMockService(overrides: Partial<BrandVoiceService> = {}): BrandVoiceService {
  return {
    getAll: vi.fn().mockReturnValue([{ id: "bv1", name: "Professional", active: true }]),
    getById: vi.fn().mockReturnValue({ id: "bv1", name: "Professional", active: true }),
    getActive: vi.fn().mockReturnValue({ id: "bv1", name: "Professional", active: true }),
    analyzeAndSave: vi.fn().mockResolvedValue({ id: "bv2", name: "Casual", active: false }),
    setActive: vi.fn().mockReturnValue({ id: "bv1", name: "Professional", active: true }),
    deactivateAll: vi.fn(),
    delete: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as BrandVoiceService;
}

function getHandler(overrides: Partial<BrandVoiceService> = {}) {
  const service = createMockService(overrides);
  const tools = createBrandVoiceTools({ brandVoiceService: service });
  return { handler: tools[0].handler, service };
}

describe("brand-voice-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const tools = createBrandVoiceTools({ brandVoiceService: createMockService() });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("manage-brand-voice");
  });

  it("list returns all voices", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "list" });
    expect(JSON.parse(result.text)).toHaveLength(1);
  });

  it("get returns voice by id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get", id: "bv1" });
    expect(JSON.parse(result.text).id).toBe("bv1");
  });

  it("get requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get" });
    expect(result.isError).toBe(true);
  });

  it("get returns error when not found", async () => {
    const { handler } = getHandler({ getById: vi.fn().mockReturnValue(null) });
    const result = await handler({ action: "get", id: "missing" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  it("get_active returns active voice", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get_active" });
    expect(JSON.parse(result.text).active).toBe(true);
  });

  it("get_active returns message when none active", async () => {
    const { handler } = getHandler({ getActive: vi.fn().mockReturnValue(null) });
    const result = await handler({ action: "get_active" });
    expect(result.text).toContain("No active brand voice");
  });

  it("analyze_and_save creates voice", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "analyze_and_save", name: "Casual", samples: ["sample text"] });
    expect(service.analyzeAndSave).toHaveBeenCalledWith("Casual", ["sample text"], { model: undefined });
    expect(JSON.parse(result.text).name).toBe("Casual");
  });

  it("analyze_and_save requires name and samples", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "analyze_and_save" });
    expect(result.isError).toBe(true);
  });

  it("set_active sets active voice", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "set_active", id: "bv1" });
    expect(result.isError).toBeUndefined();
  });

  it("set_active requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "set_active" });
    expect(result.isError).toBe(true);
  });

  it("set_active returns error when not found", async () => {
    const { handler } = getHandler({ setActive: vi.fn().mockReturnValue(null) });
    const result = await handler({ action: "set_active", id: "missing" });
    expect(result.isError).toBe(true);
  });

  it("deactivate_all works", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "deactivate_all" });
    expect(service.deactivateAll).toHaveBeenCalled();
    expect(result.text).toContain("deactivated");
  });

  it("delete removes voice", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "delete", id: "bv1" });
    expect(result.text).toContain("deleted");
  });

  it("delete requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "delete" });
    expect(result.isError).toBe(true);
  });

  it("delete returns error when not found", async () => {
    const { handler } = getHandler({ delete: vi.fn().mockReturnValue(false) });
    const result = await handler({ action: "delete", id: "missing" });
    expect(result.isError).toBe(true);
  });
});
