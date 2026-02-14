/**
 * Types for the Local Knowledge Base (RAG) subsystem.
 *
 * The knowledge system ingests files from a configurable directory,
 * chunks them, generates embeddings, and stores vectors in LanceDB
 * for semantic retrieval via the `search-knowledge` MCP tool.
 */

/** Supported source formats for ingestion. */
export type KnowledgeSourceType = "markdown" | "text" | "pdf" | "docx" | "json" | "csv" | "html" | "code" | "media" | "image";

/** Status of a document in the knowledge base. */
export type DocumentStatus = "pending" | "processing" | "indexed" | "failed";

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
