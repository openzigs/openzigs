/**
 * useWakeWord hook unit tests
 * Issue #230: Tests for state machine, wake word detection, fuzzy matching
 */

import { describe, it, expect } from "vitest";
import {
  levenshtein,
  levenshteinSimilarity,
  detectWakeWord,
  extractQueryAfterWakeWord,
} from "./use-wake-word";

describe("levenshtein", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("should return the length of the other string for empty input", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("should return 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("should handle single character difference", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
    expect(levenshtein("cat", "cats")).toBe(1);
    expect(levenshtein("cat", "at")).toBe(1);
  });

  it("should handle multiple differences", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("levenshteinSimilarity", () => {
  it("should return 1 for identical strings", () => {
    expect(levenshteinSimilarity("hello", "hello")).toBe(1);
  });

  it("should return 1 for two empty strings", () => {
    expect(levenshteinSimilarity("", "")).toBe(1);
  });

  it("should return 0 for completely different strings of same length", () => {
    // "abc" vs "xyz" — distance 3, maxLen 3
    expect(levenshteinSimilarity("abc", "xyz")).toBe(0);
  });

  it("should return a value between 0 and 1", () => {
    const sim = levenshteinSimilarity("hey zigs", "hey zig");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it("should rate 'hey zig' as highly similar to 'hey zigs'", () => {
    expect(levenshteinSimilarity("hey zig", "hey zigs")).toBeGreaterThan(0.8);
  });

  it("should rate 'hey sig' as reasonably similar to 'hey zigs'", () => {
    expect(levenshteinSimilarity("hey sig", "hey zigs")).toBeGreaterThan(0.7);
  });
});

describe("detectWakeWord", () => {
  it("should detect exact wake word", () => {
    expect(detectWakeWord("hey zigs")).toBe(true);
  });

  it("should detect wake word case-insensitively", () => {
    expect(detectWakeWord("Hey Zigs")).toBe(true);
    expect(detectWakeWord("HEY ZIGS")).toBe(true);
  });

  it("should detect common short/variant wake words from ASR", () => {
    expect(detectWakeWord("hey zig")).toBe(true);
    expect(detectWakeWord("hey sig")).toBe(true);
    expect(detectWakeWord("hey sigs")).toBe(true);
    expect(detectWakeWord("hey six")).toBe(true);
  });

  it("should detect common ASR spellings of zigs", () => {
    expect(detectWakeWord("hey zeegs")).toBe(true);
    expect(detectWakeWord("hey ziggs")).toBe(true);
  });

  it("should detect wake word within a sentence", () => {
    expect(detectWakeWord("okay hey zigs what time is it")).toBe(true);
  });

  it("should not detect unrelated text", () => {
    expect(detectWakeWord("hello world")).toBe(false);
    expect(detectWakeWord("what's the weather")).toBe(false);
  });

  it("should handle empty string", () => {
    expect(detectWakeWord("")).toBe(false);
  });

  it("should detect exact wake phrase followed by punctuation", () => {
    expect(detectWakeWord("hey zigs, what time is it", 0.7)).toBe(true);
  });

  it("should reject poor fuzzy matches", () => {
    expect(detectWakeWord("something completely different", 0.9)).toBe(false);
  });

  it("should not trigger on partial wake fragments", () => {
    expect(detectWakeWord("hey z", 0.7)).toBe(false);
  });

  it("should respect custom threshold", () => {
    // Even with a low threshold we keep strict wake-word recognition
    expect(detectWakeWord("hey dogs", 0.4)).toBe(false);
    // With very high threshold, non-exact matches still fail
    expect(detectWakeWord("hay zeeks", 0.99)).toBe(false);
  });
});

describe("extractQueryAfterWakeWord", () => {
  it("should extract text after 'hey zigs'", () => {
    expect(extractQueryAfterWakeWord("hey zigs what time is it")).toBe("what time is it");
  });

  it("should handle case-insensitivity", () => {
    expect(extractQueryAfterWakeWord("Hey Zigs What Time Is It")).toBe("What Time Is It");
  });

  it("should extract query for short wake phrase variant", () => {
    expect(extractQueryAfterWakeWord("hey zig what is the weather")).toBe("what is the weather");
  });

  it("should return empty string if no wake word", () => {
    expect(extractQueryAfterWakeWord("hello world")).toBe("");
  });

  it("should return empty string for wake word only", () => {
    expect(extractQueryAfterWakeWord("hey zigs")).toBe("");
  });

  it("should handle leading text before wake word", () => {
    expect(extractQueryAfterWakeWord("okay hey zigs tell me a joke")).toBe("tell me a joke");
  });

  it("should extract query for homophone wake phrase", () => {
    expect(extractQueryAfterWakeWord("hey six what is 2 plus 2", 0.7)).toBe("what is 2 plus 2");
  });

  it("should extract query for common ASR spelling of zigs", () => {
    expect(extractQueryAfterWakeWord("hey zeegs what is 2 plus 2", 0.7)).toBe("what is 2 plus 2");
  });

  it("should extract query for common homophone wake words", () => {
    expect(extractQueryAfterWakeWord("hey six what is 2 plus 2", 0.7)).toBe("what is 2 plus 2");
    expect(extractQueryAfterWakeWord("hey zig what is 2 plus 2", 0.7)).toBe("what is 2 plus 2");
  });

  it("should return empty for incomplete wake phrase only", () => {
    expect(extractQueryAfterWakeWord("hey zi", 0.7)).toBe("");
  });

  it("should prefer exact match over fuzzy match", () => {
    expect(extractQueryAfterWakeWord("hey zigs tell me the time", 0.7)).toBe("tell me the time");
  });
});
