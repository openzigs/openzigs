import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSentinelTools } from "./sentinel-tools.js";
import type { SentinelService } from "../../sentinel/sentinel-service.js";

function createMockService(overrides: Partial<SentinelService> = {}): SentinelService {
  return {
    getStatus: vi.fn().mockReturnValue({ enabled: true, lastCheck: null, healthy: true }),
    toggle: vi.fn().mockResolvedValue(undefined),
    getDigestHistory: vi.fn().mockResolvedValue([
      { date: "2026-03-10", summary: "All systems healthy" },
    ]),
    ...overrides,
  } as unknown as SentinelService;
}

function getHandler(overrides: Partial<SentinelService> = {}) {
  const service = createMockService(overrides);
  const tools = createSentinelTools({ sentinelService: service });
  return { handler: tools[0].handler, service };
}

describe("sentinel-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const tools = createSentinelTools({ sentinelService: createMockService() });
    expect(tools[0].name).toBe("sentinel-control");
    expect(tools[0].riskLevel).toBe("medium");
  });

  it("status returns sentinel status", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "status" });
    const parsed = JSON.parse(result.text);
    expect(parsed.enabled).toBe(true);
  });

  it("enable enables sentinel", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "enable" });
    expect(service.toggle).toHaveBeenCalledWith(true);
    expect(result.text).toContain("enabled");
  });

  it("disable disables sentinel", async () => {
    const { handler, service } = getHandler();
    const result = await handler({ action: "disable" });
    expect(service.toggle).toHaveBeenCalledWith(false);
    expect(result.text).toContain("disabled");
  });

  it("get_digest returns latest digest", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get_digest" });
    const parsed = JSON.parse(result.text);
    expect(parsed.summary).toBe("All systems healthy");
  });

  it("get_digest returns message when no digests", async () => {
    const { handler } = getHandler({
      getDigestHistory: vi.fn().mockResolvedValue([]),
    });
    const result = await handler({ action: "get_digest" });
    expect(result.text).toContain("No digests");
  });

  it("list_digests returns digest history", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "list_digests" });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
  });

  it("list_digests uses custom limit", async () => {
    const { handler, service } = getHandler();
    await handler({ action: "list_digests", limit: 5 });
    expect(service.getDigestHistory).toHaveBeenCalledWith(5);
  });

  it("handles errors gracefully", async () => {
    const { handler } = getHandler({
      getStatus: vi.fn().mockImplementation(() => { throw new Error("service down"); }),
    });
    const result = await handler({ action: "status" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("service down");
  });
});
