/**
 * Barrel export for the knowledge base subsystem.
 */
export { KnowledgeIngestionService } from "./knowledge-service.js";
export type { KnowledgeServiceOptions } from "./knowledge-service.js";
export { LanceDBStore } from "./lancedb-store.js";
export type { LanceDBStoreOptions } from "./lancedb-store.js";
export { chunkText } from "./chunker.js";
export type { ChunkerOptions } from "./chunker.js";
export { generateEmbedding, generateEmbeddings, getEmbeddingDim } from "./embedder.js";
export { ConverterRegistry, createDefaultRegistry } from "./converters/index.js";
export type { ConversionResult, FileConverter, ConverterRegistration } from "./converters/index.js";
export type {
  KnowledgeConfig,
  KnowledgeDocument,
  KnowledgeChunk,
  KnowledgeSearchResult,
  KnowledgeStats,
  KnowledgeServiceEvent,
  KnowledgeSourceType,
  DocumentStatus,
} from "./types.js";
export { DEFAULT_KNOWLEDGE_CONFIG } from "./types.js";
