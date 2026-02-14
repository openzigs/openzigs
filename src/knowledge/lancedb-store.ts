/**
 * LanceDB vector store for the knowledge base.
 *
 * Provides CRUD operations over embedded knowledge chunks:
 * - addChunks: upsert chunks with vectors into the table.
 * - search: semantic similarity search over stored chunks.
 * - deleteByDocumentId: remove all chunks for a given document.
 * - getStats: return row counts and metadata.
 */

import * as lancedb from "@lancedb/lancedb";
import { getEmbeddingDim, generateEmbedding } from "./embedder.js";
import type { KnowledgeChunk, KnowledgeSearchResult } from "./types.js";
import { logger } from "../logging/logger.js";

const TABLE_NAME = "knowledge_chunks";

export type LanceDBStoreOptions = {
  /** Path to the LanceDB database directory. */
  dbPath: string;
};

export class LanceDBStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private dbPath: string;
  private initialized = false;

  constructor({ dbPath }: LanceDBStoreOptions) {
    this.dbPath = dbPath;
  }

  /**
   * Initialize the LanceDB connection and ensure the table exists.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.db = await lancedb.connect(this.dbPath);
      const tableNames = await this.db.tableNames();

      if (tableNames.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
      }
      // Table is created lazily on first addChunks call

      this.initialized = true;
      logger.info(`[KnowledgeStore] LanceDB initialized at ${this.dbPath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[KnowledgeStore] Failed to initialize LanceDB: ${msg}`);
      throw error;
    }
  }

  /**
   * Add or replace chunks for a document in the vector store.
   *
   * Deletes existing chunks for the document first (upsert behavior),
   * then inserts the new chunks.
   */
  async addChunks(chunks: KnowledgeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureInitialized();

    // Ensure all chunks have vectors
    const rows = chunks.map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      text: chunk.text,
      chunkIndex: chunk.chunkIndex,
      sourcePath: chunk.sourcePath,
      sectionHeading: chunk.sectionHeading ?? "",
      vector: chunk.vector ?? generateEmbedding(chunk.text),
    }));

    // Delete existing chunks for this document (upsert)
    const documentId = chunks[0].documentId;
    await this.deleteByDocumentId(documentId);

    if (!this.table) {
      // Create the table with the first batch
      this.table = await this.db!.createTable(TABLE_NAME, rows);
      logger.info(`[KnowledgeStore] Created table "${TABLE_NAME}" with ${rows.length} rows`);
    } else {
      await this.table.add(rows);
      logger.info(`[KnowledgeStore] Added ${rows.length} chunks for document ${documentId}`);
    }
  }

  /**
   * Perform a semantic similarity search over the knowledge base.
   *
   * @param query - The search query text.
   * @param limit - Maximum number of results to return.
   * @returns Ranked search results with similarity scores.
   */
  async search(query: string, limit: number = 10): Promise<KnowledgeSearchResult[]> {
    if (!this.table) return [];
    await this.ensureInitialized();

    try {
      const queryVector = generateEmbedding(query);
      const results = await this.table.search(queryVector).limit(limit).toArray();

      return results.map((row) => ({
        text: String(row.text ?? ""),
        sourcePath: String(row.sourcePath ?? ""),
        score: typeof row._distance === "number" ? 1 - row._distance : 0,
        sectionHeading: row.sectionHeading ? String(row.sectionHeading) : undefined,
        documentId: String(row.documentId ?? ""),
        chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : 0,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[KnowledgeStore] Search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Delete all chunks associated with a document.
   */
  async deleteByDocumentId(documentId: string): Promise<void> {
    if (!this.table) return;
    await this.ensureInitialized();

    try {
      await this.table.delete(`documentId = '${documentId.replace(/'/g, "''")}'`);
    } catch (error) {
      // Table may be empty or filter returns nothing — that's fine
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug(`[KnowledgeStore] Delete for ${documentId}: ${msg}`);
    }
  }

  /**
   * Get the total number of chunks in the store.
   */
  async countChunks(): Promise<number> {
    if (!this.table) return 0;
    await this.ensureInitialized();

    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }

  /**
   * List all unique document IDs in the store.
   */
  async listDocumentIds(): Promise<string[]> {
    if (!this.table) return [];
    await this.ensureInitialized();

    try {
      const rows = await this.table.search(new Array(getEmbeddingDim()).fill(0))
        .select(["documentId"])
        .limit(10000)
        .toArray();

      const ids = new Set<string>();
      for (const row of rows) {
        if (row.documentId) ids.add(String(row.documentId));
      }
      return Array.from(ids);
    } catch {
      return [];
    }
  }

  /**
   * Close the LanceDB connection.
   */
  async close(): Promise<void> {
    this.table = null;
    this.db = null;
    this.initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
