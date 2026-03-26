import { describe, it, expect } from "vitest";
import { normalizeForTTS } from "./tts-text-normalizer.js";

describe("normalizeForTTS", () => {
  // ── Known acronym expansion (phonetic) ───────────────────

  it("expands known lowercase acronyms to phonetic forms", () => {
    expect(normalizeForTTS("Install npm and use the cli")).toBe(
      "Install en pee em and use the see ell eye",
    );
  });

  it("expands known uppercase acronyms to phonetic forms", () => {
    expect(normalizeForTTS("The API returns JSON")).toBe(
      "The ay pee eye returns Jason",
    );
  });

  it("handles mixed case known acronyms", () => {
    expect(normalizeForTTS("Use the NPM registry")).toBe(
      "Use the en pee em registry",
    );
  });

  it("converts unknown uppercase sequences to phonetic form", () => {
    expect(normalizeForTTS("Send it via MQTT")).toBe("Send it via em cue tee tee");
  });

  it("preserves pronounceable acronyms", () => {
    expect(normalizeForTTS("NASA launched a RADAR satellite")).toBe(
      "NASA launched a RADAR satellite",
    );
  });

  it("handles plural acronyms", () => {
    expect(normalizeForTTS("We tested multiple apis and gpus")).toBe(
      "We tested multiple ay pee eyes and gee pee yous",
    );
  });

  it("leaves normal text untouched", () => {
    const normal = "This is a completely normal sentence with no acronyms.";
    expect(normalizeForTTS(normal)).toBe(normal);
  });

  it("expands technical terms in context", () => {
    const input = "Run npm install to set up the sdk for gpu acceleration with ai models.";
    const expected = "Run en pee em install to set up the ess dee kay for gee pee you acceleration with ay eye models.";
    expect(normalizeForTTS(input)).toBe(expected);
  });

  it("expands etc to etcetera", () => {
    expect(normalizeForTTS("images, videos, etc")).toBe(
      "images, videos, etcetera",
    );
  });

  it("handles url and urls", () => {
    expect(normalizeForTTS("Check the url and urls")).toBe(
      "Check the you are ell and you are ells",
    );
  });

  // ── Already-dotted acronyms ──────────────────────────────

  it("expands already-dotted acronyms to phonetic forms", () => {
    expect(normalizeForTTS("Use A.I. tools")).toBe(
      "Use ay eye tools",
    );
  });

  it("expands U.S.A. to phonetic form", () => {
    expect(normalizeForTTS("Made in the U.S.A.")).toBe(
      "Made in the you ess ay",
    );
  });

  it("handles the exact failing example from the bug report", () => {
    expect(normalizeForTTS("Your A.I. assistant can answer questions")).toBe(
      "Your ay eye assistant can answer questions",
    );
  });

  // ── Mixed alphanumeric terms ─────────────────────────────

  it("expands mixed alphanumeric like MP4", () => {
    expect(normalizeForTTS("render an MP4")).toBe(
      "render an em pee four",
    );
  });

  it("expands number-first terms like 4K", () => {
    expect(normalizeForTTS("stream in 4K")).toBe(
      "stream in four kay",
    );
  });

  it("expands H264 correctly", () => {
    expect(normalizeForTTS("H264 codec")).toBe(
      "aitch two sixty four codec",
    );
  });

  // ── Common dotted abbreviations ──────────────────────────

  it("expands Dr. Mr. vs. etc.", () => {
    expect(normalizeForTTS("Dr. Smith vs. Prof. Jones")).toBe(
      "Doctor Smith versus Professor Jones",
    );
  });

  it("expands e.g. and i.e.", () => {
    expect(normalizeForTTS("Use a framework, e.g. React, i.e. the best one")).toBe(
      "Use a framework, for example React, that is the best one",
    );
  });

  // ── PAUSE tag conversion ─────────────────────────────────

  it("converts short PAUSE tags (≤0.5s) to commas", () => {
    expect(normalizeForTTS("And then [PAUSE: 0.3s] it happened")).toBe(
      "And then, it happened",
    );
  });

  it("converts medium PAUSE tags (0.5–1.5s) to ellipsis", () => {
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
    expect(normalizeForTTS("And that's it. [PAUSE: 2s] Moving on")).toBe(
      "And that's it.\nMoving on",
    );
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
      "Revenue grew by forty percent in cue four",
    );
  });
});
