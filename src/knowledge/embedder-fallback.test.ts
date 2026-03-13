/**
 * Tests for the embedder fallback path (hash-based embeddings)
 * and edge cases that require mocking the transformer pipeline.
 *
 * Separated from embedder.test.ts because that file tests the real ONNX model
 * while this file mocks the pipeline to exercise fallback/error paths.
 */
import { describe, it, expect, vi } from "vitest";

// Force pipeline to fail → triggers hash-based fallback
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockRejectedValue(new Error("Model not available")),
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Must import AFTER vi.mock so the module uses mocked transformers
const { generateEmbedding, generateEmbeddings, getEmbeddingDim, isModelReady, shutdownEmbedder } =
  await import("./embedder.js");

describe("embedder (fallback path)", () => {
  const DIM = 384;

  it("falls back to hash-based embedding when model fails", async () => {
    const vec = await generateEmbedding("test document content");
    expect(vec).toHaveLength(DIM);
    // Hash-based embedding should produce non-zero values for real text
    expect(vec.some((v) => v !== 0)).toBe(true);
  });

  it("produces normalized vectors in fallback mode", async () => {
    const vec = await generateEmbedding("normalized test text with several words");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(Math.abs(norm - 1.0)).toBeLessThan(0.01);
  });

  it("returns zero vector for empty text in fallback mode", async () => {
    const vec = await generateEmbedding("");
    expect(vec).toHaveLength(DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("returns zero vector for whitespace-only text in fallback mode", async () => {
    const vec = await generateEmbedding("   \t\n  ");
    expect(vec).toHaveLength(DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("returns zero vector for special characters only", async () => {
    // Only single-char tokens after filtering, all get filtered by length > 1
    const vec = await generateEmbedding("! @ # $ %");
    expect(vec).toHaveLength(DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("produces consistent results for same text", async () => {
    const vec1 = await generateEmbedding("consistent test input");
    const vec2 = await generateEmbedding("consistent test input");
    expect(vec1).toEqual(vec2);
  });

  it("produces different results for different text", async () => {
    const vec1 = await generateEmbedding("typescript programming language");
    const vec2 = await generateEmbedding("chocolate cake baking recipe");
    const different = vec1.some((v, i) => v !== vec2[i]);
    expect(different).toBe(true);
  });

  it("handles long text without crashing", async () => {
    const longText = "word ".repeat(5000);
    const vec = await generateEmbedding(longText);
    expect(vec).toHaveLength(DIM);
  });

  it("batch embeddings work in fallback mode", async () => {
    const results = await generateEmbeddings(["hello", "world"]);
    expect(results).toHaveLength(2);
    results.forEach((vec) => expect(vec).toHaveLength(DIM));
  });

  it("isModelReady returns false when pipeline failed", () => {
    expect(isModelReady()).toBe(false);
  });

  it("getEmbeddingDim returns 384", () => {
    expect(getEmbeddingDim()).toBe(DIM);
  });

  it("shutdownEmbedder does not throw", async () => {
    await expect(shutdownEmbedder()).resolves.not.toThrow();
  });
});
