import { describe, expect, it } from "vitest";
import { convertMarkdown } from "./markdown.js";

describe("convertMarkdown", () => {
  it("converts bold for telegram", () => {
    expect(convertMarkdown("**bold**", "telegram")).toBe("*bold*");
  });

  it("keeps discord formatting", () => {
    expect(convertMarkdown("**bold**", "discord")).toBe("**bold**");
  });
});
