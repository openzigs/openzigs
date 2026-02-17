/**
 * Multimodal Retriever — type-aware search with media boosting and timestamp citations.
 *
 * Issue #263: Multimodal RAG Retrieval
 *
 * Wraps the standard knowledge search with multimodal awareness:
 * - Classifies queries for media intent
 * - Applies source-type boost multipliers to re-rank results
 * - Formats results with timestamp citations for audio/video content
 * - Supports filtering by source type
 */

import type { KnowledgeSearchResult, KnowledgeSearchMode } from "./types.js";
import { classifyQuery, type QueryClassification } from "./query-classifier.js";

/** Options for multimodal search. */
export type MultimodalSearchOptions = {
  /** Maximum number of results to return. */
  limit?: number;
  /** Minimum similarity score threshold. */
  minScore?: number;
  /** Search mode: vector, fts, or hybrid. */
  mode?: KnowledgeSearchMode;
  /** Force media boost regardless of query classification. */
  forceMediaBoost?: boolean;
};

/** Extended search result with multimodal metadata. */
export type MultimodalSearchResult = KnowledgeSearchResult & {
  /** Whether this chunk comes from a media transcript. */
  isMediaChunk: boolean;
  /** Formatted timestamp citation (e.g., "[2:30 → 3:15]"). */
  timestampCitation?: string;
  /** Original score before type-aware boosting. */
  originalScore: number;
};

/** Media source extensions that indicate audio/video transcripts. */
const MEDIA_EXTENSIONS = new Set([".mp4", ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac"]);

/** Check if a source path represents a media file. */
function isMediaSource(sourcePath: string): boolean {
  const ext = sourcePath.toLowerCase().replace(/.*(\.\w+)$/, "$1");
  return MEDIA_EXTENSIONS.has(ext);
}

/** Format seconds to MM:SS or HH:MM:SS. */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Apply multimodal re-ranking to standard search results.
 *
 * Boosts or de-prioritizes results based on:
 * - Query classification (media intent detection)
 * - Source type matching (media files get boosted for media queries)
 * - Timestamp presence (chunks with timestamps are preferred for media queries)
 *
 * @param results - Standard search results from the knowledge store.
 * @param classification - Query classification from the classifier.
 * @param options - Search options.
 * @returns Re-ranked results with multimodal metadata.
 */
export function applyMultimodalReranking(
  results: KnowledgeSearchResult[],
  classification: QueryClassification,
  options: MultimodalSearchOptions = {},
): MultimodalSearchResult[] {
  const { forceMediaBoost = false } = options;
  const shouldBoostMedia = classification.isMediaQuery || forceMediaBoost;

  const enriched: MultimodalSearchResult[] = results.map((result) => {
    const isMedia = isMediaSource(result.sourcePath);
    const hasTimestamps = result.timestampStart !== undefined && result.timestampEnd !== undefined;

    // Calculate boosted score
    let boostedScore = result.score;
    if (shouldBoostMedia && isMedia) {
      boostedScore *= classification.mediaBoost;
    }

    // Additional boost for chunks with precise timestamps when timestamps are requested
    if (classification.includeTimestamps && hasTimestamps) {
      boostedScore *= 1.05;
    }

    // Format timestamp citation
    let timestampCitation: string | undefined;
    if (hasTimestamps && result.timestampStart !== undefined && result.timestampEnd !== undefined) {
      timestampCitation = `[${formatTimestamp(result.timestampStart)} → ${formatTimestamp(result.timestampEnd)}]`;
    }

    return {
      ...result,
      score: boostedScore,
      originalScore: result.score,
      isMediaChunk: isMedia,
      timestampCitation,
    };
  });

  // Re-sort by boosted score
  enriched.sort((a, b) => b.score - a.score);

  // Normalize scores back to 0–1 range
  const maxScore = enriched[0]?.score ?? 1;
  if (maxScore > 1) {
    for (const result of enriched) {
      result.score = result.score / maxScore;
    }
  }

  return enriched;
}

/**
 * Format a multimodal search result as a citation string.
 *
 * Produces human-readable citations like:
 * - `[interview.mp4 @ 2:30-3:15]` for media with timestamps
 * - `[report.pdf § Introduction]` for documents with headings
 * - `[notes.md]` for simple sources
 *
 * @param result - A multimodal search result.
 * @returns Formatted citation string.
 */
export function formatCitation(result: MultimodalSearchResult): string {
  const source = result.sourcePath;

  if (result.isMediaChunk && result.timestampCitation) {
    return `[${source} @ ${result.timestampCitation}]`;
  }

  if (result.sectionHeading) {
    return `[${source} § ${result.sectionHeading}]`;
  }

  return `[${source}]`;
}

/**
 * Perform a multimodal-aware search over the knowledge base.
 *
 * This is the main entry point for queries that may target media content.
 * It classifies the query, runs the appropriate search, and applies
 * multimodal re-ranking with citations.
 *
 * @param query - The search query text.
 * @param searchFn - The underlying search function (from KnowledgeIngestionService).
 * @param options - Search options.
 * @returns Re-ranked results with multimodal metadata and citations.
 */
export async function multimodalSearch(
  query: string,
  searchFn: (
    query: string,
    limit: number,
    options?: { mode?: KnowledgeSearchMode; minScore?: number },
  ) => Promise<KnowledgeSearchResult[]>,
  options: MultimodalSearchOptions = {},
): Promise<{
  results: MultimodalSearchResult[];
  classification: QueryClassification;
}> {
  const classification = classifyQuery(query);

  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0;
  const mode = options.mode ?? "hybrid";

  // Fetch more candidates when boosting to ensure enough results after re-ranking
  const fetchLimit = classification.isMediaQuery ? Math.min(limit * 2, 50) : limit;

  const rawResults = await searchFn(query, fetchLimit, { mode, minScore });

  const reranked = applyMultimodalReranking(rawResults, classification, options);

  return {
    results: reranked.slice(0, limit),
    classification,
  };
}
