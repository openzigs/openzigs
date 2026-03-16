/**
 * Embedding generator for the knowledge base.
 *
 * Uses Hugging Face Transformers.js to run the all-MiniLM-L6-v2 model
 * locally via ONNX Runtime. Produces 384-dimensional semantic embeddings
 * with real language understanding — synonyms, context, and meaning.
 *
 * The model (~23MB ONNX) is downloaded once on first use and cached locally.
 * Falls back to a hash-based approach if the model fails to initialize.
 */

import { logger } from "../logging/logger.js";

/** Dimensionality of the embedding vectors (matches all-MiniLM-L6-v2). */
const EMBEDDING_DIM = 384;

/**
 * Lazy-loaded pipeline singleton. Initialized on first call to generateEmbedding.
 */
let pipelinePromise: Promise<unknown> | null = null;
let pipelineReady = false;
let pipelineFailed = false;

/**
 * Get or create the embedding pipeline (lazy singleton).
 */
async function getEmbeddingPipeline(): Promise<unknown> {
  if (pipelineFailed) return null;

  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        logger.info("[Embedder] Loading all-MiniLM-L6-v2 model (first run downloads ~23MB)...");
        const { pipeline } = await import("@huggingface/transformers");

        const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "fp32",
        });
        pipelineReady = true;
        logger.info("[Embedder] all-MiniLM-L6-v2 model loaded successfully");
        return pipe;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[Embedder] Failed to load transformer model, falling back to hash embedder: ${msg}`);
        pipelineFailed = true;
        return null;
      }
    })();
  }

  return pipelinePromise;
}

/**
 * Generate a semantic embedding vector for the given text.
 *
 * Uses all-MiniLM-L6-v2 for real semantic understanding.
 * Falls back to hash-based embeddings if the model isn't available.
 *
 * @param text - The text to embed.
 * @returns A normalized float32 vector of size EMBEDDING_DIM.
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  if (!text.trim()) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const pipe = await getEmbeddingPipeline();

  if (pipe && typeof pipe === "function") {
    try {
      // Truncate very long text to avoid OOM (model max is ~512 tokens ≈ ~2000 chars)
      // Snap to word boundary to avoid splitting mid-word
      let truncated = text;
      if (truncated.length > 2000) {
        truncated = truncated.slice(0, 2000);
        const lastSpace = truncated.lastIndexOf(" ");
        if (lastSpace > 1500) {
          truncated = truncated.slice(0, lastSpace);
        }
      }

      const result = await (pipe as (input: string, options?: Record<string, unknown>) => Promise<unknown>)(
        truncated,
        { pooling: "mean", normalize: true },
      );

      const data = extractEmbeddingData(result);
      if (data && data.length === EMBEDDING_DIM) {
        return Array.from(data);
      }

      logger.warn("[Embedder] Unexpected output shape, falling back to hash embedder");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[Embedder] Model inference failed, falling back to hash embedder: ${msg}`);
    }
  }

  return hashBasedEmbedding(text);
};

/**
 * Generate embeddings for multiple texts in batch.
 */
export const generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
  }
  return results;
};

/**
 * Get the embedding dimensionality.
 */
export const getEmbeddingDim = (): number => EMBEDDING_DIM;

/**
 * Check if the transformer model is loaded and ready.
 */
export const isModelReady = (): boolean => pipelineReady;

/**
 * Shutdown the embedding pipeline and free resources.
 */
export const shutdownEmbedder = async (): Promise<void> => {
  if (pipelinePromise) {
    try {
      const pipe = await pipelinePromise;
      if (pipe && typeof (pipe as Record<string, unknown>).dispose === "function") {
        await (pipe as { dispose: () => Promise<void> }).dispose();
      }
    } catch {
      // Ignore cleanup errors
    }
    pipelinePromise = null;
    pipelineReady = false;
  }
};

// ── Internals ──

/**
 * Extract flat embedding data from the pipeline output.
 * Handles various Tensor formats from transformers.js.
 */
function extractEmbeddingData(result: unknown): Float32Array | number[] | null {
  if (!result) return null;

  const r = result as Record<string, unknown>;

  // Tensor object with .data property
  if (r.data && (r.data instanceof Float32Array || Array.isArray(r.data))) {
    const data = r.data as Float32Array | number[];
    if (data.length === EMBEDDING_DIM) return data;
    if (data.length >= EMBEDDING_DIM) return data.slice(0, EMBEDDING_DIM) as Float32Array | number[];
  }

  // Nested Tensor
  if (Array.isArray(result)) {
    return extractEmbeddingData(result[0]);
  }

  // tolist() method
  if (typeof r.tolist === "function") {
    const list = r.tolist() as unknown;
    if (Array.isArray(list) && Array.isArray(list[0])) {
      const flat = list[0] as number[];
      if (flat.length === EMBEDDING_DIM) return flat;
    }
    if (Array.isArray(list) && typeof list[0] === "number") {
      return list as number[];
    }
  }

  return null;
}

// ── Hash-based fallback (for when the model isn't available) ──

function hashBasedEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 50);

  if (tokens.length === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const vector = new Float64Array(EMBEDDING_DIM);
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  for (const [token, freq] of frequencies) {
    const weight = Math.log(1 + freq);
    for (let h = 0; h < 3; h++) {
      const hash = hashToken(token, h);
      const position = Math.abs(hash) % EMBEDDING_DIM;
      const sign = hash > 0 ? 1 : -1;
      vector[position] += sign * weight;
    }

    const ngrams = charNgrams(token, 3);
    for (const ngram of ngrams) {
      const hash = hashToken(ngram, 42);
      const position = Math.abs(hash) % EMBEDDING_DIM;
      const sign = hash > 0 ? 1 : -1;
      vector[position] += sign * weight * 0.5;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return Array.from(vector);
  return Array.from(vector).map((v) => v / norm);
}

function hashToken(token: string, seed: number): number {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function charNgrams(token: string, n: number): string[] {
  if (token.length < n) return [token];
  const ngrams: string[] = [];
  for (let i = 0; i <= token.length - n; i++) {
    ngrams.push(token.slice(i, i + n));
  }
  return ngrams;
}
