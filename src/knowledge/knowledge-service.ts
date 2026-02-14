/**
 * Knowledge Ingestion Service — the central coordinator for the knowledge base.
 *
 * Responsibilities:
 * - Watch a knowledge directory for file changes (add/modify/delete).
 * - Read and convert files to plain text.
 * - Chunk text and generate embeddings.
 * - Store vectors in LanceDB.
 * - Track document metadata (status, hashes, chunk counts).
 * - Expose stats and search functionality.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "chokidar";
import { chunkText } from "./chunker.js";
import { generateEmbedding } from "./embedder.js";
import { LanceDBStore } from "./lancedb-store.js";
import { ConverterRegistry, createDefaultRegistry } from "./converters/index.js";
import type {
  KnowledgeDocument,
  KnowledgeConfig,
  KnowledgeStats,
  KnowledgeSearchResult,
  KnowledgeServiceEvent,
  KnowledgeSourceType,
  KnowledgeChunk,
} from "./types.js";
import { DEFAULT_KNOWLEDGE_CONFIG } from "./types.js";
import { logger } from "../logging/logger.js";

export type KnowledgeServiceOptions = {
  config?: Partial<KnowledgeConfig>;
};

/** File extension → source type mapping. */
const EXTENSION_MAP: Record<string, KnowledgeSourceType> = {
  // Text / markup
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
  ".json": "json",
  ".csv": "csv",
  ".html": "html",
  ".htm": "html",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".xml": "text",
  // Code
  ".py": "code",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".go": "code",
  ".rs": "code",
  ".java": "code",
  ".c": "code",
  ".cpp": "code",
  ".h": "code",
  ".rb": "code",
  ".php": "code",
  ".swift": "code",
  ".kt": "code",
  ".sh": "code",
  ".bash": "code",
  ".zsh": "code",
  ".sql": "code",
  ".r": "code",
  ".R": "code",
  // Documents (require converters)
  ".pdf": "pdf",
  ".docx": "docx",
};

const resolveKnowledgeDirectory = (input?: string): string => {
  const fallback = path.join(os.homedir(), ".openzigs", "knowledge");
  if (!input || input.trim().length === 0) {
    return fallback;
  }

  const trimmed = input.trim();
  const expanded = trimmed === "~"
    ? os.homedir()
    : (trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed);

  return path.resolve(expanded);
};

export class KnowledgeIngestionService extends EventEmitter {
  private config: KnowledgeConfig;
  private store: LanceDBStore;
  private watcher: FSWatcher | null = null;
  private documents = new Map<string, KnowledgeDocument>();
  private running = false;
  private converterRegistry: ConverterRegistry | null = null;

  constructor(options: KnowledgeServiceOptions = {}) {
    super();

    const knowledgeDir = resolveKnowledgeDirectory(options.config?.directory);

    this.config = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      ...options.config,
      directory: knowledgeDir,
    };

    const dbPath = path.join(os.homedir(), ".openzigs", "knowledge-db");
    this.store = new LanceDBStore({ dbPath });
  }

  /**
   * Start the knowledge service: initialize the store, scan existing files,
   * and start the file watcher.
   */
  async start(): Promise<void> {
    if (this.running) return;

    logger.info(`[Knowledge] Starting Knowledge Ingestion Service...`);
    logger.info(`[Knowledge] Knowledge directory: ${this.config.directory}`);

    // Ensure the knowledge directory exists
    await fs.mkdir(this.config.directory, { recursive: true });

    // Initialize converter registry (auto-detects available converters)
    this.converterRegistry = await createDefaultRegistry();

    // Initialize LanceDB
    await this.store.initialize();

    // Perform initial scan
    await this.scanDirectory();

    // Start file watcher if enabled
    if (this.config.watchEnabled) {
      this.startWatcher();
    }

    this.running = true;
    logger.info(`[Knowledge] Knowledge Ingestion Service started (${this.documents.size} documents)`);
  }

  /**
   * Stop the knowledge service: close the watcher and LanceDB connection.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    await this.store.close();
    this.running = false;
    logger.info("[Knowledge] Knowledge Ingestion Service stopped");
  }

  /**
   * Search the knowledge base.
   */
  async search(query: string, limit?: number): Promise<KnowledgeSearchResult[]> {
    const maxResults = limit ?? this.config.maxResults;
    return this.store.search(query, maxResults);
  }

  /**
   * Get knowledge base statistics.
   */
  async getStats(): Promise<KnowledgeStats> {
    const docs = Array.from(this.documents.values());
    const totalChunks = await this.store.countChunks();
    const indexed = docs.filter((d) => d.status === "indexed");
    const lastIndexed = indexed
      .map((d) => d.indexedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return {
      totalDocuments: docs.length,
      totalChunks,
      indexedDocuments: indexed.length,
      failedDocuments: docs.filter((d) => d.status === "failed").length,
      pendingDocuments: docs.filter((d) => d.status === "pending" || d.status === "processing").length,
      totalSizeBytes: docs.reduce((sum, d) => sum + d.sizeBytes, 0),
      lastIndexedAt: lastIndexed,
    };
  }

  /**
   * List all tracked documents.
   */
  listDocuments(): KnowledgeDocument[] {
    return Array.from(this.documents.values()).sort(
      (a, b) => a.relativePath.localeCompare(b.relativePath)
    );
  }

  /**
   * Force re-index a specific document.
   */
  async reindexDocument(documentId: string): Promise<void> {
    const doc = this.documents.get(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }
    await this.indexFile(doc.filePath);
  }

  /**
   * Force re-index all documents.
   */
  async reindexAll(): Promise<void> {
    await this.scanDirectory();
  }

  /**
   * Delete a document from the knowledge base.
   */
  async deleteDocument(documentId: string): Promise<void> {
    const doc = this.documents.get(documentId);
    if (!doc) return;

    await this.store.deleteByDocumentId(documentId);
    this.documents.delete(documentId);

    this.emitEvent({
      type: "document:deleted",
      documentId,
      filePath: doc.filePath,
    });
  }

  /**
   * Get the knowledge configuration.
   */
  getConfig(): KnowledgeConfig {
    return { ...this.config };
  }

  /**
   * Get available converter information for the UI.
   */
  getConverterInfo(): Array<{ name: string; extensions: string[]; available: boolean; reason?: string }> {
    return this.converterRegistry?.listConverters() ?? [];
  }

  /**
   * Update knowledge configuration at runtime.
   *
   * Applies changes immediately while the service is running:
   * - directory change => clears indexed docs, re-scans new directory, restarts watcher
   * - watchEnabled toggle => starts/stops watcher
   * - chunk settings change => re-indexes current directory
   */
  async updateConfig(nextConfig: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
    const previous = this.config;

    const normalizedDirectory = resolveKnowledgeDirectory(
      typeof nextConfig.directory === "string" ? nextConfig.directory : previous.directory
    );

    this.config = {
      ...previous,
      ...nextConfig,
      directory: normalizedDirectory,
    };

    if (!this.running) {
      return this.getConfig();
    }

    const directoryChanged = this.config.directory !== previous.directory;
    const watchChanged = this.config.watchEnabled !== previous.watchEnabled;
    const chunkingChanged =
      this.config.chunkSize !== previous.chunkSize
      || this.config.chunkOverlap !== previous.chunkOverlap;

    if (directoryChanged) {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }

      // Remove old directory documents from the index before re-scanning.
      const existingDocIds = Array.from(this.documents.keys());
      for (const docId of existingDocIds) {
        await this.store.deleteByDocumentId(docId);
      }
      this.documents.clear();

      await fs.mkdir(this.config.directory, { recursive: true });
      await this.scanDirectory();
    } else if (chunkingChanged) {
      // Rebuild chunks for the current directory when chunk parameters change.
      await this.reindexAll();
    }

    if (this.config.watchEnabled) {
      if (!this.watcher || directoryChanged || watchChanged) {
        if (this.watcher) {
          await this.watcher.close();
          this.watcher = null;
        }
        this.startWatcher();
      }
    } else if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    logger.info(
      `[Knowledge] Config updated (directory=${this.config.directory}, watchEnabled=${this.config.watchEnabled})`
    );

    return this.getConfig();
  }

  // ── Private methods ──

  /**
   * Scan the knowledge directory and index all supported files.
   */
  private async scanDirectory(): Promise<void> {
    const startTime = Date.now();
    const files = await this.collectFiles(this.config.directory);

    this.emitEvent({
      type: "indexing:started",
      fileCount: files.length,
    });

    let indexed = 0;
    let failed = 0;

    for (const filePath of files) {
      try {
        await this.indexFile(filePath);
        indexed++;
      } catch (error) {
        failed++;
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[Knowledge] Failed to index ${filePath}: ${msg}`);
      }
    }

    // Clean up documents that no longer exist on disk
    for (const [docId, doc] of this.documents) {
      const exists = files.includes(doc.filePath);
      if (!exists) {
        await this.store.deleteByDocumentId(docId);
        this.documents.delete(docId);
      }
    }

    const duration = Date.now() - startTime;
    this.emitEvent({
      type: "indexing:completed",
      indexed,
      failed,
      duration,
    });

    logger.info(`[Knowledge] Scan complete: ${indexed} indexed, ${failed} failed (${duration}ms)`);
  }

  /**
   * Recursively collect all supported files from a directory.
   */
  private async collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip excluded patterns
        if (this.isExcluded(entry.name)) continue;

        if (entry.isDirectory()) {
          const nested = await this.collectFiles(fullPath);
          files.push(...nested);
        } else if (entry.isFile() && this.isSupportedFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Knowledge] Error scanning directory ${dir}: ${msg}`);
    }

    return files;
  }

  /**
   * Index a single file: convert (if needed), hash, chunk, embed, store.
   */
  private async indexFile(filePath: string): Promise<void> {
    const relativePath = path.relative(this.config.directory, filePath);
    const documentId = this.computeDocumentId(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const sourceType = EXTENSION_MAP[ext] ?? "text";

    // Read or convert file content via the converter registry.
    let content: string;
    const stat = await fs.stat(filePath);

    if (this.converterRegistry && this.converterRegistry.canConvert(filePath)) {
      const result = await this.converterRegistry.convert(filePath);
      if (!result.success) {
        throw new Error(`Conversion failed (${result.converter}): ${result.error}`);
      }
      content = result.text;
      logger.debug(`[Knowledge] Converted ${relativePath} via ${result.converter}`);
    } else {
      // Fallback: read as UTF-8 text (for text-based files or if registry not ready)
      content = await fs.readFile(filePath, "utf-8");
    }

    const contentHash = this.hashContent(content);

    // Check if already indexed with same hash (skip re-indexing)
    const existing = this.documents.get(documentId);
    if (existing && existing.contentHash === contentHash && existing.status === "indexed") {
      return;
    }

    // Create/update document record
    const doc: KnowledgeDocument = {
      id: documentId,
      filePath,
      relativePath,
      sourceType,
      sizeBytes: stat.size,
      contentHash,
      status: "processing",
      chunkCount: 0,
      indexedAt: null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.documents.set(documentId, doc);

    try {
      // Chunk the content
      const chunks = chunkText(content, documentId, relativePath, {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
      });

      // Generate embeddings for each chunk
      const embeddedChunks: KnowledgeChunk[] = chunks.map((chunk) => ({
        ...chunk,
        vector: generateEmbedding(chunk.text),
      }));

      // Store in LanceDB
      await this.store.addChunks(embeddedChunks);

      // Update document status
      doc.status = "indexed";
      doc.chunkCount = embeddedChunks.length;
      doc.indexedAt = new Date().toISOString();
      doc.error = undefined;

      this.emitEvent({ type: "document:indexed", document: doc });
      logger.debug(`[Knowledge] Indexed ${relativePath} (${embeddedChunks.length} chunks)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      doc.status = "failed";
      doc.error = msg;
      this.emitEvent({ type: "document:failed", document: doc, error: msg });
      throw error;
    }
  }

  /**
   * Start the chokidar file watcher.
   */
  private startWatcher(): void {
    this.watcher = watch(this.config.directory, {
      persistent: true,
      ignoreInitial: true,
      depth: 10,
      ignored: (filePath: string) => {
        const name = path.basename(filePath);
        return this.isExcluded(name);
      },
    });

    this.watcher.on("add", (filePath: string) => {
      if (this.isSupportedFile(filePath)) {
        void this.indexFile(filePath).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Knowledge] Watcher add failed for ${filePath}: ${msg}`);
        });
      }
    });

    this.watcher.on("change", (filePath: string) => {
      if (this.isSupportedFile(filePath)) {
        void this.indexFile(filePath).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Knowledge] Watcher change failed for ${filePath}: ${msg}`);
        });
      }
    });

    this.watcher.on("unlink", (filePath: string) => {
      const documentId = this.computeDocumentId(filePath);
      void this.deleteDocument(documentId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Knowledge] Watcher unlink failed for ${filePath}: ${msg}`);
      });
    });

    this.watcher.on("ready", () => {
      this.emitEvent({ type: "watcher:ready" });
      logger.info("[Knowledge] File watcher ready");
    });

    this.watcher.on("error", (error: unknown) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: "watcher:error", error: errorMsg });
      logger.error(`[Knowledge] File watcher error: ${errorMsg}`);
    });
  }

  /**
   * Check if a filename/directory should be excluded.
   */
  private isExcluded(name: string): boolean {
    return this.config.excludePatterns.some((pattern) => {
      if (pattern.includes("*")) {
        // Simple glob matching
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(name);
      }
      return name === pattern;
    });
  }

  /**
   * Check if a file is a supported content type.
   * Checks both the static EXTENSION_MAP and the converter registry.
   */
  private isSupportedFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (this.config.includeExtensions.length > 0) {
      return this.config.includeExtensions.includes(ext);
    }
    // Accept files in the static map OR files the converter registry can handle.
    if (ext in EXTENSION_MAP) return true;
    if (this.converterRegistry?.canConvert(filePath)) return true;
    return false;
  }

  /**
   * Compute a deterministic document ID from a file path.
   */
  private computeDocumentId(filePath: string): string {
    const relativePath = path.relative(this.config.directory, filePath);
    return createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  }

  /**
   * Compute a content hash for change detection.
   */
  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Type-safe event emission.
   */
  private emitEvent(event: KnowledgeServiceEvent): void {
    this.emit(event.type, event);
  }
}
