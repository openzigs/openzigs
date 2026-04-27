/**
 * Pitch — `pitch-condense` unit tests.
 *
 * Covers:
 *   - under-cap passthrough makes ZERO LLM calls (cost discipline);
 *   - single-chunk condense calls the LLM once;
 *   - multi-chunk map-reduce with no reduce stage when concat fits;
 *   - reduce stage triggers when concat is still over target;
 *   - 2 MB hard ceiling rejection BEFORE any LLM call;
 *   - retry-on-empty: empty first response → second attempt succeeds;
 *   - both attempts empty → throws.
 *
 * The Copilot wrapper is mocked with `vi.fn()` returning canned async
 * iterators so the test never touches a real model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  condenseScript,
  splitIntoChunks,
  CONDENSE_HARD_CEILING_BYTES,
  DEFAULT_CONDENSE_TARGET_BYTES,
  CONDENSE_CHUNK_CHARS,
  DEFAULT_CONDENSE_MODEL,
} from "./pitch-condense.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Build an async-iterable that yields the given chunks one by one. */
function streamOf(...chunks: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/** Build a fake CopilotWrapper whose `.chat()` returns canned outputs in
 *  call order. The Nth invocation yields `outputs[N]` as a single chunk. */
function fakeCopilot(outputs: string[]): {
  copilot: CopilotWrapper;
  chat: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const chat = vi.fn().mockImplementation(() => {
    const out = outputs[i] ?? "";
    i += 1;
    return streamOf(out);
  });
  return {
    copilot: { chat } as unknown as CopilotWrapper,
    chat,
  };
}

describe("splitIntoChunks", () => {
  it("returns the input unchanged when under the limit", () => {
    expect(splitIntoChunks("short", 100)).toEqual(["short"]);
  });

  it("prefers paragraph (\\n\\n) boundaries", () => {
    const text = ["A".repeat(40), "B".repeat(40), "C".repeat(40)].join("\n\n");
    const parts = splitIntoChunks(text, 90);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // No part should exceed the cap by more than a small margin (we always
    // cut at <= maxChars, then trim trailing whitespace).
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(90);
  });

  it("falls back to line boundaries, then hard cut", () => {
    const text = "X".repeat(250);
    const parts = splitIntoChunks(text, 100);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
  });

  it("rejects non-positive maxChars", () => {
    expect(() => splitIntoChunks("x", 0)).toThrow();
  });
});

describe("condenseScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passthrough: makes ZERO LLM calls when input is already under target", async () => {
    const { copilot, chat } = fakeCopilot([]);
    const result = await condenseScript("a small script", copilot);
    expect(chat).not.toHaveBeenCalled();
    expect(result.chunks).toBe(0);
    expect(result.condensed).toBe("a small script");
    expect(result.originalBytes).toBe(result.condensedBytes);
  });

  it("single-chunk condense: 1 LLM call, returns the summary", async () => {
    // Build text just over the (small) target so we trigger the map path
    // but only generate a single chunk.
    const text = "P".repeat(50);
    const { copilot, chat } = fakeCopilot(["short summary"]);
    const result = await condenseScript(text, copilot, { targetBytes: 30 });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.chunks).toBe(1);
    expect(result.condensed).toBe("short summary");
    expect(result.condensedBytes).toBeLessThan(result.originalBytes);
  });

  it("multi-chunk map: N LLM calls, no reduce when concat fits target", async () => {
    // 3 paragraph blocks ~20k chars each (well under the 30k chunk cap),
    // separated by `\n\n` so the splitter cleanly produces exactly 3
    // chunks. Summaries are short so concat stays under the target and
    // the reduce stage does NOT run.
    const para = (label: string): string => `${label}\n\n` + "X".repeat(20_000);
    const text = [para("A"), para("B"), para("C")].join("\n\n");
    const { copilot, chat } = fakeCopilot([
      "summary A",
      "summary B",
      "summary C",
    ]);
    const result = await condenseScript(text, copilot, {
      targetBytes: 1_000,
    });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.chunks).toBe(3);
    expect(result.condensed).toContain("summary A");
    expect(result.condensed).toContain("summary B");
    expect(result.condensed).toContain("summary C");
  });

  it("reduce stage runs when map concat is still over target", async () => {
    // 2 chunks, each summary is large enough that concat > target.
    const text = "X".repeat(CONDENSE_CHUNK_CHARS) + "\n\n" + "Y".repeat(CONDENSE_CHUNK_CHARS);
    const bigSummary = "Z".repeat(800);
    const { copilot, chat } = fakeCopilot([
      bigSummary, // map 1
      bigSummary, // map 2
      "final reduced script", // reduce
    ]);
    const result = await condenseScript(text, copilot, { targetBytes: 1_000 });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.chunks).toBe(2);
    expect(result.condensed).toBe("final reduced script");
  });

  it("rejects empty input", async () => {
    const { copilot } = fakeCopilot([]);
    await expect(condenseScript("", copilot)).rejects.toThrow(/empty/i);
  });

  it("rejects input over the 2 MB hard ceiling BEFORE any LLM call", async () => {
    const oversize = "x".repeat(CONDENSE_HARD_CEILING_BYTES + 1);
    const { copilot, chat } = fakeCopilot([]);
    await expect(condenseScript(oversize, copilot)).rejects.toThrow(
      /hard ceiling/i,
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("retries once on empty LLM response, then succeeds", async () => {
    const text = "P".repeat(50);
    const { copilot, chat } = fakeCopilot(["", "recovered summary"]);
    const result = await condenseScript(text, copilot, { targetBytes: 30 });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.condensed).toBe("recovered summary");
  });

  it("throws when both attempts return empty", async () => {
    const text = "P".repeat(50);
    const { copilot, chat } = fakeCopilot(["", ""]);
    await expect(
      condenseScript(text, copilot, { targetBytes: 30 }),
    ).rejects.toThrow(/empty/i);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("uses the default target when none is provided", async () => {
    // Just over default; the splitter will produce 2 chunks at the
    // CONDENSE_CHUNK_CHARS boundary. Provide enough canned outputs to
    // cover the worst case and assert via call-count + chunks.
    const text = "Q".repeat(DEFAULT_CONDENSE_TARGET_BYTES + 100);
    const { copilot, chat } = fakeCopilot(Array(10).fill("ok"));
    const result = await condenseScript(text, copilot);
    expect(chat).toHaveBeenCalled();
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.originalBytes).toBe(text.length);
  });

  it("passes DEFAULT_CONDENSE_MODEL when no model override is provided", async () => {
    const text = "P".repeat(50);
    const { copilot, chat } = fakeCopilot(["ok"]);
    await condenseScript(text, copilot, { targetBytes: 30 });
    expect(chat).toHaveBeenCalledTimes(1);
    const opts = chat.mock.calls[0][1];
    expect(opts.model).toBe(DEFAULT_CONDENSE_MODEL);
  });

  it("preserves chunk order even when LLM responses resolve out of order", async () => {
    // 4 paragraph blocks ~20k chars each → 4 distinct map chunks.
    const para = (label: string): string => `${label}\n\n` + "X".repeat(20_000);
    const text = [para("A"), para("B"), para("C"), para("D")].join("\n\n");

    // Build a chat mock that returns a stream which resolves with a
    // per-call delay tuned so chunk-3 finishes first and chunk-1 last.
    // Index in the prompt is the 1-based chunk number — we extract it
    // and key the delay table off it. This proves we write summaries by
    // *input index*, not by completion order.
    const delaysByIndex: Record<number, number> = { 1: 40, 2: 25, 3: 5, 4: 15 };
    const labelByIndex: Record<number, string> = {
      1: "summary one",
      2: "summary two",
      3: "summary three",
      4: "summary four",
    };
    const chat = vi.fn().mockImplementation((prompt: string) => {
      const m = prompt.match(/section \((\d+) of \d+\)/);
      const idx = m ? Number(m[1]) : 0;
      const delay = delaysByIndex[idx] ?? 0;
      const label = labelByIndex[idx] ?? "";
      return (async function* () {
        await new Promise((r) => setTimeout(r, delay));
        yield label;
      })();
    });
    const copilot = { chat } as unknown as CopilotWrapper;

    const result = await condenseScript(text, copilot, { targetBytes: 50_000 });

    expect(chat).toHaveBeenCalledTimes(4);
    expect(result.chunks).toBe(4);
    // Order MUST follow input chunk order, NOT completion order.
    expect(result.condensed).toBe(
      ["summary one", "summary two", "summary three", "summary four"].join(
        "\n\n",
      ),
    );
  });
});
