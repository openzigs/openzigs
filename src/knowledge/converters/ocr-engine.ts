/**
 * Shared OCR engine — manages a tesseract.js worker for text recognition.
 *
 * Both the image converter and the PDF OCR fallback share this engine
 * to avoid spinning up multiple workers.
 *
 * `tesseract.js` is loaded dynamically so the service still starts
 * when the package is not installed (graceful degradation).
 */

import { logger } from "../../logging/logger.js";

/** Minimal typing for the tesseract.js worker. */
interface TesseractWorker {
  recognize(image: string | Buffer | Uint8Array): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
}

type CreateWorkerFn = (lang: string) => Promise<TesseractWorker>;

let _createWorker: CreateWorkerFn | null = null;
/** Cached singleton worker — reused across OCR calls. */
let _worker: TesseractWorker | null = null;
/** Whether we've already attempted to load tesseract.js. */
let _probed = false;

/**
 * Probe for tesseract.js availability. Caches the result.
 */
export async function isTesseractAvailable(): Promise<boolean> {
  if (_probed) return _createWorker !== null;
  _probed = true;

  try {
    // Dynamic import to avoid hard dependency.
    const moduleName = "tesseract.js";
    const mod: unknown = await import(/* webpackIgnore: true */ moduleName);
    const m = mod as Record<string, unknown>;
    if (typeof m.createWorker === "function") {
      _createWorker = m.createWorker as CreateWorkerFn;
      logger.info("[Knowledge] tesseract.js OCR engine available");
      return true;
    }
  } catch {
    // Not installed.
  }

  logger.info("[Knowledge] tesseract.js not available — OCR disabled");
  return false;
}

/**
 * Get (or create) a shared tesseract.js worker.
 *
 * The worker is created lazily on first use and reused for subsequent calls.
 * Call `terminateOcrEngine()` when the service shuts down.
 */
export async function getOcrWorker(): Promise<TesseractWorker> {
  if (!_createWorker) {
    throw new Error("tesseract.js is not available — call isTesseractAvailable() first");
  }

  if (!_worker) {
    logger.info("[Knowledge] Initializing tesseract.js worker (eng)...");
    _worker = await _createWorker("eng");
    logger.info("[Knowledge] tesseract.js worker ready");
  }

  return _worker;
}

/**
 * Recognise text from an image buffer or file path.
 */
export async function ocrImage(image: string | Buffer | Uint8Array): Promise<string> {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(image);
  return data.text;
}

/**
 * Terminate the shared tesseract.js worker. Call on service shutdown.
 */
export async function terminateOcrEngine(): Promise<void> {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    logger.info("[Knowledge] tesseract.js worker terminated");
  }
}
