/**
 * Dev-mode bootstrap for the render worker.
 *
 * Worker Threads don't inherit tsx's ESM loader from the parent process, so
 * we register it ourselves before importing the TypeScript worker module.
 * In production the compiled .js worker is loaded directly — this file is
 * never used.
 */
import { register } from "tsx/esm/api";

register();

try {
  await import("./render-worker.ts");
} catch (err) {
  // Log the real crash reason to stderr so the orchestrator can capture it
  console.error("[render-worker-loader] FATAL: failed to import render-worker.ts:", err);
  process.exit(1);
}
