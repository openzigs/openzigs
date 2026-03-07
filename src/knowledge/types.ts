/**
 * Types for the Local Knowledge Base (RAG) subsystem.
 *
 * The knowledge system ingests files from a configurable directory,
 * chunks them, generates embeddings, and stores vectors in LanceDB
 * for semantic retrieval via the `search-knowledge` MCP tool.
 */

/** Supported source formats for ingestion. */
export type KnowledgeSourceType = "markdown" | "text" | "pdf" | "docx" | "xlsx" | "json" | "csv" | "html" | "code" | "media" | "image";

/** Status of a document in the knowledge base. */
export type DocumentStatus = "pending" | "processing" | "indexed" | "failed";

/**
 * Visibility controls which contexts can surface a document in search results.
 * - `public`  — Safe to return everywhere, including social media auto-replies.
 * - `internal`— Visible to the user in chat/admin but NOT shared externally.
 * - `private` — Restricted to admin contexts only (sensitive config, credentials).
 */
export type KnowledgeVisibility = "public" | "internal" | "private";

/**
 * Category tags for faceted search and filtering.
 * Enables queries like "show me all media" or "find presentations about X".
 */
export type KnowledgeCategory = "document" | "media" | "presentation" | "social" | "system" | "conversation";

/** A raw source document before chunking. */
export type KnowledgeDocument = {
  /** Unique document ID (deterministic hash of file path). */
  id: string;
  /** Absolute file path on disk. */
  filePath: string;
  /** Relative path from the knowledge directory root. */
  relativePath: string;
  /** Detected source type. */
  sourceType: KnowledgeSourceType;
  /** File size in bytes. */
  sizeBytes: number;
  /** File mtime (ISO-8601) at last successful index — used as a fast pre-conversion change check. */
  fileMtime?: string;
  /** SHA-256 content hash for change detection. */
  contentHash: string;
  /** Current indexing status. */
  status: DocumentStatus;
  /** Number of chunks produced. */
  chunkCount: number;
  /** ISO-8601 timestamp of last successful indexing. */
  indexedAt: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Error message if status is "failed". */
  error?: string;
  /** Visibility level for access control. Defaults to "internal". */
  visibility?: KnowledgeVisibility;
  /** Content category for faceted filtering. */
  category?: KnowledgeCategory;
  /** Serving URL for media assets (images/audio/video). */
  mediaUrl?: string;
  /** Gallery asset ID (for gallery → RAG link). */
  assetId?: string;
  /** True when the converter pipeline (OCR/Whisper/vision) ran successfully for this asset. */
  hasAiAnalysis?: boolean;
};

/** A single chunk produced by the chunker. */
export type KnowledgeChunk = {
  /** Unique chunk ID. */
  id: string;
  /** Parent document ID. */
  documentId: string;
  /** The plain-text content of this chunk. */
  text: string;
  /** Zero-based chunk index within the document. */
  chunkIndex: number;
  /** Source file relative path (denormalized for search results). */
  sourcePath: string;
  /** Section heading context (for markdown headings). */
  sectionHeading?: string;
  /** Embedding vector (populated by the embedder). */
  vector?: number[];
  /** Timestamp start in seconds (for audio/video transcript chunks). */
  timestampStart?: number;
  /** Timestamp end in seconds (for audio/video transcript chunks). */
  timestampEnd?: number;
  /** Document content type hint for multimodal retrieval. */
  documentType?: KnowledgeSourceType;
  /** Visibility level for access control filtering. */
  visibility?: KnowledgeVisibility;
  /** Content category for faceted filtering. */
  category?: KnowledgeCategory;
  /** Serving URL for media assets. */
  mediaUrl?: string;
};

/** A search result returned from the vector store. */
export type KnowledgeSearchResult = {
  /** Chunk text. */
  text: string;
  /** Source file path. */
  sourcePath: string;
  /** Cosine similarity score (0–1, higher is better). */
  score: number;
  /** Section heading context. */
  sectionHeading?: string;
  /** Parent document ID. */
  documentId: string;
  /** Chunk index within the document. */
  chunkIndex: number;
  /** Timestamp start in seconds (for audio/video transcript chunks). */
  timestampStart?: number;
  /** Timestamp end in seconds (for audio/video transcript chunks). */
  timestampEnd?: number;
  /** Document content type hint. */
  documentType?: KnowledgeSourceType;
  /** Whether this document has persisted keyframe images available. */
  hasKeyframes?: boolean;
  /** Visibility level for access control filtering. */
  visibility?: KnowledgeVisibility;
  /** Content category. */
  category?: KnowledgeCategory;
  /** Serving URL for media assets (enables inline playback in chat). */
  mediaUrl?: string;
};

/** Options for filtering knowledge search results. */
export type KnowledgeSearchFilter = {
  /** Only include results with this visibility (or less restrictive). */
  visibility?: KnowledgeVisibility;
  /** Only include results from these categories. */
  categories?: KnowledgeCategory[];
};

/** A persisted keyframe image from a video document. */
export type KeyframeEntry = {
  /** Zero-based index of the keyframe. */
  index: number;
  /** Filename of the JPEG image (e.g. "frame_0001.jpg"). */
  filename: string;
  /** Timestamp in the video (seconds) where this frame was extracted. */
  timestamp: number;
  /** Visual description generated by Copilot Vision. */
  description: string;
};

/** Manifest for persisted keyframe images of a video document. */
export type KeyframeManifest = {
  /** Document ID this manifest belongs to. */
  documentId: string;
  /** Original source file name. */
  sourceFile: string;
  /** Directory where keyframe images are stored. */
  directory: string;
  /** Individual keyframe entries. */
  frames: KeyframeEntry[];
  /** ISO-8601 timestamp when keyframes were extracted. */
  extractedAt: string;
};

/** Statistics for the knowledge base. */
export type KnowledgeStats = {
  totalDocuments: number;
  totalChunks: number;
  indexedDocuments: number;
  failedDocuments: number;
  pendingDocuments: number;
  totalSizeBytes: number;
  lastIndexedAt: string | null;
};

/** Search mode for knowledge queries. */
export type KnowledgeSearchMode = "vector" | "fts" | "hybrid";

/** Configuration for the knowledge subsystem. */
export type KnowledgeConfig = {
  /** Whether the knowledge base is enabled. */
  enabled: boolean;
  /** Directory to watch for knowledge files. Defaults to ~/.openzigs/knowledge. */
  directory: string;
  /** Maximum chunk size in characters. */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters. */
  chunkOverlap: number;
  /** Maximum number of search results to return. */
  maxResults: number;
  /** File extensions to include. Empty = all supported. */
  includeExtensions: string[];
  /** File/directory patterns to exclude (glob-style). */
  excludePatterns: string[];
  /** Whether to watch the directory for changes. */
  watchEnabled: boolean;
  /** Whisper model used by the media converter (e.g. tiny.en, base.en, small.en). */
  mediaModel: string;
  /** Minimum similarity score (0–1) to include in results. 0 = no threshold. */
  minScore: number;
  /** Default search mode: vector (semantic), fts (keyword), or hybrid (combined). */
  searchMode: KnowledgeSearchMode;
};

/** Default knowledge configuration values. */
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  directory: "",  // Resolved at runtime to ~/.openzigs/knowledge
  chunkSize: 1000,
  chunkOverlap: 200,
  maxResults: 10,
  includeExtensions: [],
  excludePatterns: ["node_modules", ".git", "dist", "build", ".DS_Store"],
  watchEnabled: true,
  mediaModel: "base.en",
  minScore: 0.65,
  searchMode: "hybrid",
};

/** Options for ingesting virtual (non-file) documents. */
export type IngestVirtualOptions = {
  /** Visibility level. Defaults to "internal". */
  visibility?: KnowledgeVisibility;
  /** Content category. Defaults to "document". */
  category?: KnowledgeCategory;
  /** Serving URL for media assets (stored in each chunk for retrieval). */
  mediaUrl?: string;
  /** Gallery asset ID for linking back to gallery. */
  assetId?: string;
};

/** Events emitted by the KnowledgeIngestionService. */
export type KnowledgeServiceEvent =
  | { type: "document:indexed"; document: KnowledgeDocument }
  | { type: "document:failed"; document: KnowledgeDocument; error: string }
  | { type: "document:deleted"; documentId: string; filePath: string }
  | { type: "indexing:started"; fileCount: number }
  | { type: "indexing:completed"; indexed: number; failed: number; duration: number }
  | { type: "watcher:ready" }
  | { type: "watcher:error"; error: string };
