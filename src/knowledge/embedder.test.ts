import { describe, expect, it } from "vitest";
import { generateEmbedding, generateEmbeddings, getEmbeddingDim } from "./embedder.js";

describe("embedder", () => {
  it("returns a vector of the correct dimensionality", async () => {
    // First call loads the ONNX model — allow extra time for CI runners
    const vec = await generateEmbedding("Hello world");
    expect(vec).toHaveLength(getEmbeddingDim());
  }, 15_000);

  it("returns zero vector for empty text", async () => {
    const vec = await generateEmbedding("");
    expect(vec).toHaveLength(getEmbeddingDim());
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("returns consistent embeddings for the same text", async () => {
    const vec1 = await generateEmbedding("test document");
    const vec2 = await generateEmbedding("test document");
    expect(vec1).toEqual(vec2);
  });

  it("returns different embeddings for different text", async () => {
    const vec1 = await generateEmbedding("typescript programming");
    const vec2 = await generateEmbedding("cooking recipes chocolate cake");
    const different = vec1.some((v, i) => v !== vec2[i]);
    expect(different).toBe(true);
  });

  it("produces normalized vectors", async () => {
    const vec = await generateEmbedding("This is a test document with enough words to generate a meaningful embedding");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    // Should be approximately 1.0 (allowing floating-point tolerance)
    expect(Math.abs(norm - 1.0)).toBeLessThan(0.01);
  });

  it("generates batch embeddings", async () => {
    const texts = ["hello", "world", "test"];
    const embeddings = await generateEmbeddings(texts);
    expect(embeddings).toHaveLength(3);
    for (const vec of embeddings) {
      expect(vec).toHaveLength(getEmbeddingDim());
    }
  });

  it("similar texts have higher cosine similarity than dissimilar texts", async () => {
    const base = await generateEmbedding("machine learning neural networks");
    const similar = await generateEmbedding("deep learning artificial intelligence");
    const dissimilar = await generateEmbedding("chocolate cake baking recipe");

    const simScore = cosineSimilarity(base, similar);
    const disScore = cosineSimilarity(base, dissimilar);

    expect(simScore).toBeGreaterThan(disScore);
  });

  it("getEmbeddingDim returns 384", () => {
    expect(getEmbeddingDim()).toBe(384);
  });

  it("handles whitespace-only text as empty", async () => {
    const vec = await generateEmbedding("   \t\n  ");
    expect(vec).toHaveLength(getEmbeddingDim());
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("handles very long text without crashing", async () => {
    const longText = "word ".repeat(5000);
    const vec = await generateEmbedding(longText);
    expect(vec).toHaveLength(getEmbeddingDim());
  }, 30_000);

  it("handles text with only special characters", async () => {
    const vec = await generateEmbedding("!@#$%^&*()");
    expect(vec).toHaveLength(getEmbeddingDim());
  });

  it("handles single-character input", async () => {
    const vec = await generateEmbedding("a");
    expect(vec).toHaveLength(getEmbeddingDim());
  });

  it("handles unicode text", async () => {
    const vec = await generateEmbedding("こんにちは世界 你好世界");
    expect(vec).toHaveLength(getEmbeddingDim());
  });

  it("handles text with numbers", async () => {
    const vec = await generateEmbedding("12345 67890");
    expect(vec).toHaveLength(getEmbeddingDim());
  });

  it("batch embeddings handles empty array", async () => {
    const results = await generateEmbeddings([]);
    expect(results).toEqual([]);
  });

  it("batch embeddings handles single item", async () => {
    const results = await generateEmbeddings(["test"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(getEmbeddingDim());
  });

  it("different short texts produce different embeddings", async () => {
    const v1 = await generateEmbedding("cat");
    const v2 = await generateEmbedding("quantum physics");
    expect(v1).not.toEqual(v2);
  });

  it("isModelReady returns a boolean", async () => {
    // Trigger model load first
    await generateEmbedding("init");
    const { isModelReady } = await import("./embedder.js");
    expect(typeof isModelReady()).toBe("boolean");
  });
});

/** Helper: cosine similarity between two vectors. */
const cosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};
