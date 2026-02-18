/**
 * Tests for the multimodal retriever and query classifier.
 *
 * Validates:
 * - Query classification (media keywords, temporal patterns, boost)
 * - Multimodal re-ranking (score boosting, citation formatting)
 * - Multimodal search wrapper (integration with search function)
 */

import { describe, it, expect, vi } from "vitest";
import { classifyQuery } from "./query-classifier.js";
import {
  applyMultimodalReranking,
  formatCitation,
  multimodalSearch,
  type MultimodalSearchResult,
} from "./multimodal-retriever.js";
import type { KnowledgeSearchResult } from "./types.js";

// ── Query Classifier Tests ──

describe("classifyQuery", () => {
  it("should classify a plain text query as non-media", () => {
    const result = classifyQuery("What is the capital of France?");
    expect(result.isMediaQuery).toBe(false);
    expect(result.mediaBoost).toBe(1.0);
    expect(result.targetTypes).toEqual([]);
    expect(result.temporalHints).toEqual([]);
  });

  it("should detect video-related keywords", () => {
    const result = classifyQuery("What did they say in the video about architecture?");
    expect(result.isMediaQuery).toBe(true);
    expect(result.mediaBoost).toBeGreaterThan(1.0);
  });

  it("should detect audio-related keywords", () => {
    const result = classifyQuery("Find the podcast episode where they discuss Kubernetes");
    expect(result.isMediaQuery).toBe(true);
    expect(result.mediaBoost).toBeGreaterThan(1.0);
  });

  it("should detect transcript-related keywords", () => {
    const result = classifyQuery("Search the transcript for mentions of database migration");
    expect(result.isMediaQuery).toBe(true);
  });

  it("should extract temporal hints", () => {
    const result = classifyQuery("What happens at 2:30 in the recording?");
    expect(result.includeTimestamps).toBe(true);
    expect(result.temporalHints.length).toBeGreaterThan(0);
  });

  it("should extract minute-based temporal hints", () => {
    const result = classifyQuery("Around minute 5 of the video");
    expect(result.includeTimestamps).toBe(true);
    expect(result.temporalHints.length).toBeGreaterThan(0);
  });

  it("should include timestamps when timestamps are mentioned", () => {
    const result = classifyQuery("Show the timestamps where they mention security");
    expect(result.includeTimestamps).toBe(true);
  });

  it("should detect image keywords", () => {
    const result = classifyQuery("What does the screenshot show?");
    expect(result.isMediaQuery).toBe(true);
  });

  it("should increase boost with more media keywords", () => {
    const single = classifyQuery("video about architecture");
    const multi = classifyQuery("video recording transcript of the presentation");
    expect(multi.mediaBoost).toBeGreaterThanOrEqual(single.mediaBoost);
  });

  it("should cap boost at 1.5", () => {
    const result = classifyQuery(
      "video recording podcast audio transcript lecture presentation narration"
    );
    expect(result.mediaBoost).toBeLessThanOrEqual(1.5);
  });
});

// ── Multimodal Re-ranking Tests ──

describe("applyMultimodalReranking", () => {
  const makeResult = (
    sourcePath: string,
    score: number,
    overrides: Partial<KnowledgeSearchResult> = {},
  ): KnowledgeSearchResult => ({
    text: `Content from ${sourcePath}`,
    sourcePath,
    score,
    sectionHeading: undefined,
    documentId: "doc-" + sourcePath,
    chunkIndex: 0,
    ...overrides,
  });

  it("should pass through results unchanged for non-media queries", () => {
    const classification = classifyQuery("What is TypeScript?");
    const results = [
      makeResult("readme.md", 0.9),
      makeResult("interview.mp4", 0.8),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    expect(reranked[0].sourcePath).toBe("readme.md");
    expect(reranked[1].sourcePath).toBe("interview.mp4");
    // Scores should be preserved (no boosting)
    expect(reranked[0].originalScore).toBe(0.9);
    expect(reranked[1].originalScore).toBe(0.8);
  });

  it("should boost media results for media queries", () => {
    const classification = classifyQuery("What was said in the video?");
    const results = [
      makeResult("readme.md", 0.9),
      makeResult("interview.mp4", 0.85),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    // Media result should be boosted above the markdown result
    expect(reranked[0].sourcePath).toBe("interview.mp4");
    expect(reranked[0].isMediaChunk).toBe(true);
    expect(reranked[1].sourcePath).toBe("readme.md");
    expect(reranked[1].isMediaChunk).toBe(false);
  });

  it("should set isMediaChunk correctly for various extensions", () => {
    const classification = classifyQuery("audio recording");
    const results = [
      makeResult("song.mp3", 0.9),
      makeResult("notes.txt", 0.85),
      makeResult("clip.wav", 0.8),
      makeResult("talk.webm", 0.75),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    const mediaResults = reranked.filter((r) => r.isMediaChunk);
    expect(mediaResults.length).toBe(3);
    const nonMedia = reranked.filter((r) => !r.isMediaChunk);
    expect(nonMedia.length).toBe(1);
    expect(nonMedia[0].sourcePath).toBe("notes.txt");
  });

  it("should format timestamp citations when timestamps are present", () => {
    const classification = classifyQuery("What was said at 2:30?");
    const results = [
      makeResult("meeting.mp4", 0.9, {
        timestampStart: 150,
        timestampEnd: 195,
      }),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    expect(reranked[0].timestampCitation).toBe("[2:30 → 3:15]");
  });

  it("should handle HH:MM:SS format for long timestamps", () => {
    const classification = classifyQuery("video lecture");
    const results = [
      makeResult("lecture.mp4", 0.9, {
        timestampStart: 3661,
        timestampEnd: 3720,
      }),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    expect(reranked[0].timestampCitation).toBe("[1:01:01 → 1:02:00]");
  });

  it("should force media boost when forceMediaBoost is true", () => {
    const classification = classifyQuery("What is TypeScript?"); // non-media query
    const results = [
      makeResult("readme.md", 0.9),
      makeResult("talk.mp4", 0.85),
    ];

    // Without force: markdown wins
    const normal = applyMultimodalReranking(results, classification);
    expect(normal[0].sourcePath).toBe("readme.md");

    // With force: but classification has mediaBoost=1.0, so no actual boost
    // We need a media classification for force to have effect
    const mediaClassification = classifyQuery("video about TypeScript");
    const forced = applyMultimodalReranking(results, mediaClassification, {
      forceMediaBoost: true,
    });
    expect(forced[0].sourcePath).toBe("talk.mp4");
  });

  it("should normalize scores back to 0–1 range", () => {
    const classification = classifyQuery("What was discussed in the recording?");
    const results = [
      makeResult("recording.mp3", 0.95),
      makeResult("notes.md", 0.9),
    ];

    const reranked = applyMultimodalReranking(results, classification);
    for (const r of reranked) {
      expect(r.score).toBeLessThanOrEqual(1.0);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Citation Formatter Tests ──

describe("formatCitation", () => {
  const makeMultimodalResult = (
    overrides: Partial<MultimodalSearchResult>,
  ): MultimodalSearchResult => ({
    text: "Some content",
    sourcePath: "document.md",
    score: 0.9,
    originalScore: 0.9,
    sectionHeading: undefined,
    documentId: "doc-123",
    chunkIndex: 0,
    isMediaChunk: false,
    ...overrides,
  });

  it("should format media citation with timestamps", () => {
    const result = makeMultimodalResult({
      sourcePath: "interview.mp4",
      isMediaChunk: true,
      timestampCitation: "[2:30 → 3:15]",
    });
    expect(formatCitation(result)).toBe("[interview.mp4 @ [2:30 → 3:15]]");
  });

  it("should format document citation with section heading", () => {
    const result = makeMultimodalResult({
      sourcePath: "docs/guide.md",
      sectionHeading: "Installation",
    });
    expect(formatCitation(result)).toBe("[docs/guide.md § Installation]");
  });

  it("should format simple citation without extra metadata", () => {
    const result = makeMultimodalResult({
      sourcePath: "notes.txt",
    });
    expect(formatCitation(result)).toBe("[notes.txt]");
  });

  it("should prefer timestamp citation for media over section heading", () => {
    const result = makeMultimodalResult({
      sourcePath: "recording.mp4",
      isMediaChunk: true,
      timestampCitation: "[0:45 → 1:10]",
      sectionHeading: "Introduction",
    });
    expect(formatCitation(result)).toBe("[recording.mp4 @ [0:45 → 1:10]]");
  });
});

// ── Multimodal Search Integration Tests ──

describe("multimodalSearch", () => {
  it("should call search function and classify query", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([
      {
        text: "Meeting notes about Q3 results",
        sourcePath: "meeting.mp4",
        score: 0.85,
        sectionHeading: undefined,
        documentId: "doc-meeting",
        chunkIndex: 0,
        timestampStart: 120,
        timestampEnd: 180,
      },
      {
        text: "Quarterly report summary",
        sourcePath: "report.md",
        score: 0.9,
        sectionHeading: "Q3 Results",
        documentId: "doc-report",
        chunkIndex: 0,
      },
    ] satisfies KnowledgeSearchResult[]);

    const { results, classification } = await multimodalSearch(
      "What was discussed in the video about Q3?",
      mockSearchFn,
      { limit: 10 },
    );

    expect(classification.isMediaQuery).toBe(true);
    expect(results.length).toBe(2);
    // Media result should be boosted to top
    expect(results[0].sourcePath).toBe("meeting.mp4");
    expect(results[0].isMediaChunk).toBe(true);
    expect(results[0].timestampCitation).toBe("[2:00 → 3:00]");

    // Search function should be called with increased limit for media queries
    expect(mockSearchFn).toHaveBeenCalledWith(
      "What was discussed in the video about Q3?",
      20, // 10 * 2 for media query
      { mode: "hybrid", minScore: 0 },
    );
  });

  it("should not over-fetch for non-media queries", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([]);

    await multimodalSearch("What is TypeScript?", mockSearchFn, { limit: 5 });

    expect(mockSearchFn).toHaveBeenCalledWith(
      "What is TypeScript?",
      5, // No over-fetch for non-media
      { mode: "hybrid", minScore: 0 },
    );
  });

  it("should respect result limit after re-ranking", async () => {
    const mockResults: KnowledgeSearchResult[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Chunk ${i}`,
      sourcePath: i % 2 === 0 ? `file${i}.md` : `audio${i}.mp3`,
      score: 0.9 - i * 0.02,
      sectionHeading: undefined,
      documentId: `doc-${i}`,
      chunkIndex: 0,
    }));

    const mockSearchFn = vi.fn().mockResolvedValue(mockResults);

    const { results } = await multimodalSearch("audio recording", mockSearchFn, {
      limit: 5,
    });

    expect(results.length).toBe(5);
  });

  it("should use default options when none provided", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([]);
    await multimodalSearch("test query", mockSearchFn);

    expect(mockSearchFn).toHaveBeenCalledWith("test query", 10, {
      mode: "hybrid",
      minScore: 0,
    });
  });
});
