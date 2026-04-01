/**
 * Factory function for creating vector store instances.
 * Issue #716: Config-driven provider selection with dependency injection.
 */

import type { VectorStore, VectorStoreConfig } from "./types.js";
import { LanceDBVectorStore } from "./lancedb-vector-store.js";

/**
 * Create a VectorStore instance based on configuration.
 * Currently supports "lancedb" (default). Future providers can be added here.
 */
export function createVectorStore(config: VectorStoreConfig & { dbPath?: string }): VectorStore {
  switch (config.provider) {
    case "lancedb":
    default: {
      const dbPath = (config.options?.dbPath as string | undefined) ?? config.dbPath;
      if (!dbPath) {
        throw new Error("LanceDB vector store requires a dbPath option");
      }
      return new LanceDBVectorStore({ dbPath });
    }
  }
}
