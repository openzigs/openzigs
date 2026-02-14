import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker.js";

describe("chunkText", () => {
  it("returns empty array for empty text", () => {
    const result = chunkText("", "doc1", "test.md");
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only text", () => {
    const result = chunkText("   \n\n  ", "doc1", "test.md");
    expect(result).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const text = "Hello, this is a short document.";
    const result = chunkText(text, "doc1", "test.md", { chunkSize: 1000, chunkOverlap: 100 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("doc1-0");
    expect(result[0].documentId).toBe("doc1");
    expect(result[0].text).toBe(text);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].sourcePath).toBe("test.md");
  });

  it("splits long text into multiple chunks", () => {
    const paragraph = "This is a sentence. ".repeat(20); // ~400 chars
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const result = chunkText(text, "doc1", "test.md", { chunkSize: 500, chunkOverlap: 50 });

    expect(result.length).toBeGreaterThan(1);

    // Every chunk should have sequential indexes
    result.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.id).toBe(`doc1-${i}`);
    });
  });

  it("extracts markdown headings as section context", () => {
    const text = `# Introduction

This is the intro paragraph.

## Details

Here are some details about the topic.`;

    const result = chunkText(text, "doc1", "design.md", { chunkSize: 2000, chunkOverlap: 0 });

    // Should produce at least one chunk with heading context
    const hasHeading = result.some((c) => c.sectionHeading !== undefined);
    expect(hasHeading).toBe(true);
  });

  it("handles markdown headings with level 2+", () => {
    const text = `## Overview

Some overview text here.

### Sub-section

Sub-section details.`;

    const result = chunkText(text, "doc2", "readme.md", { chunkSize: 2000, chunkOverlap: 0 });
    expect(result.length).toBeGreaterThan(0);
  });

  it("preserves source path in all chunks", () => {
    const text = "Line one.\n\nLine two.\n\nLine three.";
    const result = chunkText(text, "d1", "docs/notes.md", { chunkSize: 15, chunkOverlap: 0 });
    for (const chunk of result) {
      expect(chunk.sourcePath).toBe("docs/notes.md");
    }
  });

  it("uses default options when none provided", () => {
    const text = "A small document.";
    const result = chunkText(text, "doc1", "file.txt");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
  });

  it("handles text without any headings", () => {
    const text = "Just a plain text paragraph with no headings at all.";
    const result = chunkText(text, "doc1", "plain.txt", { chunkSize: 1000, chunkOverlap: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].sectionHeading).toBeUndefined();
  });
});
