import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reliable project root derived from this file's location (src/project-root.ts → project root).
 * Do NOT use process.cwd() — native modules like whisper-node can change it at runtime.
 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
