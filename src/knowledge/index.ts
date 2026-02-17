/**
 * Barrel export for the knowledge base subsystem.
 */
export { KnowledgeIngestionService } from "./knowledge-service.js";
export type { KnowledgeServiceOptions } from "./knowledge-service.js";
export { LanceDBStore } from "./lancedb-store.js";
export type { LanceDBStoreOptions } from "./lancedb-store.js";
export { chunkText } from "./chunker.js";
export type { ChunkerOptions } from "./chunker.js";
export { generateEmbedding, generateEmbeddings, getEmbeddingDim, isModelReady, shutdownEmbedder } from "./embedder.js";
export { ConverterRegistry, createDefaultRegistry } from "./converters/index.js";
export type { ConversionResult, FileConverter, ConverterRegistration } from "./converters/index.js";
export type {
  KnowledgeConfig,
  KnowledgeDocument,
  KnowledgeChunk,
  KnowledgeSearchResult,
  KnowledgeSearchMode,
  KnowledgeStats,
  KnowledgeServiceEvent,
  KnowledgeSourceType,
  DocumentStatus,
} from "./types.js";
export { DEFAULT_KNOWLEDGE_CONFIG } from "./types.js";
export { classifyQuery } from "./query-classifier.js";
export type { QueryClassification } from "./query-classifier.js";
export { multimodalSearch, applyMultimodalReranking, formatCitation } from "./multimodal-retriever.js";
export type { MultimodalSearchOptions, MultimodalSearchResult } from "./multimodal-retriever.js";
