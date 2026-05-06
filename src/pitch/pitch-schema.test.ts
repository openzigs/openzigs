import { describe, it, expect } from "vitest";
import {
  BrandKitSchema,
  DeckSchema,
  DeckToneEnum,
  DraftDeckBodySchema,
  HexColor,
  SLIDE_TEMPLATES,
  SlideAssetSchema,
  SlideSchema,
  type Slide,
} from "./pitch-schema.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function validBrandKit() {
  return {
    id: "kit-1",
    name: "Test Kit",
    primaryColor: "#112233",
    secondaryColor: "#445566",
    accentColor: "#778899",
    fontHeading: "Inter",
    fontBody: "Inter",
    logoUrl: null,
    watermarkUrl: null,
    footerText: null,
  };
}

function validSlide<T extends Slide["template"]>(
  template: T,
  content: unknown,
): unknown {
  return { template, content };
}

function validDeck(slides: unknown[] = [validSlide("title", { title: "Hi" })]) {
  return {
    id: "d-1",
    title: "Test Deck",
    brand_kit_id: "kit-1",
    slides,
    metadata: { source_script: "the script" },
    created_at: "2026-04-24T12:00:00Z",
    updated_at: "2026-04-24T12:00:00Z",
  };
}

// ── HexColor ───────────────────────────────────────────────────────────────

describe("HexColor", () => {
  it.each(["#000000", "#ffffff", "#abCDef", "#123456"])("accepts %s", (v) => {
    expect(HexColor.parse(v)).toBe(v);
  });

  it.each(["", "000000", "#fff", "#1234567", "#zzzzzz", "rgb(0,0,0)"])(
    "rejects %s",
    (v) => {
      expect(() => HexColor.parse(v)).toThrow();
    },
  );
});

// ── BrandKitSchema ─────────────────────────────────────────────────────────

describe("BrandKitSchema", () => {
  it("round-trips a valid kit", () => {
    const parsed = BrandKitSchema.parse(validBrandKit());
    expect(parsed.fontHeading).toBe("Inter");
    expect(parsed.footerText).toBeNull();
  });

  it("requires hex colors", () => {
    expect(() =>
      BrandKitSchema.parse({ ...validBrandKit(), primaryColor: "blue" }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() =>
      BrandKitSchema.parse({ ...validBrandKit(), name: "" }),
    ).toThrow();
  });

  it("requires id, fonts, and color set", () => {
    const incomplete = { ...validBrandKit() } as Partial<
      ReturnType<typeof validBrandKit>
    >;
    delete incomplete.fontBody;
    expect(() => BrandKitSchema.parse(incomplete)).toThrow();
  });

  it("allows nullable url and footer fields", () => {
    const parsed = BrandKitSchema.parse({
      ...validBrandKit(),
      logoUrl: "https://example.com/logo.png",
      watermarkUrl: null,
      footerText: "© 2026",
    });
    expect(parsed.logoUrl).toContain("logo.png");
    expect(parsed.footerText).toBe("© 2026");
  });
});

// ── SSRF allowlist enumeration (Phase 7 / sub-issue #977) ─────────────
//
// Every URL-typed field in the schema is server-populated, never user-
// supplied. This test asserts the EXACT set of URL fields so that any
// future addition forces the author to:
//   1) Update this allowlist, and
//   2) Wire the new field through `isAllowedWebhookUrl` (or equivalent
//      SSRF guard) before persistence.

describe("Schema URL-field SSRF audit", () => {
  // Allowlist of every `z.string().url()` field path in pitch-schema.ts.
  // Format: "<SchemaName>.<fieldName>".
  const ALLOWED_URL_FIELDS = [
    "BrandKitSchema.logoUrl",
    "BrandKitSchema.watermarkUrl",
    "SlideImageSchema.url",
  ] as const;

  it("source file has exactly the enumerated URL fields", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const src = await readFile(`${here}pitch-schema.ts`, "utf8");
    // Count actual `z.string().url()` occurrences in CODE only (skip
    // JSDoc/comment lines so a documented example doesn't trip the
    // count).
    const codeOnly = src
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    const matches = codeOnly.match(/z\s*\.\s*string\s*\(\s*\)\s*\.\s*url\s*\(\s*\)/g) ?? [];
    expect(matches.length).toBe(ALLOWED_URL_FIELDS.length);
  });
});

// ── SlideSchema (one positive + one negative test per template) ───────────

describe("SlideSchema — discriminated union covers all 14 templates", () => {
  it("declares exactly 14 templates", () => {
    expect(SLIDE_TEMPLATES).toHaveLength(14);
  });

  it("rejects unknown template", () => {
    expect(() =>
      SlideSchema.parse({ template: "nope", content: {} }),
    ).toThrow();
  });

  it("title — accepts minimal + applies Common defaults", () => {
    const parsed = SlideSchema.parse(
      validSlide("title", { title: "Hello" }),
    );
    expect(parsed.template).toBe("title");
    expect(parsed.transition).toBe("slide");
    expect(parsed.fragments).toEqual([]);
    expect(parsed.speaker_notes).toBe("");
  });

  it("title — rejects empty title", () => {
    expect(() =>
      SlideSchema.parse(validSlide("title", { title: "" })),
    ).toThrow();
  });

  it("section_divider — accepts and rejects out-of-range section number", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("section_divider", { section_number: 1, title: "Intro" }),
      ),
    ).not.toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("section_divider", { section_number: 0, title: "Intro" }),
      ),
    ).toThrow();
  });

  it("bullet_list — enforces 1..7 bullets and 160-char per bullet", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("bullet_list", { heading: "Key", bullets: [] }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("bullet_list", {
          heading: "Key",
          bullets: Array.from({ length: 8 }, (_, i) => `b${i}`),
        }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("bullet_list", {
          heading: "Key",
          bullets: ["a".repeat(161)],
        }),
      ),
    ).toThrow();
    const ok = SlideSchema.parse(
      validSlide("bullet_list", { heading: "Key", bullets: ["one", "two"] }),
    );
    expect(ok.template).toBe("bullet_list");
  });

  it("two_column — accepts and rejects oversized column", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("two_column", {
          heading: "h",
          left: "L",
          right: "R",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("two_column", {
          heading: "h",
          left: "x".repeat(801),
          right: "R",
        }),
      ),
    ).toThrow();
  });

  it("image_caption — requires a valid image", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("image_caption", {
          image: { prompt: "A cat", url: null, alt: "cat" },
          caption: "the cat",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("image_caption", {
          image: { prompt: "ok", url: "not-a-url", alt: "x" },
          caption: "x",
        }),
      ),
    ).toThrow();
  });

  it("image_caption — accepts routed internal asset URLs for persisted generated images", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("image_caption", {
          image: {
            prompt: "A cat",
            url: "/api/admin/pitch/decks/deck-1/assets/asset-1",
            alt: "cat",
          },
          caption: "the cat",
        }),
      ),
    ).not.toThrow();
  });

  it("image_caption — rejects protocol-relative asset URLs", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("image_caption", {
          image: {
            prompt: "A cat",
            url: "//example.com/asset.png",
            alt: "cat",
          },
          caption: "the cat",
        }),
      ),
    ).toThrow();
  });

  it("quote — accepts and rejects empty quote", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("quote", { quote: "We ship.", attribution: "Eng" }),
      ),
    ).not.toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("quote", { quote: "", attribution: "Eng" }),
      ),
    ).toThrow();
  });

  it("stats_kpi — enforces 2..6 kpis", () => {
    const kpi = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ value: `${i}`, label: `L${i}` }));
    expect(() =>
      SlideSchema.parse(
        validSlide("stats_kpi", { heading: "Q4", kpis: kpi(1) }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("stats_kpi", { heading: "Q4", kpis: kpi(7) }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("stats_kpi", { heading: "Q4", kpis: kpi(3) }),
      ),
    ).not.toThrow();
  });

  it("stats_kpi — accepts `null` delta on a kpi (LLMs emit null, not omission)", () => {
    // Bug-fix (post-PR-#1024 walkthrough): LLM legitimately returns
    // `null` for `delta` when there's no quarter-over-quarter change.
    // Schema previously rejected it as "Expected string, received null".
    expect(() =>
      SlideSchema.parse(
        validSlide("stats_kpi", {
          heading: "Q4",
          kpis: [
            { value: "12M", label: "ARR", delta: "+8%" },
            { value: "3.2", label: "NPS", delta: null },
            { value: "97%", label: "Retention" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("title — accepts `null` for optional subtitle/eyebrow", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("title", { title: "Hi", subtitle: null, eyebrow: null }),
      ),
    ).not.toThrow();
  });

  it("comparison_table — enforces 2..5 columns and ≥1 row", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("comparison_table", {
          heading: "vs",
          columns: ["A"],
          rows: [{ label: "x", cells: ["a"] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("comparison_table", {
          heading: "vs",
          columns: ["A", "B"],
          rows: [{ label: "x", cells: ["a", "b"] }],
        }),
      ),
    ).not.toThrow();
  });

  it("timeline — enforces 2..8 events", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("timeline", {
          heading: "Roadmap",
          events: [{ when: "Q1", what: "launch" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("timeline", {
          heading: "Roadmap",
          events: [
            { when: "Q1", what: "launch" },
            { when: "Q2", what: "scale" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("full_bleed — accepts overlay text", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("full_bleed", {
          image: { prompt: "ocean", url: null, alt: "ocean" },
          overlay_text: "We are the ocean.",
        }),
      ),
    ).not.toThrow();
  });

  it("code — accepts code with highlight lines and rejects empty source", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("code", {
          language: "ts",
          code: "const x = 1;",
          highlight_lines: [1],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("code", { language: "ts", code: "" }),
      ),
    ).toThrow();
  });

  it("qa — applies default heading", () => {
    const parsed = SlideSchema.parse(validSlide("qa", {}));
    if (parsed.template !== "qa") throw new Error("wrong template");
    expect(parsed.content.heading).toBe("Questions?");
  });

  it("chart — requires valid chart_type and at least 1 series", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("chart", {
          heading: "Sales",
          chart_type: "bubble",
          series: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("chart", {
          heading: "Sales",
          chart_type: "bar",
          series: [{ name: "Q4", data: [{ x: "NA", y: 120 }] }],
        }),
      ),
    ).not.toThrow();
  });

  it("mermaid — requires diagram_type and source", () => {
    expect(() =>
      SlideSchema.parse(
        validSlide("mermaid", { diagram_type: "flowchart", source: "" }),
      ),
    ).toThrow();
    expect(() =>
      SlideSchema.parse(
        validSlide("mermaid", {
          diagram_type: "flowchart",
          source: "graph TD; A-->B;",
        }),
      ),
    ).not.toThrow();
  });

  it("source_range — optional, round-trips when present (sub-issue #969)", () => {
    // Absent ⇒ undefined.
    const slideNoRange = SlideSchema.parse(
      validSlide("title", { title: "Hello" }),
    );
    expect(slideNoRange.source_range).toBeUndefined();

    // Present ⇒ preserved verbatim.
    const base = validSlide("title", { title: "Hello" }) as Record<string, unknown>;
    const slideWithRange = SlideSchema.parse({
      ...base,
      source_range: { start: 0, end: 42 },
    });
    expect(slideWithRange.source_range).toEqual({ start: 0, end: 42 });

    // Negative offsets rejected.
    expect(() =>
      SlideSchema.parse({
        ...base,
        source_range: { start: -1, end: 5 },
      }),
    ).toThrow();

    // Non-integer rejected.
    expect(() =>
      SlideSchema.parse({
        ...base,
        source_range: { start: 0.5, end: 5 },
      }),
    ).toThrow();
  });
});

// ── DeckSchema ─────────────────────────────────────────────────────────────

describe("DeckSchema", () => {
  it("round-trips a deck with one title slide", () => {
    const parsed = DeckSchema.parse(validDeck());
    expect(parsed.aspect_ratio).toBe("16:9");
    expect(parsed.metadata.tone).toBe("formal");
    expect(parsed.slides).toHaveLength(1);
  });

  it("requires at least 1 slide", () => {
    expect(() => DeckSchema.parse(validDeck([]))).toThrow();
  });

  it("rejects more than 80 slides", () => {
    const eightyOne = Array.from({ length: 81 }, () =>
      validSlide("title", { title: "T" }),
    );
    expect(() => DeckSchema.parse(validDeck(eightyOne))).toThrow();
  });

  it("rejects empty title and missing brand_kit_id", () => {
    expect(() =>
      DeckSchema.parse({ ...validDeck(), title: "" }),
    ).toThrow();
    expect(() =>
      DeckSchema.parse({ ...validDeck(), brand_kit_id: "" }),
    ).toThrow();
  });

  it("rejects unknown tone and unknown aspect ratio", () => {
    expect(() =>
      DeckSchema.parse({
        ...validDeck(),
        metadata: { source_script: "x", tone: "snarky" },
      }),
    ).toThrow();
    expect(() =>
      DeckSchema.parse({ ...validDeck(), aspect_ratio: "21:9" }),
    ).toThrow();
  });

  it("caps source_script length", () => {
    expect(() =>
      DeckSchema.parse({
        ...validDeck(),
        metadata: { source_script: "x".repeat(50_001) },
      }),
    ).toThrow();
  });
});

// ── SlideAssetSchema ───────────────────────────────────────────────────────

describe("SlideAssetSchema", () => {
  it("accepts a fully-populated asset", () => {
    const parsed = SlideAssetSchema.parse({
      id: "a-1",
      deck_id: "d-1",
      slide_id: "s-1",
      kind: "image",
      source: "fluxq",
      prompt: "A robot",
      local_path: "/tmp/a.png",
      mime: "image/png",
      width: 1024,
      height: 1024,
      created_at: "2026-04-24T12:00:00Z",
    });
    expect(parsed.kind).toBe("image");
    expect(parsed.source).toBe("fluxq");
  });

  it("allows null slide_id and null prompt (deck-level / upload assets)", () => {
    const parsed = SlideAssetSchema.parse({
      id: "a-1",
      deck_id: "d-1",
      slide_id: null,
      kind: "logo",
      source: "upload",
      prompt: null,
      local_path: "/tmp/a.png",
      mime: "image/png",
      width: 1,
      height: 1,
      created_at: "now",
    });
    expect(parsed.slide_id).toBeNull();
    expect(parsed.prompt).toBeNull();
  });

  it("rejects non-positive dimensions and empty path", () => {
    const base = {
      id: "a-1",
      deck_id: "d-1",
      slide_id: "s-1",
      kind: "image" as const,
      source: "url" as const,
      prompt: null,
      local_path: "/tmp/a.png",
      mime: "image/png",
      width: 1,
      height: 1,
      created_at: "now",
    };
    expect(() =>
      SlideAssetSchema.parse({ ...base, width: 0 }),
    ).toThrow();
    expect(() =>
      SlideAssetSchema.parse({ ...base, height: -1 }),
    ).toThrow();
    expect(() =>
      SlideAssetSchema.parse({ ...base, local_path: "" }),
    ).toThrow();
  });
});

// ── DraftDeckBodySchema — wizard ↔ backend contract ───────────────────────
//
// The Phase-3 backend POST /api/admin/pitch/decks/draft validator is
// `.strict()` and silently 400s on unknown fields. The Phase-4 wizard
// (`ui/app/pitch/new/page.tsx`) builds an `options` object and POSTs it.
// These tests pin the contract: any drift between client field names and
// backend Zod fails CI rather than 400-ing in production.

describe("DraftDeckBodySchema — wizard ↔ backend contract", () => {
  it("accepts the exact payload the wizard produces", () => {
    // Mirror of the body literal in `ui/app/pitch/new/page.tsx`
    // (handleSubmit). Keep this object in lock-step with the wizard.
    const wizardPayload = {
      script: "Pitch script body.",
      brandKitId: "kit-a",
      options: {
        targetSlideCount: 15,
        audience: "CTOs",
        tone: "casual" as const,
      },
    };
    expect(() => DraftDeckBodySchema.parse(wizardPayload)).not.toThrow();
  });

  it("accepts a payload with audience/tone omitted (empty-audience branch)", () => {
    // When the wizard's audience input is empty it sends `undefined`,
    // which JSON.stringify drops — so the wire payload simply lacks
    // those keys.
    const wirePayload = {
      script: "x",
      brandKitId: "kit-a",
      options: { targetSlideCount: 10, tone: "formal" as const },
    };
    expect(() => DraftDeckBodySchema.parse(wirePayload)).not.toThrow();
  });

  it("rejects the legacy `slideCount` field (the regression we just fixed)", () => {
    const stale = {
      script: "x",
      brandKitId: "kit-a",
      options: { slideCount: 15 },
    };
    expect(() => DraftDeckBodySchema.parse(stale)).toThrow();
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      DraftDeckBodySchema.parse({
        script: "x",
        brandKitId: "kit-a",
        rogueField: "boom",
      }),
    ).toThrow();
  });

  it("rejects unknown nested options fields (.strict)", () => {
    expect(() =>
      DraftDeckBodySchema.parse({
        script: "x",
        brandKitId: "kit-a",
        options: { targetSlideCount: 10, rogue: 1 },
      }),
    ).toThrow();
  });

  it("enforces targetSlideCount bounds (1..80, integer)", () => {
    const base = { script: "x", brandKitId: "kit-a" };
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 0 } }),
    ).toThrow();
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 81 } }),
    ).toThrow();
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 1.5 } }),
    ).toThrow();
  });

  it("accepts every value in DeckToneEnum (wizard ↔ backend tone parity)", () => {
    // If you add/remove a tone in `DeckToneEnum`, the wizard radio set
    // in `ui/app/pitch/new/page.tsx` (TONE_OPTIONS) must be updated to
    // match. The wizard test asserts the radio set; this test asserts
    // each canonical value validates through the backend.
    for (const tone of DeckToneEnum.options) {
      expect(() =>
        DraftDeckBodySchema.parse({
          script: "x",
          brandKitId: "kit-a",
          options: { targetSlideCount: 10, tone },
        }),
      ).not.toThrow();
    }
  });

  it('rejects tone:"persuasive" (regression: wizard-only legacy value)', () => {
    // Pre-fix the wizard exposed a "persuasive" option that is not in
    // `DeckToneEnum`. Selecting it produced a silent 400 from the
    // `.strict()` backend validator. This guard prevents the legacy
    // value from creeping back into either side.
    expect(() =>
      DraftDeckBodySchema.parse({
        script: "x",
        brandKitId: "kit-a",
        options: { targetSlideCount: 10, tone: "persuasive" },
      }),
    ).toThrow();
  });
});
//
// The Phase-3 backend POST /api/admin/pitch/decks/draft validator is
// `.strict()` and silently 400s on unknown fields. The Phase-4 wizard
// (`ui/app/pitch/new/page.tsx`) builds an `options` object and POSTs it.
// These tests pin the contract: any drift between client field names and
// backend Zod fails CI rather than 400-ing in production.

describe("DraftDeckBodySchema � wizard ? backend contract", () => {
  it("accepts the exact payload the wizard produces", () => {
    // Mirror of the body literal in `ui/app/pitch/new/page.tsx`
    // (handleSubmit). Keep this object in lock-step with the wizard.
    const wizardPayload = {
      script: "Pitch script body.",
      brandKitId: "kit-a",
      options: {
        targetSlideCount: 15,
        audience: "CTOs",
        tone: "casual" as const,
      },
    };
    expect(() => DraftDeckBodySchema.parse(wizardPayload)).not.toThrow();
  });

  it("accepts a payload with audience/tone omitted (audience='' branch)", () => {
    // The wizard sends `audience: undefined` when the input is empty and
    // omits unset fields entirely. JSON.stringify drops `undefined`, so
    // the wire payload simply lacks those keys.
    const wirePayload = {
      script: "x",
      brandKitId: "kit-a",
      options: { targetSlideCount: 10, tone: "formal" as const },
    };
    expect(() => DraftDeckBodySchema.parse(wirePayload)).not.toThrow();
  });

  it("rejects the legacy `slideCount` field (the regression we just fixed)", () => {
    const stale = {
      script: "x",
      brandKitId: "kit-a",
      options: { slideCount: 15 },
    };
    expect(() => DraftDeckBodySchema.parse(stale)).toThrow();
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      DraftDeckBodySchema.parse({
        script: "x",
        brandKitId: "kit-a",
        rogueField: "boom",
      }),
    ).toThrow();
  });

  it("rejects unknown nested options fields (.strict)", () => {
    expect(() =>
      DraftDeckBodySchema.parse({
        script: "x",
        brandKitId: "kit-a",
        options: { targetSlideCount: 10, rogue: 1 },
      }),
    ).toThrow();
  });

  it("enforces targetSlideCount bounds (1..80, integer)", () => {
    const base = { script: "x", brandKitId: "kit-a" };
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 0 } }),
    ).toThrow();
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 81 } }),
    ).toThrow();
    expect(() =>
      DraftDeckBodySchema.parse({ ...base, options: { targetSlideCount: 1.5 } }),
    ).toThrow();
  });
});

// -- Sub-issue #1051 � branding overrides + LogoPlacementEnum ------------

import { BrandingOverrideSchema, LogoPlacementEnum } from "./pitch-schema.js";

describe("LogoPlacementEnum (#1051)", () => {
  it.each(["top-left", "top-right", "bottom-left", "bottom-right", "none"])(
    "accepts %s",
    (v) => {
      expect(LogoPlacementEnum.parse(v)).toBe(v);
    },
  );

  it("rejects unknown placement values", () => {
    expect(() => LogoPlacementEnum.parse("middle")).toThrow();
  });
});

describe("BrandingOverrideSchema (#1051)", () => {
  it("accepts an empty branding block (all fields optional)", () => {
    expect(BrandingOverrideSchema.parse({})).toEqual({});
  });

  it("round-trips a fully-populated override", () => {
    const parsed = BrandingOverrideSchema.parse({
      logoPlacement: "top-right",
      hideLogo: false,
      footerOverride: "Confidential",
      watermarkOverride: "/brand-kits/wm.png",
    });
    expect(parsed.logoPlacement).toBe("top-right");
    expect(parsed.footerOverride).toBe("Confidential");
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      BrandingOverrideSchema.parse({ unknown: true } as unknown as Record<string, unknown>),
    ).toThrow();
  });

  it("caps footerOverride at 120 chars", () => {
    expect(() =>
      BrandingOverrideSchema.parse({ footerOverride: "x".repeat(121) }),
    ).toThrow();
  });
});

describe("BrandKitSchema � branding defaults (#1051/#1047)", () => {
  it("accepts defaultLogoPlacement and showSlideNumbers", () => {
    const kit = BrandKitSchema.parse({
      ...validBrandKit(),
      defaultLogoPlacement: "bottom-right",
      showSlideNumbers: true,
    });
    expect(kit.defaultLogoPlacement).toBe("bottom-right");
    expect(kit.showSlideNumbers).toBe(true);
  });

  it("treats both new fields as optional (backwards compat)", () => {
    const kit = BrandKitSchema.parse(validBrandKit());
    expect(kit.defaultLogoPlacement).toBeUndefined();
    expect(kit.showSlideNumbers).toBeUndefined();
  });
});

describe("Slide schema backwards compat (#1051)", () => {
  it("parses a slide with no branding block (legacy decks)", () => {
    const slide = SlideSchema.parse(
      validSlide("bullet_list", { heading: "H", bullets: ["a"] }),
    );
    expect((slide as { branding?: unknown }).branding).toBeUndefined();
  });

  it("attaches a branding block to any template", () => {
    const slide = SlideSchema.parse({
      template: "bullet_list",
      content: { heading: "H", bullets: ["a"] },
      branding: { logoPlacement: "top-left", hideLogo: false },
    });
    expect((slide as { branding?: { logoPlacement?: string } }).branding?.logoPlacement).toBe(
      "top-left",
    );
  });
});
