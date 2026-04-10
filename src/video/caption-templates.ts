/**
 * Caption Templates — Remotion-compatible animation template definitions.
 * Issue #819: Enhanced Animated Captions System.
 */

export type CaptionAnimation =
  | "pop"
  | "glow"
  | "bounce"
  | "underline"
  | "fade"
  | "none";

export type CaptionPosition = "top" | "center" | "bottom" | "lower-third";

export interface CaptionTemplateConfig {
  id: string;
  name: string;
  description: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  textColor: string;
  highlightColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  position: CaptionPosition;
  animation: CaptionAnimation;
  maxWordsPerLine: number;
  wordSpacing: number;
  lineSpacing: number;
  strokeColor: string;
  strokeWidth: number;
  padding: { top: number; bottom: number; left: number; right: number };
  /** Animation timing in frames at 30fps */
  animationDuration: number;
  /** Whether to use brand kit overrides when available */
  supportsBrandKit: boolean;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  isHighlighted?: boolean;
  emoji?: string;
  customColor?: string;
  customSize?: number;
}

export interface CaptionLine {
  words: CaptionWord[];
  start: number;
  end: number;
}

export const CAPTION_TEMPLATES: CaptionTemplateConfig[] = [
  {
    id: "hormozi",
    name: "Hormozi",
    description:
      "Bold white text with keyword yellow highlights. Word pop with scale bounce.",
    fontFamily: "Impact, Arial Black, sans-serif",
    fontSize: 72,
    fontWeight: 900,
    textColor: "#FFFFFF",
    highlightColor: "#FFD700",
    backgroundColor: "#000000",
    backgroundOpacity: 0,
    position: "center",
    animation: "pop",
    maxWordsPerLine: 4,
    wordSpacing: 8,
    lineSpacing: 12,
    strokeColor: "#000000",
    strokeWidth: 4,
    padding: { top: 0, bottom: 0, left: 20, right: 20 },
    animationDuration: 6,
    supportsBrandKit: false,
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Clean sans-serif with subtle colors. Soft fade-in per word.",
    fontFamily: "Inter, Helvetica, Arial, sans-serif",
    fontSize: 48,
    fontWeight: 500,
    textColor: "#F5F5F5",
    highlightColor: "#A0C4FF",
    backgroundColor: "#000000",
    backgroundOpacity: 0.3,
    position: "bottom",
    animation: "fade",
    maxWordsPerLine: 6,
    wordSpacing: 6,
    lineSpacing: 8,
    strokeColor: "#000000",
    strokeWidth: 1,
    padding: { top: 8, bottom: 8, left: 16, right: 16 },
    animationDuration: 8,
    supportsBrandKit: true,
  },
  {
    id: "tiktok",
    name: "TikTok Trending",
    description: "Colorful, large text with word-by-word pop and color shift.",
    fontFamily: "Montserrat, Arial Black, sans-serif",
    fontSize: 64,
    fontWeight: 800,
    textColor: "#FFFFFF",
    highlightColor: "#FF6B6B",
    backgroundColor: "#000000",
    backgroundOpacity: 0,
    position: "center",
    animation: "bounce",
    maxWordsPerLine: 3,
    wordSpacing: 10,
    lineSpacing: 14,
    strokeColor: "#000000",
    strokeWidth: 3,
    padding: { top: 0, bottom: 0, left: 16, right: 16 },
    animationDuration: 5,
    supportsBrandKit: false,
  },
  {
    id: "news",
    name: "News Ticker",
    description: "Monospace on black bar. Smooth scroll reveal.",
    fontFamily: "Roboto Mono, Courier New, monospace",
    fontSize: 36,
    fontWeight: 400,
    textColor: "#FFFFFF",
    highlightColor: "#FF4444",
    backgroundColor: "#1A1A1A",
    backgroundOpacity: 0.85,
    position: "bottom",
    animation: "underline",
    maxWordsPerLine: 8,
    wordSpacing: 4,
    lineSpacing: 6,
    strokeColor: "transparent",
    strokeWidth: 0,
    padding: { top: 12, bottom: 12, left: 24, right: 24 },
    animationDuration: 10,
    supportsBrandKit: false,
  },
  {
    id: "podcast",
    name: "Podcast",
    description:
      "Speaker-attributed with side-by-side layout. Fade with speaker indicator.",
    fontFamily: "Georgia, Times New Roman, serif",
    fontSize: 42,
    fontWeight: 400,
    textColor: "#E8E8E8",
    highlightColor: "#7CB9E8",
    backgroundColor: "#1C1C1C",
    backgroundOpacity: 0.7,
    position: "lower-third",
    animation: "fade",
    maxWordsPerLine: 7,
    wordSpacing: 5,
    lineSpacing: 8,
    strokeColor: "transparent",
    strokeWidth: 0,
    padding: { top: 10, bottom: 10, left: 20, right: 20 },
    animationDuration: 10,
    supportsBrandKit: true,
  },
  {
    id: "corporate",
    name: "Corporate",
    description: "Professional brand colors with underline highlight sweep.",
    fontFamily: "Lato, Helvetica, Arial, sans-serif",
    fontSize: 44,
    fontWeight: 600,
    textColor: "#2C3E50",
    highlightColor: "#3498DB",
    backgroundColor: "#FFFFFF",
    backgroundOpacity: 0.85,
    position: "lower-third",
    animation: "underline",
    maxWordsPerLine: 6,
    wordSpacing: 5,
    lineSpacing: 8,
    strokeColor: "transparent",
    strokeWidth: 0,
    padding: { top: 10, bottom: 10, left: 20, right: 20 },
    animationDuration: 8,
    supportsBrandKit: true,
  },
];

/**
 * Get a caption template by ID.
 */
export function getCaptionTemplate(
  id: string,
): CaptionTemplateConfig | undefined {
  return CAPTION_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get all available template IDs.
 */
export function getCaptionTemplateIds(): string[] {
  return CAPTION_TEMPLATES.map((t) => t.id);
}

/**
 * Apply brand kit overrides to a template.
 */
export function applyBrandKitToTemplate(
  template: CaptionTemplateConfig,
  brandKit: {
    primaryColor?: string;
    secondaryColor?: string;
    fontFamily?: string;
  },
): CaptionTemplateConfig {
  if (!template.supportsBrandKit) return template;

  return {
    ...template,
    highlightColor: brandKit.primaryColor ?? template.highlightColor,
    textColor: brandKit.secondaryColor ?? template.textColor,
    fontFamily: brandKit.fontFamily ?? template.fontFamily,
  };
}

/**
 * Break transcript words into caption lines based on max words per line.
 */
export function breakIntoLines(
  words: CaptionWord[],
  maxWordsPerLine: number,
): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let currentWords: CaptionWord[] = [];

  for (const word of words) {
    currentWords.push(word);

    if (currentWords.length >= maxWordsPerLine) {
      lines.push({
        words: [...currentWords],
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
      });
      currentWords = [];
    }
  }

  if (currentWords.length > 0) {
    lines.push({
      words: currentWords,
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
    });
  }

  return lines;
}
