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

await import("./render-worker.ts");
