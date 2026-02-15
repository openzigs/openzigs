/**
 * Director Mode — Template Definitions
 * Issue #236: Four built-in templates for different content types.
 */

import type { TemplateDefinition } from "./template-types.js";

/**
 * Minimalist — Clean 16:9, crossfade transitions, distraction-free.
 * Best for: conference talks, tutorials, screencasts.
 */
export const MinimalistTemplate: TemplateDefinition = {
  id: "Minimalist",
  name: "Minimalist",
  description: "Clean 16:9 layout with crossfade transitions. Focus on content, not effects.",
  defaultComposition: { width: 1920, height: 1080, fps: 30 },
  aspectRatio: "16:9",
  defaultTransition: "crossfade",
  defaultTransitionDuration: 20,
  captionsEnabled: true,
  defaultCaptionStyle: "underline",
  tags: ["clean", "professional", "tutorial", "conference"],
  titleCardBackground: "#1a1a1a",
  fontFamily: "Inter, system-ui, sans-serif",
};

/**
 * ContentCreator — Vertical 9:16 with rapid cuts for social media.
 * Best for: TikTok, Instagram Reels, YouTube Shorts.
 */
export const ContentCreatorTemplate: TemplateDefinition = {
  id: "ContentCreator",
  name: "Content Creator",
  description: "Vertical 9:16 with rapid cuts, bold captions, and high energy pacing.",
  defaultComposition: { width: 1080, height: 1920, fps: 30 },
  aspectRatio: "9:16",
  defaultTransition: "cut",
  defaultTransitionDuration: 0,
  captionsEnabled: true,
  defaultCaptionStyle: "karaoke",
  tags: ["social", "vertical", "tiktok", "reels", "shorts", "high-energy"],
  titleCardBackground: "#000000",
  fontFamily: "Montserrat, system-ui, sans-serif",
};

/**
 * Corporate — Professional 16:9 with lower thirds, logo watermark, polished titles.
 * Best for: quarterly updates, investor pitches, product demos.
 */
export const CorporateTemplate: TemplateDefinition = {
  id: "Corporate",
  name: "Corporate",
  description: "Professional 16:9 with lower thirds, logo watermark, and polished title cards.",
  defaultComposition: { width: 1920, height: 1080, fps: 30 },
  aspectRatio: "16:9",
  defaultTransition: "dissolve",
  defaultTransitionDuration: 25,
  captionsEnabled: true,
  defaultCaptionStyle: "boxed",
  tags: ["corporate", "professional", "business", "enterprise", "presentation"],
  titleCardBackground: "#1a1a2e",
  fontFamily: "Roboto, system-ui, sans-serif",
};

/**
 * TechDemo — Split-screen with code + video side by side.
 * Best for: developer tutorials, code walkthroughs, technical demos.
 */
export const TechDemoTemplate: TemplateDefinition = {
  id: "TechDemo",
  name: "Tech Demo",
  description: "Split-screen layout with code panel + video, ideal for technical demonstrations.",
  defaultComposition: { width: 1920, height: 1080, fps: 30 },
  aspectRatio: "16:9",
  defaultTransition: "wipe-left",
  defaultTransitionDuration: 15,
  captionsEnabled: true,
  defaultCaptionStyle: "pill",
  tags: ["tech", "developer", "code", "demo", "tutorial", "split-screen"],
  titleCardBackground: "#0d1117",
  fontFamily: "JetBrains Mono, Fira Code, monospace",
};
