/**
 * Barrel export for the vector store abstraction layer.
 */
export type { VectorStore, VectorStoreProvider, VectorStoreConfig } from "./types.js";
export { LanceDBVectorStore } from "./lancedb-vector-store.js";
export type { LanceDBVectorStoreOptions } from "./lancedb-vector-store.js";
export { createVectorStore } from "./factory.js";
