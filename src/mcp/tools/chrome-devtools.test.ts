import { describe, expect, it, vi } from "vitest";
import { createChromeDevtoolsHandler } from "./chrome-devtools.js";


describe("chrome devtools handler", () => {
  it("throws when CHROME_DEBUG_HOST is missing", async () => {
    const handler = createChromeDevtoolsHandler({ host: "", port: 9222 });
    await expect(handler({})).rejects.toThrow(/CHROME_DEBUG_HOST/i);
  });

  it("throws when Chrome response validation fails", async () => {
    const handler = createChromeDevtoolsHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ not: "an array" })
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(handler({})).rejects.toThrow(/response validation failed/i);

    vi.unstubAllGlobals();
  });
});







































