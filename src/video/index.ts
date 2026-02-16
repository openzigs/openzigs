/**
 * Director Mode — Top-level barrel export.
 *
 * Re-exports all video sub-modules for convenient namespace access:
 *   import { ProducerService, RenderOrchestrator, ... } from "./video/index.js"
 */

// Manifest data contract (#240)
export * from "./manifest/index.js";

// Render core (#235)
export { RenderOrchestrator } from "./render-orchestrator.js";

// Templates (#236)
export { createTemplateRegistry, TEMPLATE_IDS } from "./templates/index.js";

// Ingestion pipeline (#237)
export { ingest } from "./ingestion/index.js";

// Asset management (#238)
export { AssetManager } from "./assets/index.js";

// Producer logic (#239)
export { ProducerService } from "./producer/index.js";
