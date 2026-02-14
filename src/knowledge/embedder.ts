/**
 * Simple embedding generator for the knowledge base.
 *
 * Uses a lightweight local hashing-based embedding approach rather than
 * requiring an external API. This produces deterministic, content-aware
 * vectors suitable for cosine similarity search within a local knowledge base.
 *
 * The embedding strategy:
 * 1. Tokenize text into normalized word tokens.
 * 2. Hash each token to a deterministic position in a fixed-size vector.
 * 3. Apply TF-IDF-like weighting by token frequency.
 * 4. L2-normalize the final vector for cosine similarity.
 *
 * This is intentionally simple and CPU-only — no GPU, no external model.
 * For production use cases requiring higher quality, replace this with
 * an API-backed embedder (OpenAI, Cohere, etc.).
 */

/** Dimensionality of the embedding vectors. */
const EMBEDDING_DIM = 384;

/**
 * Generate a deterministic embedding vector for the given text.
 *
 * @param text - The text to embed.
 * @returns A normalized float32 vector of size EMBEDDING_DIM.
 */
export const generateEmbedding = (text: string): number[] => {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const vector = new Float64Array(EMBEDDING_DIM);

  // Count token frequencies for TF weighting
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  // Build the embedding: hash each unique token to multiple positions
  for (const [token, freq] of frequencies) {
    const weight = Math.log(1 + freq); // TF component
    // Use multiple hash positions per token for better distribution
    for (let h = 0; h < 3; h++) {
      const hash = hashToken(token, h);
      const position = Math.abs(hash) % EMBEDDING_DIM;
      const sign = hash > 0 ? 1 : -1;
      vector[position] += sign * weight;
    }

    // Also add character n-gram features for sub-word similarity
    const ngrams = charNgrams(token, 3);
    for (const ngram of ngrams) {
      const hash = hashToken(ngram, 42);
      const position = Math.abs(hash) % EMBEDDING_DIM;
      const sign = hash > 0 ? 1 : -1;
      vector[position] += sign * weight * 0.5;
    }
  }

  // L2-normalize
  return l2Normalize(Array.from(vector));
};

/**
 * Generate embeddings for multiple texts in batch.
 */
export const generateEmbeddings = (texts: string[]): number[][] => {
  return texts.map(generateEmbedding);
};

/**
 * Get the embedding dimensionality.
 */
export const getEmbeddingDim = (): number => EMBEDDING_DIM;

/**
 * Tokenize text into normalized word tokens.
 */
const tokenize = (text: string): string[] => {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 50);
};

/**
 * Generate character n-grams from a token.
 */
const charNgrams = (token: string, n: number): string[] => {
  if (token.length < n) return [token];
  const ngrams: string[] = [];
  for (let i = 0; i <= token.length - n; i++) {
    ngrams.push(token.slice(i, i + n));
  }
  return ngrams;
};

/**
 * Deterministic hash function for a string with a seed.
 * Based on FNV-1a hash.
 */
const hashToken = (token: string, seed: number): number => {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Return a signed 32-bit integer
  return hash | 0;
};

/**
 * L2-normalize a vector.
 */
const l2Normalize = (vector: number[]): number[] => {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
};
