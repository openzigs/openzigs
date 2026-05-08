/**
 * Pitch — Zod schemas for AI-generated presentation decks.
 *
 * Single source of truth for deck/slide/brand-kit/asset shapes. Every other
 * Pitch module (`PitchRepository`, `pitch-generator`, REST handlers, exporters)
 * validates I/O through these schemas. See:
 *   docs/research/2026-04-24-studio-pitch-feature.md §7
 *   GitHub Epic #951 / sub-issue #952
 *
 * Discriminated union over 14 slide templates: title, section_divider,
 * bullet_list, two_column, image_caption, quote, stats_kpi, comparison_table,
 * timeline, full_bleed, code, qa, chart, mermaid.
 */
import { z } from "zod";
import { ImageStyleEnum } from "./image-style-prompts.js";

export { ImageStyleEnum } from "./image-style-prompts.js";
export type { ImageStyle } from "./image-style-prompts.js";

/** Hex color: `#rrggbb`. */
export const HexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "must be #rrggbb hex color");

/**
 * Brand Kit (extended for Pitch — adds heading/body fonts + footer text).
 *
 * SECURITY (Phase 7 / sub-issue #977): the URL-typed fields below
 * (`logoUrl`, `watermarkUrl`) are populated server-side from
 * `kit.logoPath` / `kit.watermarkPath` in `src/api/pitch.ts` — they are
 * NEVER set from a remote URL submitted by a client. If a future endpoint
 * accepts a URL string for either field (or if a new URL-typed field is
 * added below), the value MUST be validated through
 * `isAllowedWebhookUrl` from `src/security/url-validation.ts` to prevent
 * SSRF against internal-network metadata services.
 *
 * The `pitch-schema.test.ts` enumerates the URL fields the schema is
 * allowed to carry — adding a new `z.string().url()` field will fail
 * that test until the SSRF guard is wired in.
 */
/**
 * Logo placement enum (Epic #1045 / sub-issue #1051 + #1047).
 *
 * Used both at the brand-kit level (`defaultLogoPlacement`) and per-slide
 * (`branding.logoPlacement`). `none` hides the logo on the affected
 * surface; the per-slide field also accepts `inherit` (the default) which
 * means "fall back to the kit-level default".
 */
export const LogoPlacementEnum = z.enum([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "none",
]);
export type LogoPlacement = z.infer<typeof LogoPlacementEnum>;

export const BrandKitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  primaryColor: HexColor,
  secondaryColor: HexColor,
  accentColor: HexColor,
  fontHeading: z.string().min(1).max(60),
  fontBody: z.string().min(1).max(60),
  logoUrl: z.string().url().nullable(),
  watermarkUrl: z.string().url().nullable(),
  footerText: z.string().max(120).nullable(),
  /**
   * Default corner the logo renders in unless a slide overrides it
   * (sub-issue #1047). When omitted, the renderer falls back to
   * `bottom-right`.
   */
  defaultLogoPlacement: LogoPlacementEnum.optional(),
  /**
   * When `true`, slides render a small "n / total" indicator in the
   * corner opposite the resolved logo (sub-issue #1047). Defaults to
   * `false` for backwards compatibility.
   */
  showSlideNumbers: z.boolean().optional(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/**
 * Per-slide branding override block (sub-issue #1051).
 *
 * Every field is optional; an empty / missing block means the slide
 * inherits the brand-kit defaults entirely. Strings are sanitized at
 * render time via `sanitizeRichText`.
 */
export const BrandingOverrideSchema = z
  .object({
    logoPlacement: LogoPlacementEnum.optional(),
    /** When true, force-hide the logo on this slide regardless of placement. */
    hideLogo: z.boolean().optional(),
    /** Per-slide footer text override (≤120 chars). */
    footerOverride: z.string().max(120).optional(),
    /**
     * Per-slide watermark image URL override. Must reuse the existing
     * upload pipeline (root-relative path or `http(s)://`); `safeUrl`
     * blocks anything else at render time.
     */
    watermarkOverride: z.string().max(500).optional(),
  })
  .strict();
export type BrandingOverride = z.infer<typeof BrandingOverrideSchema>;

/** Per-block fragment animation. */
export const FragmentEnum = z.enum([
  "fade-in",
  "fade-up",
  "highlight",
  "grow",
  "none",
]);
export type Fragment = z.infer<typeof FragmentEnum>;

/** Slide-to-slide transition. */
export const TransitionEnum = z.enum([
  "slide",
  "fade",
  "convex",
  "concave",
  "zoom",
  "none",
]);
export type Transition = z.infer<typeof TransitionEnum>;

/**
 * Common shape extended by every slide-template variant.
 *
 * NOTE: must remain a `z.object(...)` (not `.merge`-ed via passthrough) so each
 * template variant can `.extend()` it cleanly inside the discriminated union.
 */
const Common = z.object({
  speaker_notes: z.string().max(2000).default(""),
  transition: TransitionEnum.default("slide"),
  fragments: z.array(FragmentEnum).default([]),
  background_image_prompt: z.string().max(400).optional(),
  source_anchor: z.string().max(200).optional(),
  /**
   * Optional character offset range into the deck's source script that
   * produced this slide. Enables bidirectional script ↔ slide highlight
   * in the editor (sub-issue #969). Snake-case to match the rest of the
   * pitch schema. Older slides without this field continue to validate.
   */
  source_range: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
  /**
   * Optional per-slide image-style preset override (sub-issue #998).
   * Beats the deck-level `metadata.image_style` when set. Snake-case to
   * match the rest of the slide schema; the wizard/UI maps it from the
   * camelCase `imageStyle` deck option.
   */
  image_style: ImageStyleEnum.optional(),
  /**
   * Per-slide branding overrides (Epic #1045 / sub-issue #1051). When
   * omitted (the default), the slide inherits the deck's brand kit
   * settings entirely. Field names are camelCase so the UI editor can
   * round-trip them without translation; the surrounding slide schema
   * stays snake_case for backwards compat with existing decks.
   */
  branding: BrandingOverrideSchema.optional(),
});

/** Inline image — always carries a generation prompt; `url` is filled later. */
const SlideImageUrl = z.union([
  z.string().url(),
  z.string().regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@/%-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*)?$/),
]);

export const SlideImageSchema = z.object({
  prompt: z.string().min(3).max(400),
  url: SlideImageUrl.nullable(),
  alt: z.string().max(200),
});
export type SlideImage = z.infer<typeof SlideImageSchema>;

// ── Slide template variants ──────────────────────────────────────────

/** 1. Title slide — opening of the deck. */
export const TitleSlideSchema = Common.extend({
  template: z.literal("title"),
  content: z.object({
    title: z.string().min(1).max(120),
    // LLMs commonly emit `null` (not omission) for optional string fields
    // they choose not to populate. Accept both `null` and absent so that
    // valid pitches don't get rejected at the schema boundary.
    subtitle: z.string().max(200).nullable().optional(),
    eyebrow: z.string().max(60).nullable().optional(),
  }),
});

/** 2. Section divider — denotes a new chapter. */
export const SectionDividerSlideSchema = Common.extend({
  template: z.literal("section_divider"),
  content: z.object({
    section_number: z.number().int().min(1).max(99),
    title: z.string().min(1).max(120),
  }),
});

/** 3. Bullet list — heading + 1..7 short bullets. */
export const BulletListSlideSchema = Common.extend({
  template: z.literal("bullet_list"),
  content: z.object({
    heading: z.string().min(1).max(120),
    bullets: z.array(z.string().min(1).max(160)).min(1).max(7),
    image: SlideImageSchema.optional(),
  }),
});

/** 4. Two-column layout. */
export const TwoColumnSlideSchema = Common.extend({
  template: z.literal("two_column"),
  content: z.object({
    heading: z.string().min(1).max(120),
    left: z.string().max(800),
    right: z.string().max(800),
    left_image: SlideImageSchema.optional(),
    right_image: SlideImageSchema.optional(),
  }),
});

/** 5. Image with caption. */
export const ImageCaptionSlideSchema = Common.extend({
  template: z.literal("image_caption"),
  content: z.object({
    image: SlideImageSchema,
    caption: z.string().max(280),
    heading: z.string().max(120).optional(),
  }),
});

/** 6. Quote / testimonial. */
export const QuoteSlideSchema = Common.extend({
  template: z.literal("quote"),
  content: z.object({
    quote: z.string().min(1).max(500),
    attribution: z.string().min(1).max(120),
    source: z.string().max(120).optional(),
  }),
});

/** 7. KPI / stats grid (2..6 KPIs). */
export const StatsKpiSlideSchema = Common.extend({
  template: z.literal("stats_kpi"),
  content: z.object({
    heading: z.string().min(1).max(120),
    kpis: z
      .array(
        z.object({
          value: z.string().min(1).max(20),
          label: z.string().min(1).max(60),
          // LLMs frequently return `null` for absent deltas instead of
          // omitting the key. Accept both `null` and missing.
          delta: z.string().max(20).nullable().optional(),
        }),
      )
      .min(2)
      .max(6),
  }),
});

/** 8. Comparison table. */
export const ComparisonTableSlideSchema = Common.extend({
  template: z.literal("comparison_table"),
  content: z.object({
    heading: z.string().min(1).max(120),
    columns: z.array(z.string().min(1).max(40)).min(2).max(5),
    rows: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          cells: z.array(z.string().max(120)),
        }),
      )
      .min(1)
      .max(8),
  }),
});

/** 9. Timeline (2..8 events). */
export const TimelineSlideSchema = Common.extend({
  template: z.literal("timeline"),
  content: z.object({
    heading: z.string().min(1).max(120),
    events: z
      .array(
        z.object({
          when: z.string().min(1).max(40),
          what: z.string().min(1).max(160),
        }),
      )
      .min(2)
      .max(8),
  }),
});

/** 10. Full-bleed image with optional overlay text. */
export const FullBleedSlideSchema = Common.extend({
  template: z.literal("full_bleed"),
  content: z.object({
    image: SlideImageSchema,
    overlay_text: z.string().max(200).optional(),
  }),
});

/** 11. Code block (syntax-highlighted). */
export const CodeSlideSchema = Common.extend({
  template: z.literal("code"),
  content: z.object({
    heading: z.string().max(120).optional(),
    language: z.string().min(1).max(20),
    code: z.string().min(1).max(4000),
    highlight_lines: z.array(z.number().int().positive()).optional(),
  }),
});

/** 12. Q&A — closing slide. */
export const QaSlideSchema = Common.extend({
  template: z.literal("qa"),
  content: z.object({
    heading: z.string().max(120).default("Questions?"),
    contact: z.string().max(160).optional(),
  }),
});

/** 13. Chart (Recharts in HTML, native PPTX chart on export). */
export const ChartSlideSchema = Common.extend({
  template: z.literal("chart"),
  content: z.object({
    heading: z.string().min(1).max(120),
    chart_type: z.enum(["bar", "line", "pie", "area"]),
    series: z
      .array(
        z.object({
          name: z.string().min(1).max(40),
          data: z
            .array(
              z.object({
                x: z.string().min(1).max(40),
                y: z.number(),
              }),
            )
            .min(1)
            .max(50),
        }),
      )
      .min(1)
      .max(5),
  }),
});

/** 14. Mermaid diagram. */
export const MermaidSlideSchema = Common.extend({
  template: z.literal("mermaid"),
  content: z.object({
    heading: z.string().max(120).optional(),
    diagram_type: z.enum([
      "flowchart",
      "sequence",
      "gantt",
      "class",
      "state",
      "er",
      "pie",
      "timeline",
    ]),
    source: z.string().min(1).max(4000),
  }),
});

// ── Sub-issue #1046 — Pricing Table + Big Number ─────────────────────

/** 15. Pricing table — 2..4 tiers, at most one highlighted. */
export const PricingTableSlideSchema = Common.extend({
  template: z.literal("pricing_table"),
  content: z
    .object({
      heading: z.string().min(1).max(120),
      tiers: z
        .array(
          z.object({
            name: z.string().min(1).max(40),
            price: z.string().min(1).max(40),
            // Optional period qualifier: "/mo", "/seat/yr", etc.
            period: z.string().max(20).optional(),
            // 1..10 short bullet features.
            features: z.array(z.string().min(1).max(120)).min(1).max(10),
            cta: z.string().max(40).optional(),
            highlighted: z.boolean().optional(),
          }),
        )
        .min(2)
        .max(4),
      footnote: z.string().max(160).optional(),
    })
    .superRefine((c, ctx) => {
      const highlighted = c.tiers.filter((t) => t.highlighted).length;
      if (highlighted > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tiers"],
          message: "Only one tier may be highlighted",
        });
      }
    }),
});

/** 16. Big Number — single hero metric with optional support text + trend. */
export const BigNumberSlideSchema = Common.extend({
  template: z.literal("big_number"),
  content: z.object({
    value: z.string().min(1).max(20),
    label: z.string().min(1).max(80),
    support: z.string().max(240).optional(),
    trend: z.enum(["up", "down", "flat"]).optional(),
    trend_label: z.string().max(40).optional(),
  }),
});

// ── Sub-issue #1049 — Team Grid + Logo Grid ──────────────────────────

/** 17. Team Grid — 2..12 member cards. */
export const TeamGridSlideSchema = Common.extend({
  template: z.literal("team_grid"),
  content: z.object({
    heading: z.string().max(120).optional(),
    members: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          role: z.string().min(1).max(80),
          bio: z.string().max(280).optional(),
          // photoUrl must be either a relative `/uploads/...` path or
          // an https URL pointing at the local API origin. Validated
          // server-side at write time too.
          photoUrl: z.string().max(500).optional(),
          links: z
            .array(
              z.object({
                label: z.string().min(1).max(40),
                href: z.string().min(1).max(500),
              }),
            )
            .max(4)
            .optional(),
        }),
      )
      .min(2)
      .max(12),
  }),
});

/** 18. Logo Grid — 4..24 partner/customer logos. */
export const LogoGridSlideSchema = Common.extend({
  template: z.literal("logo_grid"),
  content: z.object({
    heading: z.string().max(120).optional(),
    caption: z.string().max(120).optional(),
    grayscale: z.boolean().optional(),
    logos: z
      .array(
        z.object({
          alt: z.string().min(1).max(80),
          imageUrl: z.string().min(1).max(500),
          href: z.string().max(500).optional(),
        }),
      )
      .min(4)
      .max(24),
  }),
});

// ── Sub-issue #1052 — Roadmap + Agenda ───────────────────────────────

const RoadmapStatusEnum = z.enum(["planned", "in_progress", "done"]);
export type RoadmapStatus = z.infer<typeof RoadmapStatusEnum>;

/** 19. Roadmap — 2..6 columns × 1..4 tracks of timeline items. */
export const RoadmapSlideSchema = Common.extend({
  template: z.literal("roadmap"),
  content: z.object({
    heading: z.string().min(1).max(120),
    columns: z.array(z.string().min(1).max(40)).min(2).max(6),
    tracks: z.array(z.string().min(1).max(40)).min(1).max(4),
    items: z
      .array(
        z.object({
          // Index into `columns` (0-based).
          column: z.number().int().min(0).max(5),
          // Index into `tracks` (0-based).
          track: z.number().int().min(0).max(3),
          label: z.string().min(1).max(80),
          status: RoadmapStatusEnum.optional(),
        }),
      )
      .max(60),
  }),
});

/** 20. Agenda — auto (derived from section dividers) or manual. */
export const AgendaSlideSchema = Common.extend({
  template: z.literal("agenda"),
  content: z
    .object({
      heading: z.string().max(120).optional(),
      mode: z.enum(["auto", "manual"]).default("auto"),
      // 1..20 manually-supplied items; required only when mode==="manual".
      items: z.array(z.string().min(1).max(120)).max(20).optional(),
      numbered: z.boolean().optional(),
    })
    .superRefine((c, ctx) => {
      if (c.mode === "manual") {
        if (!c.items || c.items.length < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["items"],
            message: "Manual agenda must have at least one item",
          });
        }
      }
    }),
});

/** Discriminated union over all 20 slide templates. */
export const SlideSchema = z.discriminatedUnion("template", [
  TitleSlideSchema,
  SectionDividerSlideSchema,
  BulletListSlideSchema,
  TwoColumnSlideSchema,
  ImageCaptionSlideSchema,
  QuoteSlideSchema,
  StatsKpiSlideSchema,
  ComparisonTableSlideSchema,
  TimelineSlideSchema,
  FullBleedSlideSchema,
  CodeSlideSchema,
  QaSlideSchema,
  ChartSlideSchema,
  MermaidSlideSchema,
  PricingTableSlideSchema,
  BigNumberSlideSchema,
  TeamGridSlideSchema,
  LogoGridSlideSchema,
  RoadmapSlideSchema,
  AgendaSlideSchema,
]);
export type Slide = z.infer<typeof SlideSchema>;

/** Tone of the deck — drives prompt/style choices in the generator. */
export const DeckToneEnum = z.enum([
  "formal",
  "casual",
  "technical",
  "sales",
  "educational",
]);
export type DeckTone = z.infer<typeof DeckToneEnum>;

/** Aspect ratio. */
export const DeckAspectRatioEnum = z.enum(["16:9", "4:3"]);
export type DeckAspectRatio = z.infer<typeof DeckAspectRatioEnum>;

/** Deck — 1..80 slides (hard cap from research §2). */
export const DeckSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  brand_kit_id: z.string().min(1),
  aspect_ratio: DeckAspectRatioEnum.default("16:9"),
  slides: z.array(SlideSchema).min(1).max(80),
  metadata: z.object({
    source_script: z.string().max(50_000),
    source_summary: z.string().max(2000).optional(),
    audience: z.string().max(120).optional(),
    tone: DeckToneEnum.default("formal"),
    estimated_minutes: z.number().int().min(1).max(180).optional(),
    /**
     * Deck-wide image-style preset (sub-issue #998). When set, every
     * image enqueue in this deck inherits the matching prompt prefix
     * unless a slide carries its own `image_style` override.
     */
    image_style: ImageStyleEnum.optional(),
    /**
     * Deck-level FluxQ model selection. `flux-schnell` is the 4-step
     * distilled model (fast, lower fidelity); `flux-dev` is the higher
     * quality dev model. Defaults to `flux-schnell` (omitted) for
     * backwards compatibility with existing decks.
     */
    image_model: z.enum(["flux-schnell", "flux-dev"]).optional(),
    /**
     * When `false`, the deck's auto-fan-out + bulk generate-all paths
     * skip deriving a fallback background prompt for slides that have
     * no explicit `background_image_prompt`. Defaults to `true`
     * (omitted) so existing decks keep generating backgrounds.
     */
    auto_generate_backgrounds: z.boolean().optional(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Deck = z.infer<typeof DeckSchema>;

/** Slide asset (image / background / logo / watermark) tracked on disk. */
export const SlideAssetSchema = z.object({
  id: z.string().min(1),
  deck_id: z.string().min(1),
  slide_id: z.string().min(1).nullable(),
  kind: z.enum(["image", "background", "logo", "watermark"]),
  source: z.enum(["fluxq", "upload", "url"]),
  prompt: z.string().nullable(),
  local_path: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  created_at: z.string(),
});
export type SlideAsset = z.infer<typeof SlideAssetSchema>;

/** All slide-template literal values, in declaration order. */
export const SLIDE_TEMPLATES = [
  "title",
  "section_divider",
  "bullet_list",
  "two_column",
  "image_caption",
  "quote",
  "stats_kpi",
  "comparison_table",
  "timeline",
  "full_bleed",
  "code",
  "qa",
  "chart",
  "mermaid",
  // Sub-issue #1046
  "pricing_table",
  "big_number",
  // Sub-issue #1049
  "team_grid",
  "logo_grid",
  // Sub-issue #1052
  "roadmap",
  "agenda",
] as const;
export type SlideTemplate = (typeof SLIDE_TEMPLATES)[number];

// ── REST contract — POST /api/admin/pitch/decks/draft ────────────────
//
// Single source of truth for the draft-deck request body. Imported by the
// Phase-3 router (`src/api/pitch.ts`) AND by the Phase-4 wizard contract
// test so any drift between the wizard payload and the backend Zod
// validator fails CI rather than silently 400-ing in production.

export const DraftDeckOptionsSchema = z
  .object({
    audience: z.string().max(120).optional(),
    tone: DeckToneEnum.optional(),
    estimatedMinutes: z.number().int().min(1).max(180).optional(),
    targetSlideCount: z.number().int().min(1).max(80).optional(),
    /** Optional LLM model override forwarded to the Copilot wrapper.
     *  When omitted, the wrapper's selected default is used. */
    model: z.string().min(1).max(100).optional(),
    /**
     * When true (default), the `/decks/draft` handler fans out one flux
     * image-generation job per image-bearing slide immediately after the
     * deck is persisted (sub-issue #995). Set to `false` for tests or
     * when the caller wants the historical behaviour where the user must
     * trigger generation manually.
     */
    autoGenerateImages: z.boolean().default(true),
    /**
     * Deck-wide image-style preset (sub-issue #998). Forwarded into the
     * persisted `metadata.image_style` and applied as a prompt prefix on
     * every queued FluxQ job.
     */
    imageStyle: ImageStyleEnum.optional(),
    /**
     * Deck-level FluxQ model. `flux-schnell` (default) is the 4-step
     * distilled model — fast, lower fidelity. `flux-dev` is higher
     * quality at the cost of generation time. Persisted on
     * `metadata.image_model`.
     */
    imageModel: z.enum(["flux-schnell", "flux-dev"]).optional(),
    /**
     * When `false`, the auto-fan-out skips deriving a fallback
     * background prompt for slides without an explicit
     * `background_image_prompt`. Defaults to `true` for back-compat.
     */
    autoGenerateBackgrounds: z.boolean().optional(),
  })
  .strict();
export type DraftDeckOptions = z.infer<typeof DraftDeckOptionsSchema>;

export const DraftDeckBodySchema = z
  .object({
    script: z.string().min(1).max(50_000),
    brandKitId: z.string().min(1),
    title: z.string().min(1).max(160).optional(),
    options: DraftDeckOptionsSchema.optional(),
  })
  .strict();
export type DraftDeckBody = z.infer<typeof DraftDeckBodySchema>;
