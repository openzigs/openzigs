/**
 * Director Mode — Remotion Render Engine: Input Props Schema
 * Issue #244: Zod-validated input props passed to Remotion compositions at render time.
 *
 * These props are the bridge between the DirectorManifest (backend data contract)
 * and the Remotion React compositions. The manifest adapter (#245) transforms
 * a DirectorManifest into these props.
 */

import { z } from "zod";

// ── Text Overlay Props ────────────────────────────────────────
export const TextOverlayPropsSchema = z.object({
  id: z.string(),
  text: z.string(),
  position: z.enum(["center", "bottom-third", "top-third", "custom"]),
  customPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  fontSize: z.number().default(48),
  fontWeight: z.enum(["normal", "bold", "light"]).default("bold"),
  color: z.string().default("#ffffff"),
  backgroundColor: z.string().default("rgba(0,0,0,0.6)"),
  borderRadius: z.number().default(8),
  padding: z.number().default(16),
  animation: z.enum(["fade-in", "slide-up", "typewriter", "none"]).default("fade-in"),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
});
export type TextOverlayProps = z.infer<typeof TextOverlayPropsSchema>;

// ── Video Clip Props ──────────────────────────────────────────
export const VideoClipPropsSchema = z.object({
  src: z.string().describe("Absolute path or URL to the source video file"),
  startAtFrame: z.number().int().min(0),
  trimStartFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  volume: z.number().min(0).max(1).default(1),
  effects: z.array(z.object({
    type: z.enum(["slowZoom", "fadeIn", "fadeOut", "blur", "grayscale", "speedRamp"]),
    params: z.record(z.unknown()).optional(),
  })).default([]),
  textOverlays: z.array(TextOverlayPropsSchema).default([]),
  horizontalCropOffset: z.number().min(0).max(100).default(50),
});
export type VideoClipProps = z.infer<typeof VideoClipPropsSchema>;

// ── Title Card Props ──────────────────────────────────────────
export const TitleCardPropsSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  background: z.string().default("#1a1a1a"),
  startAtFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  animation: z.enum(["fade", "slide-up", "typewriter"]).default("fade"),
});
export type TitleCardProps = z.infer<typeof TitleCardPropsSchema>;

// ── Overlay Props ─────────────────────────────────────────────
export const OverlayPropsSchema = z.object({
  component: z.enum(["SmartCaptions", "LowerThird", "LogoWatermark", "ProgressBar", "ImageOverlay"]),
  props: z.record(z.unknown()),
  startAtFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1).optional(),
});
export type OverlayProps = z.infer<typeof OverlayPropsSchema>;

// ── Transition Props ──────────────────────────────────────────
export const TransitionPropsSchema = z.object({
  style: z.enum(["crossfade", "wipe-left", "wipe-right", "dissolve", "cut"]),
  durationInFrames: z.number().int().min(0),
  startAtFrame: z.number().int().min(0),
});
export type TransitionProps = z.infer<typeof TransitionPropsSchema>;

// ── Image Scene Props ─────────────────────────────────────────
export const ImageScenePropsSchema = z.object({
  /** Path to the generated image */
  src: z.string(),
  startAtFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  /** Per-scene voiceover audio path */
  voiceover: z.string().optional(),
  /** Volume for per-scene voiceover (default: 1.0) */
  voiceoverVolume: z.number().min(0).max(1).default(1),
  /** Ken Burns animation parameters */
  kenBurns: z.object({
    scaleFrom: z.number().default(1.0),
    scaleTo: z.number().default(1.15),
    translateXFrom: z.number().default(0),
    translateXTo: z.number().default(-10),
    translateYFrom: z.number().default(0),
    translateYTo: z.number().default(-5),
  }).default({}),
  textOverlays: z.array(TextOverlayPropsSchema).default([]),
});
export type ImageSceneProps = z.infer<typeof ImageScenePropsSchema>;

// ── Intro Card Props ──────────────────────────────────────────
export const IntroCardPropsSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  backgroundSrc: z.string().optional(),
  logoSrc: z.string().optional(),
  startAtFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  animation: z.enum(["fade-in", "slide-up", "scale-in", "typewriter"]).default("fade-in"),
});
export type IntroCardProps = z.infer<typeof IntroCardPropsSchema>;

// ── Outro Card Props ──────────────────────────────────────────
export const OutroCardPropsSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  backgroundSrc: z.string().optional(),
  logoSrc: z.string().optional(),
  ctaText: z.string().optional(),
  startAtFrame: z.number().int().min(0),
  durationInFrames: z.number().int().min(1),
  animation: z.enum(["fade-out", "slide-down", "scale-out"]).default("fade-out"),
});
export type OutroCardProps = z.infer<typeof OutroCardPropsSchema>;

// ── Audio Props ───────────────────────────────────────────────
export const AudioPropsSchema = z.object({
  music: z.object({
    src: z.string(),
    volume: z.number().min(0).max(1).default(1),
    loop: z.boolean().default(true),
    fadeInFrames: z.number().int().min(0).default(0),
    fadeOutFrames: z.number().int().min(0).default(0),
    ducking: z.boolean().default(false),
  }).nullable().default(null),
  voiceover: z.object({
    src: z.string(),
    volume: z.number().min(0).max(1).default(1),
    startAtFrame: z.number().int().min(0).default(0),
  }).nullable().default(null),
});
export type AudioProps = z.infer<typeof AudioPropsSchema>;

// ── Branding Props ────────────────────────────────────────────
export const BrandingPropsSchema = z.object({
  logoUrl: z.string().optional(),
  accentColor: z.string().default("#3b82f6"),
  fontFamily: z.string().default("Inter, system-ui, sans-serif"),
  watermarkOpacity: z.number().min(0).max(1).default(0.3),
  watermarkPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
});
export type BrandingProps = z.infer<typeof BrandingPropsSchema>;

// ── Timeline Item (unified union) ─────────────────────────────
export const TimelineItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("video_clip"), ...VideoClipPropsSchema.shape }),
  z.object({ type: z.literal("title_card"), ...TitleCardPropsSchema.shape }),
  z.object({ type: z.literal("overlay"), ...OverlayPropsSchema.shape }),
  z.object({ type: z.literal("transition"), ...TransitionPropsSchema.shape }),
  z.object({ type: z.literal("image_scene"), ...ImageScenePropsSchema.shape }),
  z.object({ type: z.literal("intro_card"), ...IntroCardPropsSchema.shape }),
  z.object({ type: z.literal("outro_card"), ...OutroCardPropsSchema.shape }),
]);
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// ── Top-Level Composition Input Props ─────────────────────────
export const CompositionInputPropsSchema = z.object({
  templateId: z.enum(["Minimalist", "ContentCreator", "Corporate", "TechDemo"]),
  projectTitle: z.string(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  durationInFrames: z.number().int().min(1),
  timeline: z.array(TimelineItemSchema),
  audio: AudioPropsSchema,
  branding: BrandingPropsSchema,
});
export type CompositionInputProps = z.infer<typeof CompositionInputPropsSchema>;
