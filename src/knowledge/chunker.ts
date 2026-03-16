/**
 * Text chunker for the knowledge base.
 *
 * Splits documents into overlapping chunks for vector embedding.
 * Markdown-aware: prefers splitting on headings, paragraphs, and
 * sentence boundaries to preserve semantic coherence.
 */

import type { KnowledgeChunk } from "./types.js";

export type ChunkerOptions = {
  /** Maximum characters per chunk. */
  chunkSize: number;
  /** Overlap between consecutive chunks. */
  chunkOverlap: number;
};

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Split text into overlapping chunks, preferring natural boundaries.
 *
 * Strategy:
 * 1. Split on markdown headings (##) first for section awareness.
 * 2. Within sections, split on double-newlines (paragraphs).
 * 3. If a paragraph exceeds chunkSize, split on sentences.
 * 4. Apply overlap by carrying trailing characters into the next chunk.
 */
export const chunkText = (
  text: string,
  documentId: string,
  sourcePath: string,
  options?: Partial<ChunkerOptions>
): KnowledgeChunk[] => {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  if (!text.trim()) {
    return [];
  }

  const sections = splitBySections(text);
  const chunks: KnowledgeChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(
      section.text,
      chunkSize,
      chunkOverlap
    );

    for (const chunkText of sectionChunks) {
      if (!chunkText.trim()) continue;

      chunks.push({
        id: `${documentId}-${chunkIndex}`,
        documentId,
        text: chunkText.trim(),
        chunkIndex,
        sourcePath,
        sectionHeading: section.heading || undefined,
      });
      chunkIndex++;
    }
  }

  return chunks;
};

type Section = {
  heading: string;
  text: string;
};

/**
 * Split text by markdown headings, keeping each heading with its content.
 */
const splitBySections = (text: string): Section[] => {
  // Match lines that start with one or more # chars
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  const sections: Section[] = [];

  let lastIndex = 0;
  let currentHeading = "";
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(text)) !== null) {
    // Capture text before this heading as part of the previous section
    if (match.index > lastIndex) {
      const content = text.slice(lastIndex, match.index);
      if (content.trim()) {
        sections.push({ heading: currentHeading, text: content });
      }
    }
    currentHeading = match[2].trim();
    lastIndex = match.index;
  }

  // Remaining text after the last heading
  if (lastIndex < text.length) {
    const content = text.slice(lastIndex);
    if (content.trim()) {
      sections.push({ heading: currentHeading, text: content });
    }
  }

  // If no sections were found (no headings), return the whole text as one section
  if (sections.length === 0) {
    sections.push({ heading: "", text });
  }

  return sections;
};

/**
 * Chunk a section of text with overlapping windows.
 */
const chunkSection = (
  text: string,
  chunkSize: number,
  chunkOverlap: number
): string[] => {
  if (text.length <= chunkSize) {
    return [text];
  }

  // Split into paragraphs first
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    // If a single paragraph exceeds chunk size, split it by sentences
    if (paragraph.length > chunkSize) {
      // Flush current chunk
      if (currentChunk.trim()) {
        chunks.push(currentChunk);
        currentChunk = getOverlap(currentChunk, chunkOverlap);
      }

      const sentences = splitSentences(paragraph);
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length > chunkSize && currentChunk.trim()) {
          chunks.push(currentChunk);
          currentChunk = getOverlap(currentChunk, chunkOverlap);
        }
        currentChunk += sentence;
      }
    } else if ((currentChunk + "\n\n" + paragraph).length > chunkSize && currentChunk.trim()) {
      chunks.push(currentChunk);
      currentChunk = getOverlap(currentChunk, chunkOverlap) + paragraph;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
};

/**
 * Split text into sentences (approximate).
 */
const splitSentences = (text: string): string[] => {
  // Split on sentence-ending punctuation followed by space or newline
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((s, i) => (i < parts.length - 1 ? s + " " : s));
};

/**
 * Get the overlap suffix from the end of a chunk.
 * Snaps to the nearest word boundary to avoid splitting mid-word.
 */
const getOverlap = (text: string, overlapSize: number): string => {
  if (overlapSize <= 0 || text.length <= overlapSize) {
    return "";
  }
  const raw = text.slice(-overlapSize);
  // Find the first whitespace to snap to a word boundary
  const spaceIndex = raw.indexOf(" ");
  if (spaceIndex === -1 || spaceIndex === 0) {
    return raw;
  }
  // Skip the partial word at the start
  return raw.slice(spaceIndex + 1);
};
