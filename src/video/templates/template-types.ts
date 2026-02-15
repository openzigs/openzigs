/**
 * Director Mode — Video Template Types
 * Issue #236: Types for the template system & shared components.
 */

import type { TemplateId, CompositionConfig } from "../manifest/manifest-types.js";

// ── Shared Component Types ────────────────────────────────────

export interface SmartCaptionWord {
  word: string;
  start: number;  // frame
  end: number;    // frame
}

export interface SmartCaptionsProps {
  words: SmartCaptionWord[];
  style: "pill" | "underline" | "boxed" | "karaoke";
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  position?: "bottom" | "center" | "top";
}

export interface LowerThirdProps {
  name: string;
  title: string;
  accentColor?: string;
  animationDuration?: number;  // frames
}

export interface LogoWatermarkProps {
  logoUrl: string;
  opacity?: number;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  scale?: number;
}

export interface ProgressBarProps {
  color?: string;
  height?: number;
  position?: "top" | "bottom";
}

// ── Template Definition ───────────────────────────────────────

export interface TemplateDefinition {
  /** Unique template identifier */
  id: TemplateId;
  /** Human-readable name */
  name: string;
  /** Brief description of the template style */
  description: string;
  /** Default composition config for this template */
  defaultComposition: CompositionConfig;
  /** Aspect ratio label (e.g., "16:9", "9:16") */
  aspectRatio: string;
  /** Default transition style */
  defaultTransition: "crossfade" | "wipe-left" | "cut" | "dissolve";
  /** Default transition duration in frames */
  defaultTransitionDuration: number;
  /** Whether this template supports captions by default */
  captionsEnabled: boolean;
  /** Default caption style */
  defaultCaptionStyle?: SmartCaptionsProps["style"];
  /** Tags for search/filtering */
  tags: string[];
  /** CSS-compatible background colour for title cards */
  titleCardBackground: string;
  /** Font family hint */
  fontFamily: string;
}

// ── Template Registry ─────────────────────────────────────────

export interface TemplateRegistry {
  get(id: TemplateId): TemplateDefinition | undefined;
  getAll(): TemplateDefinition[];
  getDefault(): TemplateDefinition;
  getByTag(tag: string): TemplateDefinition[];
}
