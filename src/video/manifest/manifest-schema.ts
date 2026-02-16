/**
 * Director Mode — Zod Validation Schema
 * Issue #240: Strict schema validation for the DirectorManifest data contract.
 * Mirrors the TypeScript types in manifest-types.ts — keep them in sync.
 */

import { z } from "zod";

// ── Video Effects ─────────────────────────────────────────────
const SlowZoomEffectSchema = z.object({
  type: z.literal("slowZoom"),
  from: z.number(),
  to: z.number(),
});

const FadeInEffectSchema = z.object({
  type: z.literal("fadeIn"),
  durationFrames: z.number().int().min(1),
});

const FadeOutEffectSchema = z.object({
  type: z.literal("fadeOut"),
  durationFrames: z.number().int().min(1),
});

const BlurEffectSchema = z.object({
  type: z.literal("blur"),
  amount: z.number().min(0),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
});

const GrayscaleEffectSchema = z.object({
  type: z.literal("grayscale"),
});

const SpeedRampEffectSchema = z.object({
  type: z.literal("speedRamp"),
  factor: z.number().positive(),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
});

export const VideoEffectSchema = z.discriminatedUnion("type", [
  SlowZoomEffectSchema,
  FadeInEffectSchema,
  FadeOutEffectSchema,
  BlurEffectSchema,
  GrayscaleEffectSchema,
  SpeedRampEffectSchema,
]);

// ── Timeline Entries ──────────────────────────────────────────
export const VideoClipEntrySchema = z.object({
  type: z.literal("video_clip"),
  source: z.string().min(1),
  startAtFrame: z.number().int().min(0),
  trimStart: z.number().int().min(0),
  duration: z.number().int().min(1),
  volume: z.number().min(0).max(1).optional(),
  effects: z.array(VideoEffectSchema).optional(),
});

export const OverlayEntrySchema = z.object({
  type: z.literal("overlay"),
  component: z.enum(["SmartCaptions", "LowerThird", "LogoWatermark", "ProgressBar"]),
  props: z.record(z.unknown()),
  startAtFrame: z.number().int().min(0),
  duration: z.number().int().min(1).optional(),
});

export const TitleCardEntrySchema = z.object({
  type: z.literal("title_card"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  background: z.string().optional(),
  startAtFrame: z.number().int().min(0),
  duration: z.number().int().min(1),
  animation: z.enum(["fade", "slide-up", "typewriter"]).optional(),
});

export const TransitionEntrySchema = z.object({
  type: z.literal("transition"),
  style: z.enum(["crossfade", "wipe-left", "wipe-right", "dissolve", "cut"]),
  duration: z.number().int().min(1),
  startAtFrame: z.number().int().min(0),
});

export const TimelineEntrySchema = z.discriminatedUnion("type", [
  VideoClipEntrySchema,
  OverlayEntrySchema,
  TitleCardEntrySchema,
  TransitionEntrySchema,
]);

// ── Audio ─────────────────────────────────────────────────────
export const MusicConfigSchema = z.object({
  track: z.string().min(1),
  volume: z.number().min(0).max(1),
  ducking: z.boolean(),
  fadeInFrames: z.number().int().min(0).optional(),
  fadeOutFrames: z.number().int().min(0).optional(),
  loop: z.boolean().optional(),
});

export const VoiceoverConfigSchema = z.object({
  source: z.string().min(1),
  volume: z.number().min(0).max(1).optional(),
  startAtFrame: z.number().int().min(0).optional(),
});

export const AudioLayerConfigSchema = z.object({
  music: MusicConfigSchema.nullable().optional(),
  voiceover: VoiceoverConfigSchema.nullable().optional(),
});

// ── Composition ───────────────────────────────────────────────
export const CompositionConfigSchema = z.object({
  width: z.number().int().min(360).max(7680),
  height: z.number().int().min(360).max(4320),
  fps: z.number().int().min(15).max(120),
});

// ── Branding ──────────────────────────────────────────────────
export const BrandingConfigSchema = z.object({
  logoUrl: z.string().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontFamily: z.string().optional(),
  watermarkOpacity: z.number().min(0).max(1).optional(),
  watermarkPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
});

// ── Metadata ──────────────────────────────────────────────────
export const ManifestMetadataSchema = z.object({
  generatedAt: z.string().datetime(),
  llmModel: z.string().min(1),
  llmTokensUsed: z.number().int().min(0),
  productionMode: z.enum(["highlight", "script", "presentation"]),
  sourceClips: z.array(z.string()),
  estimatedRenderTime: z.number().positive().optional(),
});

// ── Template ID enum ──────────────────────────────────────────
export const TemplateIdSchema = z.enum(["Minimalist", "ContentCreator", "Corporate", "TechDemo"]);

// ── Top-Level Manifest ────────────────────────────────────────
export const DirectorManifestSchema = z.object({
  projectTitle: z.string().min(1).max(200),
  templateId: TemplateIdSchema,
  composition: CompositionConfigSchema,
  audioLayer: AudioLayerConfigSchema,
  timeline: z.array(TimelineEntrySchema).min(1),
  branding: BrandingConfigSchema.optional(),
  metadata: ManifestMetadataSchema,
});

export type DirectorManifestParsed = z.infer<typeof DirectorManifestSchema>;
