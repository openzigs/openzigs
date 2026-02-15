/**
 * Barrel export for the converter pipeline.
 */

export { ConverterRegistry, createDefaultRegistry, shutdownConverters } from "./converter-registry.js";
export { terminateOcrEngine } from "./ocr-engine.js";
export type { ConversionResult, FileConverter, ConverterRegistration } from "./types.js";
export type { ConverterRegistryOptions } from "./converter-registry.js";
