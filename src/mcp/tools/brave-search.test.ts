import { describe, expect, it } from "vitest";
import { createBraveSearchHandler } from "./brave-search.js";

describe("brave search handler", () => {
  it("throws when BRAVE_API_KEY is missing", async () => {
    const handler = createBraveSearchHandler({ apiKey: "" });
    await expect(handler({ query: "typescript" })).rejects.toThrow(
      /BRAVE_API_KEY/i
    );
  });
});
