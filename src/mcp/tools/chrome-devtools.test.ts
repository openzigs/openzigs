import { describe, expect, it } from "vitest";
import { createChromeDevtoolsHandler } from "./chrome-devtools.js";


describe("chrome devtools handler", () => {
  it("throws when CHROME_DEBUG_HOST is missing", async () => {
    const handler = createChromeDevtoolsHandler({ host: "", port: 9222 });
    await expect(handler({})).rejects.toThrow(/CHROME_DEBUG_HOST/i);
  });
});




















