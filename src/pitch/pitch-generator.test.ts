import { describe, it, expect, vi } from "vitest";
import { generateDeck, regenerateSlide, MAX_SLIDES_PER_DECK } from "./pitch-generator.js";
import { MAX_USER_SCRIPT_BYTES } from "./pitch-utils.js";
import type { BrandKit, Deck, Slide } from "./pitch-schema.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

const KIT: BrandKit = {
  id: "kit-1",
  name: "Acme",
  primaryColor: "#112233",
  secondaryColor: "#445566",
  accentColor: "#778899",
  fontHeading: "Inter",
  fontBody: "Inter",
  logoUrl: null,
  watermarkUrl: null,
  footerText: null,
};

const VALID_SLIDES: Slide[] = [
  {
    template: "title",
    content: { title: "Hello" },
    speaker_notes: "open",
    transition: "slide",
    fragments: [],
  },
  {
    template: "qa",
    content: { heading: "Questions?" },
    speaker_notes: "close",
    transition: "slide",
    fragments: [],
  },
];

const VALID_DECK_PAYLOAD = JSON.stringify({
  title: "Test Deck",
  aspect_ratio: "16:9",
  slides: VALID_SLIDES,
  metadata: { source_script: "irrelevant", tone: "formal", audience: "VCs" },
});

const FROZEN_CLOCK = () => new Date("2026-04-24T12:00:00.000Z");

/** Build a mock CopilotWrapper whose `chat()` yields the given strings in order. */
function mockCopilot(responses: string[]): {
  copilot: CopilotWrapper;
  chat: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const chat = vi.fn((_msg: string, _opts?: unknown) => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        "mockCopilot: chat called more times than responses provided",
      );
    }
    const payload: string = next;
    async function* gen(): AsyncGenerator<string> {
      // Stream the response in two arbitrary chunks so accumulateStream is exercised.
      const mid = Math.floor(payload.length / 2);
      yield payload.slice(0, mid);
      yield payload.slice(mid);
    }
    return gen();
  });

  // Bare-bones wrapper — only the methods our callers touch need to exist.
  const copilot = {
    chat,
  } as unknown as CopilotWrapper;

  return { copilot, chat };
}

describe("generateDeck", () => {
  it("happy path: parses valid LLM JSON into a Deck", async () => {
    const { copilot, chat } = mockCopilot([VALID_DECK_PAYLOAD]);
    const deck = await generateDeck({
      script: "the script",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(deck.title).toBe("Test Deck");
    expect(deck.slides).toHaveLength(2);
    expect(deck.brand_kit_id).toBe("kit-1");
    expect(deck.metadata.source_script).toBe("the script");
    expect(deck.created_at).toBe("2026-04-24T12:00:00.000Z");
    expect(deck.updated_at).toBe("2026-04-24T12:00:00.000Z");
    // The wrapper script-injection guard wraps the user input in DATA markers.
    const sentMessage = chat.mock.calls[0][0] as string;
    expect(sentMessage).toContain("<DATA>");
    expect(sentMessage).toContain("the script");
    expect(sentMessage).toContain("</DATA>");
  });

  it("strips ```json fences from the LLM output", async () => {
    const fenced = "```json\n" + VALID_DECK_PAYLOAD + "\n```";
    const { copilot } = mockCopilot([fenced]);
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(deck.title).toBe("Test Deck");
  });

  it("retries once on malformed JSON and succeeds on the second pass", async () => {
    const { copilot, chat } = mockCopilot(["not json at all", VALID_DECK_PAYLOAD]);
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(deck.title).toBe("Test Deck");
    // The retry user-prompt embeds the validation hint.
    const retryMsg = chat.mock.calls[1][0] as string;
    expect(retryMsg).toContain("Your previous output failed schema validation");
    expect(retryMsg).toContain("Output ONLY valid JSON");
  });

  it("retries once on schema violation and succeeds on the second pass", async () => {
    // First payload: structurally JSON but slides[0] has an invalid template.
    const bad = JSON.stringify({
      title: "Test Deck",
      slides: [{ template: "not_a_real_template", content: {} }],
      metadata: { source_script: "x", tone: "formal" },
    });
    const { copilot, chat } = mockCopilot([bad, VALID_DECK_PAYLOAD]);
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(deck.title).toBe("Test Deck");
  });

  it("throws when both the initial call and the retry produce invalid JSON", async () => {
    const { copilot, chat } = mockCopilot(["nope", "still nope"]);
    await expect(
      generateDeck({ script: "x", brandKit: KIT, copilot, clock: FROZEN_CLOCK }),
    ).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("rejects scripts over 50 KB without calling the LLM", async () => {
    const huge = "a".repeat(MAX_USER_SCRIPT_BYTES + 1);
    const { copilot, chat } = mockCopilot([VALID_DECK_PAYLOAD]);
    await expect(
      generateDeck({ script: huge, brandKit: KIT, copilot, clock: FROZEN_CLOCK }),
    ).rejects.toThrow(/50,000 byte cap/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("forces server-controlled fields (id, brand_kit_id, source_script) regardless of model output", async () => {
    // Model tries to assert a foreign brand_kit_id and a fake source_script.
    const malicious = JSON.stringify({
      id: "deck-from-model",
      title: "Test Deck",
      brand_kit_id: "kit-evil",
      slides: VALID_SLIDES,
      metadata: { source_script: "ignored content", tone: "formal" },
      created_at: "1999-01-01T00:00:00.000Z",
      updated_at: "1999-01-01T00:00:00.000Z",
    });
    const { copilot } = mockCopilot([malicious]);
    const deck = await generateDeck({
      script: "the real script",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(deck.brand_kit_id).toBe("kit-1");
    expect(deck.metadata.source_script).toBe("the real script");
    expect(deck.id).not.toBe("deck-from-model");
    expect(deck.created_at).toBe("2026-04-24T12:00:00.000Z");
  });

  it("propagates audience + tone overrides into the deck metadata", async () => {
    const { copilot } = mockCopilot([VALID_DECK_PAYLOAD]);
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      options: { audience: "Founders", tone: "sales", estimatedMinutes: 5 },
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(deck.metadata.audience).toBe("Founders");
    expect(deck.metadata.tone).toBe("sales");
    expect(deck.metadata.estimated_minutes).toBe(5);
  });

  it("forwards model + sessionId into copilot.chat options when provided", async () => {
    const { copilot, chat } = mockCopilot([VALID_DECK_PAYLOAD]);
    await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
      model: "gpt-5",
      sessionId: "sess-7",
      clock: FROZEN_CLOCK,
    });
    const opts = chat.mock.calls[0][1] as {
      model?: string;
      conversationId?: string;
      agent?: string;
    };
    expect(opts.model).toBe("gpt-5");
    expect(opts.conversationId).toBe("sess-7");
    expect(opts.agent).toBe("pitch-writer");
  });

  it("uses the system clock when `clock` is not supplied (created_at is a recent ISO string)", async () => {
    const { copilot } = mockCopilot([VALID_DECK_PAYLOAD]);
    const before = Date.now();
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
    });
    const ts = Date.parse(deck.created_at);
    expect(ts).toBeGreaterThanOrEqual(before - 1_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  // ── Phase 7 / sub-issue #977 — 80-slide cap (defence-in-depth) ─────
  it("truncates to MAX_SLIDES_PER_DECK when the LLM returns more slides than allowed", async () => {
    expect(MAX_SLIDES_PER_DECK).toBe(80);
    // Generate 100 alternating bullet/qa slides — well over the cap.
    const oversized = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0
        ? {
            template: "bullet_list" as const,
            content: { heading: `H${i}`, bullets: ["a", "b"] },
            speaker_notes: "",
            transition: "slide" as const,
            fragments: [],
          }
        : {
            template: "qa" as const,
            content: { heading: `Q${i}` },
            speaker_notes: "",
            transition: "slide" as const,
            fragments: [],
          },
    );
    const oversizedPayload = JSON.stringify({
      title: "Too Many",
      aspect_ratio: "16:9",
      slides: oversized,
      metadata: { source_script: "x", tone: "formal", audience: "VCs" },
    });
    const { copilot } = mockCopilot([oversizedPayload]);
    const deck = await generateDeck({
      script: "x",
      brandKit: KIT,
      copilot,
      clock: FROZEN_CLOCK,
    });
    expect(deck.slides).toHaveLength(MAX_SLIDES_PER_DECK);
    // Truncated from the FRONT — slide 0 should still be the first one.
    expect(deck.slides[0].template).toBe("bullet_list");
  });
});

describe("regenerateSlide", () => {
  const baseDeck: Deck = {
    id: "d-1",
    title: "Demo",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides: VALID_SLIDES,
    metadata: { source_script: "x", tone: "formal" },
    created_at: "2026-04-24T12:00:00.000Z",
    updated_at: "2026-04-24T12:00:00.000Z",
  };

  it("happy path: returns a validated Slide", async () => {
    const newSlide: Slide = {
      template: "qa",
      content: { heading: "Final thoughts?" },
      speaker_notes: "wrap",
      transition: "slide",
      fragments: [],
    };
    const { copilot, chat } = mockCopilot([JSON.stringify(newSlide)]);
    const out = await regenerateSlide({
      deck: baseDeck,
      slide: VALID_SLIDES[1],
      hint: "make it punchier",
      copilot,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.template).toBe("qa");
    if (out.template === "qa") {
      expect(out.content.heading).toBe("Final thoughts?");
    }
  });

  it("retries once on schema failure", async () => {
    const newSlide: Slide = {
      template: "qa",
      content: { heading: "Done" },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    };
    const { copilot, chat } = mockCopilot([
      JSON.stringify({ template: "nope", content: {} }),
      JSON.stringify(newSlide),
    ]);
    const out = await regenerateSlide({
      deck: baseDeck,
      slide: VALID_SLIDES[1],
      copilot,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.template).toBe("qa");
  });

  it("throws when both calls fail validation", async () => {
    const { copilot, chat } = mockCopilot(["nope", "still nope"]);
    await expect(
      regenerateSlide({
        deck: baseDeck,
        slide: VALID_SLIDES[1],
        copilot,
      }),
    ).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("forwards model + sessionId into copilot.chat options when provided", async () => {
    const newSlide: Slide = {
      template: "qa",
      content: { heading: "ok" },
      speaker_notes: "",
      transition: "slide",
      fragments: [],
    };
    const { copilot, chat } = mockCopilot([JSON.stringify(newSlide)]);
    await regenerateSlide({
      deck: baseDeck,
      slide: VALID_SLIDES[1],
      copilot,
      model: "gpt-5",
      sessionId: "sess-9",
    });
    const opts = chat.mock.calls[0][1] as {
      model?: string;
      conversationId?: string;
      agent?: string;
    };
    expect(opts.model).toBe("gpt-5");
    expect(opts.conversationId).toBe("sess-9");
    expect(opts.agent).toBe("pitch-writer");
  });
});
