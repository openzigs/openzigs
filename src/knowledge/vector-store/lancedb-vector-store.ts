/**
 * LanceDB implementation of the VectorStore interface.
 * Issue #715: Wraps the existing LanceDBStore, implementing the VectorStore contract.
 *
 * This is a thin adapter — all real logic remains in the original LanceDBStore class,
 * which is the battle-tested implementation. This layer exists purely to satisfy
 * the VectorStore interface so that KnowledgeIngestionService can accept any provider.
 */

import { LanceDBStore } from "../lancedb-store.js";
import type { LanceDBStoreOptions } from "../lancedb-store.js";
import type { KnowledgeChunk, KnowledgeSearchResult, KnowledgeSearchMode, KnowledgeSearchFilter } from "../types.js";
import type { VectorStore } from "./types.js";

export type LanceDBVectorStoreOptions = LanceDBStoreOptions;

export class LanceDBVectorStore implements VectorStore {
  private delegate: LanceDBStore;

  constructor(options: LanceDBVectorStoreOptions) {
    this.delegate = new LanceDBStore(options);
  }

  async initialize(): Promise<void> {
    return this.delegate.initialize();
  }

  async close(): Promise<void> {
    return this.delegate.close();
  }

  async addChunks(chunks: KnowledgeChunk[]): Promise<void> {
    return this.delegate.addChunks(chunks);
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    return this.delegate.deleteByDocumentId(documentId);
  }

  async search(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]> {
    return this.delegate.search(query, limit, minScore, filter);
  }

  async fullTextSearch(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]> {
    return this.delegate.fullTextSearch(query, limit, minScore, filter);
  }

  async hybridSearch(query: string, limit?: number, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]> {
    return this.delegate.hybridSearch(query, limit, minScore, filter);
  }

  async searchByMode(query: string, limit?: number, mode?: KnowledgeSearchMode, minScore?: number, filter?: string): Promise<KnowledgeSearchResult[]> {
    return this.delegate.searchByMode(query, limit, mode, minScore, filter);
  }

  async rebuildFtsIndex(): Promise<void> {
    return this.delegate.rebuildFtsIndex();
  }

  async countChunks(): Promise<number> {
    return this.delegate.countChunks();
  }

  async listDocumentIds(): Promise<string[]> {
    return this.delegate.listDocumentIds();
  }

  /**
   * Build a SQL WHERE clause from a KnowledgeSearchFilter.
   * Delegates to the static utility on LanceDBStore.
   */
  static buildFilterClause(filter?: KnowledgeSearchFilter): string | undefined {
    return LanceDBStore.buildFilterClause(filter);
  }
}
