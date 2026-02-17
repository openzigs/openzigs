/**
 * Query Classifier — detects whether a query targets multimodal content.
 *
 * Issue #263: Multimodal RAG Retrieval
 *
 * Classifies incoming knowledge base queries to determine if they should
 * be routed with multimodal awareness (e.g., boosting audio/video transcript
 * results, adding timestamp citations, or filtering by source type).
 */

import type { KnowledgeSourceType } from "./types.js";

/** Classification of a knowledge query */
export type QueryClassification = {
  /** Whether the query likely targets media content (audio/video). */
  isMediaQuery: boolean;
  /** Detected target source types (empty = all types). */
  targetTypes: KnowledgeSourceType[];
  /** Whether timestamps should be included in results. */
  includeTimestamps: boolean;
  /** Boost multiplier for media results (1.0 = no boost). */
  mediaBoost: number;
  /** Extracted temporal references (e.g., "at 5 minutes", "first segment"). */
  temporalHints: string[];
};

/** Keywords that indicate a media/audio/video query. */
const MEDIA_KEYWORDS = [
  "audio", "video", "recording", "podcast", "interview",
  "episode", "talk", "speech", "presentation", "lecture",
  "transcript", "transcription", "said", "spoke", "mentioned",
  "listen", "watch", "heard", "played", "narration",
  "voice", "speaker", "dialogue", "conversation",
  "mp3", "mp4", "wav", "m4a", "webm",
];

/** Temporal reference patterns. */
const TEMPORAL_PATTERNS = [
  /at\s+(\d+)\s*(?:min(?:ute)?s?)(?:\s+(\d+)\s*(?:sec(?:ond)?s?))?/gi,
  /(?:around|about|near)\s+(\d+)\s*(?:min(?:ute)?s?)/gi,
  /(\d+):(\d+)(?::(\d+))?/g,  // HH:MM:SS or MM:SS format
  /(?:first|second|third|last|beginning|end|start|middle)\s+(?:part|segment|section|half)/gi,
  /(?:minute|second|hour)\s+(\d+)/gi,
  /timestamp/gi,
];

/** Image-related keywords. */
const IMAGE_KEYWORDS = [
  "image", "picture", "photo", "screenshot", "diagram",
  "chart", "graph", "figure", "illustration", "scan",
];

/**
 * Classify a knowledge query to determine multimodal intent.
 *
 * @param query - The raw user query string.
 * @returns Classification result with media intent, target types, and temporal hints.
 */
export function classifyQuery(query: string): QueryClassification {
  const lowerQuery = query.toLowerCase();

  // Check for media keywords
  const mediaKeywordCount = MEDIA_KEYWORDS.filter((kw) => lowerQuery.includes(kw)).length;
  const imageKeywordCount = IMAGE_KEYWORDS.filter((kw) => lowerQuery.includes(kw)).length;

  // Extract temporal hints
  const temporalHints: string[] = [];
  for (const pattern of TEMPORAL_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      temporalHints.push(match[0]);
    }
  }

  // Determine target source types
  const targetTypes: KnowledgeSourceType[] = [];
  if (mediaKeywordCount > 0 || temporalHints.length > 0) {
    targetTypes.push("media");
  }
  if (imageKeywordCount > 0) {
    targetTypes.push("image");
  }

  // Determine if this is a media query
  const isMediaQuery = mediaKeywordCount >= 1 || imageKeywordCount >= 1 || temporalHints.length > 0;

  // Media boost: scale from 1.0 (no boost) to 1.5 (strong media intent)
  let mediaBoost = 1.0;
  if (mediaKeywordCount >= 3) {
    mediaBoost = 1.5;
  } else if (mediaKeywordCount >= 2 || temporalHints.length > 0) {
    mediaBoost = 1.3;
  } else if (mediaKeywordCount === 1) {
    mediaBoost = 1.15;
  }

  return {
    isMediaQuery,
    targetTypes,
    includeTimestamps: isMediaQuery || temporalHints.length > 0,
    mediaBoost,
    temporalHints,
  };
}
