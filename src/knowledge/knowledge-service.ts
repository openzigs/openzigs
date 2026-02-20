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
import { generateEmbedding, shutdownEmbedder } from "./embedder.js";
import { LanceDBStore } from "./lancedb-store.js";
import { ConverterRegistry, createDefaultRegistry, shutdownConverters } from "./converters/index.js";
import type {
  KnowledgeDocument,
  KnowledgeConfig,
  KnowledgeStats,
  KnowledgeSearchResult,
  KnowledgeServiceEvent,
  KnowledgeSourceType,
  KnowledgeChunk,
  KeyframeManifest,
} from "./types.js";
import { DEFAULT_KNOWLEDGE_CONFIG } from "./types.js";
import { multimodalSearch, type MultimodalSearchResult, type MultimodalSearchOptions } from "./multimodal-retriever.js";
import type { QueryClassification } from "./query-classifier.js";
import { logger } from "../logging/logger.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

export type KnowledgeServiceOptions = {
  config?: Partial<KnowledgeConfig>;
  /** Audio sidecar URL for sidecar-based media transcription. */
  audioSidecarUrl?: string;
  /** CopilotWrapper for vision-based keyframe description (video files). */
  copilot?: CopilotWrapper;
};

type IndexFileOptions = {
  force?: boolean;
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
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  // Images (OCR via tesseract.js)
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".tiff": "image",
  ".tif": "image",
  ".bmp": "image",
  ".webp": "image",
  ".gif": "image",
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
  private dbPath: string;
  /** Path to the persisted document metadata sidecar file. */
  private metadataPath: string;
  /** Directory for persisted keyframe images. */
  private keyframesDir: string;
  /** Audio sidecar URL for sidecar-based STT. */
  private audioSidecarUrl?: string;
  /** CopilotWrapper for vision-based keyframe description. */
  private copilot?: CopilotWrapper;

  constructor(options: KnowledgeServiceOptions = {}) {
    super();

    this.audioSidecarUrl = options.audioSidecarUrl;
    this.copilot = options.copilot;

    const sanitizedConfig = Object.fromEntries(
      Object.entries(options.config ?? {}).filter(([, value]) => value !== undefined)
    ) as Partial<KnowledgeConfig>;

    const knowledgeDir = resolveKnowledgeDirectory(sanitizedConfig.directory);

    this.config = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      ...sanitizedConfig,
      directory: knowledgeDir,
    };

    this.dbPath = path.join(os.homedir(), ".openzigs", "knowledge-db");
    this.metadataPath = path.join(this.dbPath, "documents.json");
    this.keyframesDir = path.join(this.dbPath, "keyframes");
    this.store = new LanceDBStore({ dbPath: this.dbPath });
  }

  /**
   * Start the knowledge service: initialize the store, load persisted metadata,
   * scan existing files (skipping unchanged), and start the file watcher.
   */
  async start(): Promise<void> {
    if (this.running) return;

    logger.info(`[Knowledge] Starting Knowledge Ingestion Service...`);
    logger.info(`[Knowledge] Knowledge directory: ${this.config.directory}`);

    // Ensure the knowledge directory exists
    await fs.mkdir(this.config.directory, { recursive: true });

    // Initialize converter registry (auto-detects available converters)
    this.converterRegistry = await createDefaultRegistry({
      mediaModel: this.config.mediaModel,
      audioSidecarUrl: this.audioSidecarUrl,
      copilot: this.copilot,
    });

    // Initialize LanceDB
    await this.store.initialize();

    // Load persisted document metadata so we can skip unchanged files on restart.
    await this.loadDocumentMetadata();

    // Perform initial scan (skips files whose content hash matches persisted metadata).
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

    await shutdownConverters();
    await shutdownEmbedder();
    await this.store.close();
    this.running = false;
    logger.info("[Knowledge] Knowledge Ingestion Service stopped");
  }

  /**
   * Search the knowledge base using the configured search mode and min score.
   * Callers can override mode/minScore for specific queries.
   */
  async search(
    query: string,
    limit?: number,
    options?: { mode?: import("./types.js").KnowledgeSearchMode; minScore?: number },
  ): Promise<KnowledgeSearchResult[]> {
    const maxResults = limit ?? this.config.maxResults;
    const mode = options?.mode ?? this.config.searchMode ?? "hybrid";
    const minScore = options?.minScore ?? this.config.minScore ?? 0;
    return this.store.searchByMode(query, maxResults, mode, minScore);
  }

  /**
   * Multimodal-aware search: classifies the query for media intent, applies
   * type-aware re-ranking, and returns results with timestamp citations.
   */
  async searchMultimodal(
    query: string,
    options: MultimodalSearchOptions = {},
  ): Promise<{ results: MultimodalSearchResult[]; classification: QueryClassification }> {
    const boundSearch = this.search.bind(this);
    return multimodalSearch(query, boundSearch, {
      limit: options.limit ?? this.config.maxResults,
      minScore: options.minScore ?? this.config.minScore ?? 0,
      mode: options.mode ?? this.config.searchMode ?? "hybrid",
      ...options,
    });
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
    await this.indexFile(doc.filePath, { force: true });
  }

  /**
   * Force re-index all documents.
   */
  async reindexAll(): Promise<void> {
    await this.scanDirectory({ force: true });
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

    // Persist metadata after deletion.
    void this.saveDocumentMetadata();
  }

  /**
   * Ingest raw text directly into the knowledge base without needing a file on disk.
   * Used for virtual documents like presentation transcripts.
   */
  async ingestText(documentId: string, title: string, text: string): Promise<void> {
    const virtualPath = `[virtual:${documentId}]`;
    const contentHash = this.hashContent(text);

    // Skip if already indexed with the same content.
    const existing = this.documents.get(documentId);
    if (existing && existing.contentHash === contentHash && existing.status === "indexed") {
      return;
    }

    // Remove stale chunks if re-indexing.
    if (existing) {
      await this.store.deleteByDocumentId(documentId);
    }

    const doc: KnowledgeDocument = {
      id: documentId,
      filePath: virtualPath,
      relativePath: title,
      sourceType: "text",
      sizeBytes: Buffer.byteLength(text, "utf-8"),
      contentHash,
      status: "processing",
      chunkCount: 0,
      indexedAt: null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.documents.set(documentId, doc);

    try {
      const chunks = chunkText(text, documentId, title, {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
      });

      const embeddedChunks: KnowledgeChunk[] = [];
      for (const chunk of chunks) {
        embeddedChunks.push({
          ...chunk,
          vector: await generateEmbedding(chunk.text),
        });
      }

      await this.store.addChunks(embeddedChunks);

      doc.status = "indexed";
      doc.chunkCount = embeddedChunks.length;
      doc.indexedAt = new Date().toISOString();
      doc.error = undefined;

      this.emitEvent({ type: "document:indexed", document: doc });
      logger.debug(`[Knowledge] Ingested text "${title}" as virtual doc (${embeddedChunks.length} chunks)`);

      void this.saveDocumentMetadata();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      doc.status = "failed";
      doc.error = msg;
      this.emitEvent({ type: "document:failed", document: doc, error: msg });
      logger.error(`[Knowledge] Failed to ingest text "${title}": ${msg}`);
      throw error;
    }
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
    const mediaModelChanged = this.config.mediaModel !== previous.mediaModel;

    if (mediaModelChanged) {
      this.converterRegistry = await createDefaultRegistry({
        mediaModel: this.config.mediaModel,
        audioSidecarUrl: this.audioSidecarUrl,
        copilot: this.copilot,
      });
    }

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
      `[Knowledge] Config updated (directory=${this.config.directory}, watchEnabled=${this.config.watchEnabled}, mediaModel=${this.config.mediaModel})`
    );

    return this.getConfig();
  }

  // ── Private methods ──

  /**
   * Scan the knowledge directory and index all supported files.
   */
  private async scanDirectory(options: IndexFileOptions = {}): Promise<void> {
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
        await this.indexFile(filePath, options);
        indexed++;
      } catch (error) {
        failed++;
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[Knowledge] Failed to index ${filePath}: ${msg}`);
      }
    }

    // Clean up documents that no longer exist on disk
    let staleRemoved = 0;
    for (const [docId, doc] of this.documents) {
      const exists = files.includes(doc.filePath);
      if (!exists) {
        await this.store.deleteByDocumentId(docId);
        this.documents.delete(docId);
        staleRemoved++;
      }
    }

    const duration = Date.now() - startTime;
    this.emitEvent({
      type: "indexing:completed",
      indexed,
      failed,
      duration,
    });

    // Persist metadata after scan completes.
    if (indexed > 0 || staleRemoved > 0) {
      void this.saveDocumentMetadata();
    }

    logger.info(`[Knowledge] Scan complete: ${indexed} indexed, ${failed} failed, ${staleRemoved} stale removed (${duration}ms)`);
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
  private async indexFile(filePath: string, options: IndexFileOptions = {}): Promise<void> {
    const relativePath = path.relative(this.config.directory, filePath);
    const documentId = this.computeDocumentId(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const sourceType = EXTENSION_MAP[ext] ?? "text";

    // Read or convert file content via the converter registry.
    let content: string;
    let conversionMetadata: Record<string, unknown> | undefined;
    const stat = await fs.stat(filePath);

    // Fast pre-conversion check: if mtime + size match and the document is
    // already indexed, skip immediately without running any converter.
    // This avoids expensive OCR/transcription on every restart for unchanged files.
    const existingFast = this.documents.get(documentId);
    if (
      !options.force &&
      existingFast &&
      existingFast.status === "indexed" &&
      existingFast.sizeBytes === stat.size &&
      existingFast.fileMtime === stat.mtime.toISOString()
    ) {
      return;
    }

    if (this.converterRegistry && this.converterRegistry.canConvert(filePath)) {
      const result = await this.converterRegistry.convert(filePath);
      if (!result.success) {
        throw new Error(`Conversion failed (${result.converter}): ${result.error}`);
      }
      content = result.text;
      conversionMetadata = result.metadata;
      logger.debug(`[Knowledge] Converted ${relativePath} via ${result.converter}`);
    } else {
      // Fallback: read as UTF-8 text (for text-based files or if registry not ready)
      content = await fs.readFile(filePath, "utf-8");
    }

    const contentHash = this.hashContent(content);

    // Check if already indexed with same hash (skip re-indexing)
    const existing = this.documents.get(documentId);
    if (!options.force && existing && existing.contentHash === contentHash && existing.status === "indexed") {
      return;
    }

    // Create/update document record
    const doc: KnowledgeDocument = {
      id: documentId,
      filePath,
      relativePath,
      sourceType,
      sizeBytes: stat.size,
      fileMtime: stat.mtime.toISOString(),
      contentHash,
      status: "processing",
      chunkCount: 0,
      indexedAt: null,
      createdAt: existingFast?.createdAt ?? new Date().toISOString(),
    };
    this.documents.set(documentId, doc);

    try {
      // Chunk the content
      const chunks = chunkText(content, documentId, relativePath, {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
      });

      // Generate embeddings for each chunk
      const embeddedChunks: KnowledgeChunk[] = [];
      for (const chunk of chunks) {
        embeddedChunks.push({
          ...chunk,
          vector: await generateEmbedding(chunk.text),
        });
      }

      // Store in LanceDB
      await this.store.addChunks(embeddedChunks);

      // Persist keyframe images from media converter if available
      await this.persistKeyframes(documentId, relativePath, conversionMetadata);

      // Update document status
      doc.status = "indexed";
      doc.chunkCount = embeddedChunks.length;
      doc.indexedAt = new Date().toISOString();
      doc.error = undefined;

      this.emitEvent({ type: "document:indexed", document: doc });
      logger.debug(`[Knowledge] Indexed ${relativePath} (${embeddedChunks.length} chunks)`);

      // Persist metadata so restarts can skip unchanged files.
      void this.saveDocumentMetadata();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      doc.status = "failed";
      doc.error = msg;
      this.emitEvent({ type: "document:failed", document: doc, error: msg });

      // Clean up keyframe temp dir on failure
      await this.cleanupKeyframeTempDir(conversionMetadata);

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

  // ── Keyframe persistence ──

  /**
   * Persist extracted keyframe images from a media conversion to a permanent directory.
   *
   * Moves images from the converter's temp dir to `~/.openzigs/knowledge-db/keyframes/<documentId>/`
   * and writes a manifest.json with metadata (timestamps, descriptions, filenames).
   */
  private async persistKeyframes(
    documentId: string,
    sourceRelativePath: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!metadata) return;

    const keyframeTempDir = metadata.keyframeTempDir as string | undefined;
    const keyframeFiles = metadata.keyframeFiles as
      | Array<{ filename: string; timestamp: number; description: string }>
      | undefined;

    if (!keyframeTempDir || !keyframeFiles || keyframeFiles.length === 0) return;

    const destDir = path.join(this.keyframesDir, documentId);

    try {
      await fs.mkdir(destDir, { recursive: true });

      // Copy each keyframe JPEG to the persistent directory
      for (const kf of keyframeFiles) {
        const srcPath = path.join(keyframeTempDir, kf.filename);
        const destPath = path.join(destDir, kf.filename);
        try {
          await fs.copyFile(srcPath, destPath);
        } catch {
          logger.debug(`[Knowledge] Keyframe copy skipped (missing): ${kf.filename}`);
        }
      }

      // Write manifest
      const manifest: KeyframeManifest = {
        documentId,
        sourceFile: path.basename(sourceRelativePath),
        directory: destDir,
        frames: keyframeFiles.map((kf, i) => ({
          index: i,
          filename: kf.filename,
          timestamp: kf.timestamp,
          description: kf.description,
        })),
        extractedAt: new Date().toISOString(),
      };

      const manifestPath = path.join(destDir, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      logger.info(
        `[Knowledge] Persisted ${keyframeFiles.length} keyframes for ${sourceRelativePath} → ${destDir}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Knowledge] Keyframe persistence failed: ${msg}`);
    } finally {
      // Always clean up the temp dir after copying
      await this.cleanupKeyframeTempDir(metadata);
    }
  }

  /**
   * Clean up a keyframe temp directory from conversion metadata.
   */
  private async cleanupKeyframeTempDir(metadata?: Record<string, unknown>): Promise<void> {
    const tempDir = metadata?.keyframeTempDir as string | undefined;
    if (!tempDir) return;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get the keyframe manifest for a document, if available.
   *
   * Returns null if the document has no persisted keyframes.
   */
  async getKeyframeManifest(documentId: string): Promise<KeyframeManifest | null> {
    const manifestPath = path.join(this.keyframesDir, documentId, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      return JSON.parse(raw) as KeyframeManifest;
    } catch {
      return null;
    }
  }

  /**
   * Get the absolute file path for a specific keyframe image.
   *
   * @returns The JPEG path, or null if the keyframe doesn't exist.
   */
  async getKeyframeImagePath(documentId: string, frameIndex: number): Promise<string | null> {
    const manifest = await this.getKeyframeManifest(documentId);
    if (!manifest) return null;

    const entry = manifest.frames.find((f) => f.index === frameIndex);
    if (!entry) return null;

    const imagePath = path.join(this.keyframesDir, documentId, entry.filename);
    try {
      await fs.access(imagePath);
      return imagePath;
    } catch {
      return null;
    }
  }

  /**
   * Check which document IDs have persisted keyframes available.
   *
   * @returns Set of document IDs that have keyframe manifests.
   */
  async getDocumentIdsWithKeyframes(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const entries = await fs.readdir(this.keyframesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = path.join(this.keyframesDir, entry.name, "manifest.json");
          try {
            await fs.access(manifestPath);
            ids.add(entry.name);
          } catch {
            // No manifest — skip
          }
        }
      }
    } catch {
      // Keyframes directory doesn't exist yet
    }
    return ids;
  }

  // ── Document metadata persistence ──

  /**
   * Load persisted document metadata from the sidecar JSON file.
   *
   * This allows the service to skip re-indexing unchanged files across
   * server restarts. Documents whose content hash still matches are not
   * re-embedded, saving significant time and compute.
   */
  private async loadDocumentMetadata(): Promise<void> {
    try {
      const raw = await fs.readFile(this.metadataPath, "utf-8");
      const entries = JSON.parse(raw) as KnowledgeDocument[];
      if (!Array.isArray(entries)) return;

      let loaded = 0;
      for (const doc of entries) {
        if (doc.id && doc.filePath && doc.contentHash) {
          this.documents.set(doc.id, doc);
          loaded++;
        }
      }

      if (loaded > 0) {
        logger.info(`[Knowledge] Loaded ${loaded} persisted document records (will skip unchanged files)`);
      }
    } catch {
      // File doesn't exist yet or is corrupt — start fresh.
      logger.debug("[Knowledge] No persisted document metadata found (first run or reset)");
    }
  }

  /**
   * Persist the current document metadata to a sidecar JSON file.
   *
   * Uses atomic write-to-temp-then-rename to prevent corruption.
   */
  private async saveDocumentMetadata(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
      const entries = Array.from(this.documents.values());
      const tmpPath = this.metadataPath + ".tmp";
      await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), "utf-8");
      await fs.rename(tmpPath, this.metadataPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Knowledge] Failed to persist document metadata: ${msg}`);
    }
  }
}
