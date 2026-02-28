/**
 * LanceDB vector store for the knowledge base.
 *
 * Provides CRUD operations over embedded knowledge chunks:
 * - addChunks: upsert chunks with vectors into the table.
 * - search: semantic similarity search over stored chunks.
 * - fullTextSearch: keyword search using LanceDB FTS index.
 * - hybridSearch: combined vector + FTS with reciprocal rank fusion.
 * - deleteByDocumentId: remove all chunks for a given document.
 * - getStats: return row counts and metadata.
 */

import * as lancedb from "@lancedb/lancedb";
import { getEmbeddingDim, generateEmbedding } from "./embedder.js";
import type { KnowledgeChunk, KnowledgeSearchResult, KnowledgeSearchMode } from "./types.js";
import { logger } from "../logging/logger.js";

/**
 * Cosine distance for semantic similarity.
 * Range: 0 (identical) to 2 (opposite). LanceDB default is L2.
 */
const DISTANCE_TYPE = "cosine" as const;

const TABLE_NAME = "knowledge_chunks";

/**
 * Reciprocal Rank Fusion constant (k=60 is the standard default).
 * Higher values reduce the influence of individual ranking positions.
 */
const RRF_K = 60;

export type LanceDBStoreOptions = {
  /** Path to the LanceDB database directory. */
  dbPath: string;
};

export class LanceDBStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private dbPath: string;
  private initialized = false;
  private ftsIndexCreated = false;

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
   * then inserts the new chunks. Creates both vector and FTS indexes.
   */
  async addChunks(chunks: KnowledgeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureInitialized();

    // Ensure all chunks have vectors (generate if missing)
    const rows = await Promise.all(
      chunks.map(async (chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        sourcePath: chunk.sourcePath,
        sectionHeading: chunk.sectionHeading ?? "",
        vector: chunk.vector ?? await generateEmbedding(chunk.text),
      })),
    );

    // Delete existing chunks for this document (upsert)
    const documentId = chunks[0].documentId;
    await this.deleteByDocumentId(documentId);

    if (!this.table) {
      // Create the table with the first batch
      this.table = await this.db!.createTable(TABLE_NAME, rows);
      // Create a vector index with cosine distance for semantic search
      try {
        await this.table.createIndex("vector", {
          config: lancedb.Index.ivfPq({
            distanceType: DISTANCE_TYPE,
          }),
        });
      } catch {
        // Index creation may fail on small tables — search still works via brute force
      }
      logger.info(`[KnowledgeStore] Created table "${TABLE_NAME}" with ${rows.length} rows (cosine distance)`);
    } else {
      await this.table.add(rows);
      logger.info(`[KnowledgeStore] Added ${rows.length} chunks for document ${documentId}`);
    }

    // (Re)create the FTS index after data changes
    await this.ensureFtsIndex();
  }

  /**
   * Create or rebuild the full-text search index on the text column.
   * Called after addChunks to keep the FTS index current.
   */
  private async ensureFtsIndex(): Promise<void> {
    if (!this.table) return;

    try {
      await this.table.createIndex("text", {
        config: lancedb.Index.fts({
          withPosition: true,
          stem: true,
          removeStopWords: true,
        }),
        replace: true,
      });
      this.ftsIndexCreated = true;
      logger.debug("[KnowledgeStore] FTS index created/rebuilt on text column");
    } catch (error) {
      // FTS index creation is optional — log but don't fail
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[KnowledgeStore] FTS index creation failed (search still works via vector): ${msg}`);
    }
  }

  /**
   * Perform a semantic similarity search over the knowledge base.
   *
   * @param query - The search query text.
   * @param limit - Maximum number of results to return.
   * @param minScore - Minimum similarity score (0–1) to include. 0 = no threshold.
   * @returns Ranked search results with similarity scores.
   */
  async search(query: string, limit: number = 10, minScore: number = 0): Promise<KnowledgeSearchResult[]> {
    if (!this.table) return [];
    await this.ensureInitialized();

    try {
      const queryVector = await generateEmbedding(query);
      const results = await this.table
        .vectorSearch(queryVector)
        .distanceType(DISTANCE_TYPE)
        .limit(limit)
        .toArray();

      return this.mapResults(results, minScore);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[KnowledgeStore] Search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Full-text keyword search using the LanceDB FTS index.
   * Falls back to vector search if FTS index is unavailable.
   *
   * @param query - The keyword search query.
   * @param limit - Maximum number of results to return.
   * @param minScore - Minimum score to include. 0 = no threshold.
   * @returns Ranked search results.
   */
  async fullTextSearch(query: string, limit: number = 10, minScore: number = 0): Promise<KnowledgeSearchResult[]> {
    if (!this.table) return [];
    await this.ensureInitialized();

    if (!this.ftsIndexCreated) {
      logger.debug("[KnowledgeStore] FTS index not available, falling back to vector search");
      return this.search(query, limit, minScore);
    }

    try {
      const results = await this.table
        .search(query, "fts")
        .limit(limit)
        .toArray();

      return results.map((row: Record<string, unknown>, idx: number) => ({
        text: String(row.text ?? ""),
        sourcePath: String(row.sourcePath ?? ""),
        // FTS results don't have a cosine distance — use rank-based score
        score: typeof row._score === "number"
          ? Math.min(1, row._score as number)
          : 1 - idx / (results.length || 1),
        sectionHeading: row.sectionHeading ? String(row.sectionHeading) : undefined,
        documentId: String(row.documentId ?? ""),
        chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : 0,
      })).filter((r) => minScore <= 0 || r.score >= minScore);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[KnowledgeStore] FTS search failed, falling back to vector: ${msg}`);
      return this.search(query, limit, minScore);
    }
  }

  /**
   * Hybrid search: combines vector (semantic) and FTS (keyword) results
   * using Reciprocal Rank Fusion for re-ranking.
   *
   * This gives the best of both worlds — semantic understanding for
   * conceptual queries plus exact keyword matching for specific terms.
   *
   * @param query - The search query.
   * @param limit - Maximum number of results to return.
   * @param minScore - Minimum score to include. 0 = no threshold.
   * @returns Re-ranked search results combining both strategies.
   */
  async hybridSearch(query: string, limit: number = 10, minScore: number = 0): Promise<KnowledgeSearchResult[]> {
    if (!this.table) return [];
    await this.ensureInitialized();

    // If no FTS index, just do vector search
    if (!this.ftsIndexCreated) {
      return this.search(query, limit, minScore);
    }

    try {
      // Run both searches in parallel, fetch more candidates than needed for fusion
      const candidateLimit = Math.min(limit * 3, 50);
      const [vectorResults, ftsResults] = await Promise.all([
        this.search(query, candidateLimit),
        this.fullTextSearch(query, candidateLimit),
      ]);

      // Reciprocal Rank Fusion — merge results by chunk ID
      const scoreMap = new Map<string, { score: number; result: KnowledgeSearchResult }>();

      // Add vector search results
      vectorResults.forEach((result, rank) => {
        const key = `${result.documentId}:${result.chunkIndex}`;
        const rrfScore = 1 / (RRF_K + rank + 1);
        scoreMap.set(key, { score: rrfScore, result });
      });

      // Add FTS results
      ftsResults.forEach((result, rank) => {
        const key = `${result.documentId}:${result.chunkIndex}`;
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) {
          // Present in both — sum the RRF scores (boost)
          existing.score += rrfScore;
        } else {
          scoreMap.set(key, { score: rrfScore, result });
        }
      });

      // Sort by combined score descending, normalize to 0–1
      const merged = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score);

      // Use the original vector/FTS score from the best-scoring source for
      // minScore filtering. RRF rank scores are relative and would defeat
      // any absolute threshold, so we keep the underlying similarity score
      // for the filter and only use RRF for ordering.
      return merged
        .slice(0, limit)
        .map(({ result }) => result)
        .filter((r) => minScore <= 0 || r.score >= minScore);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[KnowledgeStore] Hybrid search failed: ${msg}`);
      // Fall back to pure vector search
      return this.search(query, limit, minScore);
    }
  }

  /**
   * Route a search to the appropriate strategy.
   */
  async searchByMode(
    query: string,
    limit: number = 10,
    mode: KnowledgeSearchMode = "hybrid",
    minScore: number = 0,
  ): Promise<KnowledgeSearchResult[]> {
    switch (mode) {
      case "fts":
        return this.fullTextSearch(query, limit, minScore);
      case "hybrid":
        return this.hybridSearch(query, limit, minScore);
      case "vector":
      default:
        return this.search(query, limit, minScore);
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
    this.ftsIndexCreated = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Map raw LanceDB vector result rows to KnowledgeSearchResult,
   * converting cosine distance to similarity score and filtering by minScore.
   */
  private mapResults(rows: Record<string, unknown>[], minScore: number): KnowledgeSearchResult[] {
    return rows
      .map((row) => ({
        text: String(row.text ?? ""),
        sourcePath: String(row.sourcePath ?? ""),
        // Cosine distance ranges 0 (identical) to 2 (opposite).
        // Convert to similarity: 1 - (distance / 2) gives 0–1 range.
        score: typeof row._distance === "number"
          ? Math.max(0, 1 - (row._distance as number) / 2)
          : 0,
        sectionHeading: row.sectionHeading ? String(row.sectionHeading) : undefined,
        documentId: String(row.documentId ?? ""),
        chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : 0,
      }))
      .filter((r) => minScore <= 0 || r.score >= minScore);
  }
}
