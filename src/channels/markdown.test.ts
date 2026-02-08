import { describe, expect, it } from "vitest";
import { convertMarkdown } from "./markdown.js";

describe("convertMarkdown", () => {
  it("converts bold for telegram", () => {
    const result = convertMarkdown("**bold**", "telegram");
    // toTelegramMarkdownV2 wraps bold in single asterisks
    expect(result).toContain("*bold*");
    expect(result).not.toContain("**");
  });

  it("keeps discord formatting", () => {
    expect(convertMarkdown("**bold**", "discord")).toBe("**bold**");
  });
});
