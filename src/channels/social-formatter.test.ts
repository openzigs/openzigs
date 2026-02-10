import { describe, expect, it } from "vitest";
import { markdownToSocialText } from "./social-formatter.js";

describe("markdownToSocialText", () => {
  it("converts bold text to Unicode Mathematical Bold", () => {
    const result = markdownToSocialText("This is **bold** text");
    expect(result).toContain("𝗯𝗼𝗹𝗱");
    expect(result).not.toContain("**");
  });

  it("converts italic text to Unicode Mathematical Italic", () => {
    const result = markdownToSocialText("This is *italic* text");
    expect(result).toContain("𝑖𝑡𝑎𝑙𝑖𝑐");
    expect(result).not.toContain("*italic*");
  });

  it("converts bold+italic text", () => {
    const result = markdownToSocialText("This is ***both*** styled");
    expect(result).not.toContain("***");
  });

  it("converts links to text (url) format", () => {
    const result = markdownToSocialText("Check [Google](https://google.com) out");
    expect(result).toBe("Check Google (https://google.com) out");
  });

  it("converts images to [Image: alt] format", () => {
    const result = markdownToSocialText("![logo](https://example.com/logo.png)");
    expect(result).toBe("[Image: logo]");
  });

  it("converts headings to bold uppercase", () => {
    const result = markdownToSocialText("# Hello World");
    // Should be Unicode bold uppercase
    expect(result).not.toContain("#");
    expect(result).toContain("𝗛𝗘𝗟𝗟𝗢");
  });

  it("converts unordered lists to bullet points", () => {
    const result = markdownToSocialText("- First item\n- Second item");
    expect(result).toBe("• First item\n• Second item");
  });

  it("converts blockquotes to curly quotes", () => {
    const result = markdownToSocialText("> This is a quote");
    expect(result).toBe("❝This is a quote❞");
  });

  it("converts horizontal rules", () => {
    const result = markdownToSocialText("---");
    expect(result).toBe("─────────────────────");
  });

  it("strips inline code backticks", () => {
    const result = markdownToSocialText("Use `npm install` to install");
    expect(result).toBe("Use npm install to install");
  });

  it("strips code block fences", () => {
    const result = markdownToSocialText("```js\nconsole.log('hi');\n```");
    expect(result).toBe("console.log('hi');");
  });

  it("strips strikethrough markers", () => {
    const result = markdownToSocialText("This is ~~deleted~~ text");
    expect(result).toBe("This is deleted text");
  });

  it("passes plain text through unchanged", () => {
    const plain = "Nothing to transform here.";
    expect(markdownToSocialText(plain)).toBe(plain);
  });

  it("handles mixed Markdown content", () => {
    const input = [
      "# My Post",
      "",
      "**Check out** this *amazing* tool!",
      "",
      "- Feature one",
      "- Feature two",
      "",
      "> Built with love",
      "",
      "Learn more at [OpenZigs](https://openzigs.dev)",
    ].join("\n");

    const result = markdownToSocialText(input);

    // No raw Markdown syntax should survive
    expect(result).not.toContain("# ");
    expect(result).not.toContain("**");
    expect(result).not.toContain("*amazing*");
    expect(result).not.toContain("- ");
    expect(result).not.toContain("> ");
    expect(result).not.toContain("[OpenZigs]");

    // Should contain transformed content
    expect(result).toContain("•");
    expect(result).toContain("❝");
    expect(result).toContain("(https://openzigs.dev)");
  });

  it("converts bold digits to Unicode bold digits", () => {
    const result = markdownToSocialText("Version **2.0** is here");
    expect(result).toContain("𝟮");
    expect(result).toContain("𝟬");
  });
});
