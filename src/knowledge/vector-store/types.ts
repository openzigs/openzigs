/**
 * Vector Store Abstraction — Interface and supporting types.
 * Issue #718: Enables pluggable vector store backends (LanceDB, Qdrant, Chroma, etc.)
 */

import type {
  KnowledgeChunk,
  KnowledgeSearchResult,
  KnowledgeSearchMode,
} from "../types.js";

/**
 * Abstract interface for a vector store backend.
 *
 * All vector store providers (LanceDB, Qdrant, Chroma, pgvector, etc.)
 * must implement this interface. The knowledge service interacts exclusively
 * through this contract — no provider-specific imports leak into the service layer.
 */
export interface VectorStore {
  /** Initialize the connection and ensure tables/collections exist. */
  initialize(): Promise<void>;

  /** Close the connection and clean up resources. */
  close(): Promise<void>;

  /** Add or replace chunks for a document (upsert behaviour). */
  addChunks(chunks: KnowledgeChunk[]): Promise<void>;

  /** Delete all chunks associated with a document. */
  deleteByDocumentId(documentId: string): Promise<void>;

  /** Semantic similarity search. */
  search(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]>;

  /** Full-text keyword search. Falls back to vector search if unavailable. */
  fullTextSearch(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]>;

  /** Combined vector + FTS search with reciprocal rank fusion. */
  hybridSearch(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]>;

  /** Route a search to the appropriate strategy based on mode. */
  searchByMode(query: string, limit?: number, mode?: KnowledgeSearchMode, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]>;

  /** Rebuild the full-text search index (if supported by the provider). */
  rebuildFtsIndex(): Promise<void>;

  /** Get the total number of chunks in the store. */
  countChunks(): Promise<number>;

  /** List all unique document IDs in the store. */
  listDocumentIds(): Promise<string[]>;

  /**
   * Build a SQL/filter WHERE clause from a KnowledgeSearchFilter.
   * This is provider-specific; the default implementation is provided as a static utility.
   */
}

/** Supported vector store provider identifiers. */
export type VectorStoreProvider = "lancedb";

/** Configuration for the vector store subsystem. */
export interface VectorStoreConfig {
  /** Which vector store provider to use. Defaults to "lancedb". */
  provider: VectorStoreProvider;
  /** Provider-specific options (e.g. dbPath for LanceDB, url for Qdrant). */
  options?: Record<string, unknown>;
}
