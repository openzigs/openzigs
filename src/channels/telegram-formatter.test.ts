import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  mermaidToInkUrl,
  toTelegramMarkdownV2,
  splitTelegramMessage,
} from "./telegram-formatter.js";

describe("escapeMarkdownV2", () => {
  it("escapes Telegram special characters", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
    expect(escapeMarkdownV2("a.b!c")).toBe("a\\.b\\!c");
    expect(escapeMarkdownV2("foo(bar)")).toBe("foo\\(bar\\)");
  });

  it("escapes brackets and pipes", () => {
    expect(escapeMarkdownV2("[link]")).toBe("\\[link\\]");
    expect(escapeMarkdownV2("a|b")).toBe("a\\|b");
  });

  it("returns empty string unchanged", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("mermaidToInkUrl", () => {
  it("returns a mermaid.ink URL with base64url-encoded diagram", () => {
    const diagram = "graph TD\n  A-->B";
    const url = mermaidToInkUrl(diagram);
    expect(url).toMatch(/^https:\/\/mermaid\.ink\/img\//);
    // Decode and verify round-trip
    const encoded = url.replace("https://mermaid.ink/img/", "");
    const decoded = Buffer.from(encoded, "base64url").toString();
    expect(decoded).toBe(diagram);
  });
});

describe("toTelegramMarkdownV2", () => {
  it("converts bold to MarkdownV2 bold", () => {
    const result = toTelegramMarkdownV2("This is **bold** text");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("**");
  });

  it("converts italic to MarkdownV2 italic", () => {
    const result = toTelegramMarkdownV2("This is *italic* text");
    expect(result).toContain("_italic_");
  });

  it("converts strikethrough", () => {
    const result = toTelegramMarkdownV2("~~deleted~~");
    expect(result).toContain("~deleted~");
  });

  it("preserves code blocks without escaping", () => {
    const input = "Before\n```js\nconst x = 1;\n```\nAfter";
    const result = toTelegramMarkdownV2(input);
    expect(result).toContain("```js");
    expect(result).toContain("const x = 1;");
  });

  it("converts mermaid code blocks to image links", () => {
    const input = "```mermaid\ngraph TD\n  A-->B\n```";
    const result = toTelegramMarkdownV2(input);
    expect(result).toContain("[Diagram]");
    expect(result).toContain("mermaid");
  });

  it("escapes special chars in prose", () => {
    const result = toTelegramMarkdownV2("Hello! How are you.");
    expect(result).toContain("Hello\\!");
    expect(result).toContain("you\\.");
  });

  it("converts headers to bold", () => {
    const result = toTelegramMarkdownV2("## Section Title");
    expect(result).toContain("*Section Title*");
  });

  it("converts unordered list items to bullet points", () => {
    const result = toTelegramMarkdownV2("- Item one\n- Item two");
    expect(result).toContain("• Item one");
    expect(result).toContain("• Item two");
  });

  it("handles links", () => {
    const result = toTelegramMarkdownV2("[Google](https://google.com)");
    // Should contain Telegram-formatted link with Google text
    expect(result).toContain("Google");
    // The dot in the URL is escaped in MarkdownV2: google\.com
    expect(result).toMatch(/google/);
  });

  it("preserves inline code without escaping", () => {
    const result = toTelegramMarkdownV2("Run `npm install` to start");
    expect(result).toContain("`npm install`");
  });
});

describe("splitTelegramMessage", () => {
  it("returns single chunk for short messages", () => {
    const chunks = splitTelegramMessage("Hello", 4096);
    expect(chunks).toEqual(["Hello"]);
  });

  it("splits at paragraph boundaries", () => {
    const para1 = "A".repeat(3000);
    const para2 = "B".repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits at newlines when no paragraph break", () => {
    const line1 = "A".repeat(3000);
    const line2 = "B".repeat(2000);
    const text = `${line1}\n${line2}`;
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("hard-cuts when no breakpoints", () => {
    const text = "A".repeat(5000);
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("A".repeat(4096));
    expect(chunks[1]).toBe("A".repeat(904));
  });

  it("respects custom maxLength", () => {
    const text = "A".repeat(100);
    const chunks = splitTelegramMessage(text, 50);
    expect(chunks.length).toBe(2);
  });
});
