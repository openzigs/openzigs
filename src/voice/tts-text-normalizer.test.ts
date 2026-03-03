import { describe, it, expect } from "vitest";
import { normalizeForTTS } from "./tts-text-normalizer.js";

describe("normalizeForTTS", () => {
  it("expands known lowercase acronyms", () => {
    expect(normalizeForTTS("Install npm and use the cli")).toBe(
      "Install N.P.M. and use the C.L.I.",
    );
  });

  it("expands known uppercase acronyms", () => {
    expect(normalizeForTTS("The API returns JSON")).toBe(
      "The A.P.I. returns J.SON",
    );
  });

  it("handles mixed case known acronyms", () => {
    expect(normalizeForTTS("Use the NPM registry")).toBe(
      "Use the N.P.M. registry",
    );
  });

  it("converts unknown uppercase sequences to dotted form", () => {
    expect(normalizeForTTS("Send it via MQTT")).toBe("Send it via M.Q.T.T.");
  });

  it("preserves pronounceable acronyms", () => {
    expect(normalizeForTTS("NASA launched a RADAR satellite")).toBe(
      "NASA launched a RADAR satellite",
    );
  });

  it("handles plural acronyms", () => {
    expect(normalizeForTTS("We tested multiple apis and gpus")).toBe(
      "We tested multiple A.P.I.s and G.P.U.s",
    );
  });

  it("leaves normal text untouched", () => {
    const normal = "This is a completely normal sentence with no acronyms.";
    expect(normalizeForTTS(normal)).toBe(normal);
  });

  it("expands technical terms in context", () => {
    const input = "Run npm install to set up the sdk for gpu acceleration with ai models.";
    const expected = "Run N.P.M. install to set up the S.D.K. for G.P.U. acceleration with A.I. models.";
    expect(normalizeForTTS(input)).toBe(expected);
  });

  it("does not double-process already dotted forms", () => {
    expect(normalizeForTTS("Use A.P.I. endpoints")).toBe(
      "Use A.P.I. endpoints",
    );
  });

  it("expands etc to etcetera", () => {
    expect(normalizeForTTS("images, videos, etc")).toBe(
      "images, videos, etcetera",
    );
  });

  it("handles url and urls", () => {
    expect(normalizeForTTS("Check the url and urls")).toBe(
      "Check the U.R.L. and U.R.L.s",
    );
  });

  // ── PAUSE tag conversion ─────────────────────────────────

  it("converts short PAUSE tags (≤0.5s) to commas", () => {
    expect(normalizeForTTS("And then [PAUSE: 0.3s] it happened")).toBe(
      "And then, it happened",
    );
  });

  it("converts medium PAUSE tags (0.5–1.5s) to ellipsis", () => {
    // When preceded by existing punctuation, the ellipsis is cleaned up
    // since the `?` already introduces a natural pause in F5-TTS
    expect(normalizeForTTS("The result? [PAUSE: 1s] A 40% increase")).toBe(
      "The result? A 40% increase",
    );
  });

  it("converts medium PAUSE without prior punctuation", () => {
    expect(normalizeForTTS("And then [PAUSE: 1s] it happened")).toBe(
      "And then... it happened",
    );
  });

  it("converts long PAUSE tags (>1.5s) to period + newline", () => {
    expect(normalizeForTTS("Chapter one ends here [PAUSE: 2s] Chapter two begins")).toBe(
      "Chapter one ends here.\nChapter two begins",
    );
  });

  it("cleans up redundant punctuation after pause conversion", () => {
    // Existing period + long pause → just period + newline
    expect(normalizeForTTS("And that's it. [PAUSE: 2s] Moving on")).toBe(
      "And that's it.\nMoving on",
    );
    // Existing question mark + medium pause → question mark is sufficient
    expect(normalizeForTTS("Ready? [PAUSE: 1s] Let's go")).toBe(
      "Ready? Let's go",
    );
  });

  // ── Emphasis stripping ─────────────────────────────────

  it("strips emphasis markers and keeps the word", () => {
    expect(normalizeForTTS("This is *critical* for success")).toBe(
      "This is critical for success",
    );
  });

  it("strips multiple emphasis markers", () => {
    expect(normalizeForTTS("Revenue grew by *forty percent* in *Q4*")).toBe(
      "Revenue grew by forty percent in Q4",
    );
  });
});
