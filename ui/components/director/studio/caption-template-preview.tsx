"use client";

import { useMemo } from "react";

export interface CaptionTemplatePreviewConfig {
  id: string;
  name: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  highlightColor?: string;
  backgroundColor?: string;
  position?: "top" | "center" | "bottom" | "lower-third";
  animation?: string;
  supportsBrandKit?: boolean;
}

export interface CaptionTemplatePreviewProps {
  template: CaptionTemplatePreviewConfig;
  /** Sample words to render. Defaults to a generic sample line. */
  sampleWords?: string[];
  /** Whether the template is currently selected. */
  selected?: boolean;
  onSelect?: () => void;
}

const DEFAULT_SAMPLE = ["This", "is", "the", "preview"];

/**
 * Mini visual preview of a caption template — renders a 16:9 thumbnail with the
 * template's typography, colors, and position so users can see what they're
 * picking instead of relying on text descriptions. Issue #830.
 */
export function CaptionTemplatePreview({
  template,
  sampleWords = DEFAULT_SAMPLE,
  selected = false,
  onSelect,
}: CaptionTemplatePreviewProps) {
  const positionClass = useMemo(() => {
    switch (template.position) {
      case "top":
        return "items-start pt-2";
      case "center":
        return "items-center";
      case "lower-third":
        return "items-end pb-3";
      case "bottom":
      default:
        return "items-end pb-2";
    }
  }, [template.position]);

  const Wrapper = onSelect ? "button" : "div";

  return (
    <Wrapper
      type={onSelect ? "button" : undefined}
      onClick={onSelect}
      aria-label={`Caption template: ${template.name}`}
      aria-pressed={onSelect ? selected : undefined}
      className={`group relative flex aspect-video w-full flex-col justify-center overflow-hidden rounded-md border bg-zinc-900 text-left transition ${
        selected
          ? "border-primary ring-2 ring-primary/40"
          : "border-border hover:border-foreground/40"
      }`}
      data-testid={`caption-template-preview-${template.id}`}
    >
      <div
        className={`flex h-full w-full justify-center px-2 ${positionClass}`}
      >
        <p
          className="flex flex-wrap items-baseline justify-center gap-x-1 text-center leading-tight"
          style={{
            fontFamily: template.fontFamily,
            color: template.textColor ?? "#ffffff",
            backgroundColor: template.backgroundColor,
            fontSize: Math.min(14, (template.fontSize ?? 56) / 6),
            padding: template.backgroundColor ? "0 6px" : undefined,
          }}
        >
          {sampleWords.map((word, i) => {
            const isHighlighted = i === Math.floor(sampleWords.length / 2);
            return (
              <span
                key={`${word}-${i}`}
                style={{
                  color:
                    isHighlighted && template.highlightColor
                      ? template.highlightColor
                      : undefined,
                  fontWeight: isHighlighted ? 700 : 500,
                }}
              >
                {word}
              </span>
            );
          })}
        </p>
      </div>
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-black/60 px-1.5 py-0.5 text-[9px] text-white">
        <span className="truncate">{template.name}</span>
        {template.supportsBrandKit && (
          <span
            className="rounded bg-primary/30 px-1 text-[8px] uppercase"
            title="Supports brand kit colors"
          >
            BK
          </span>
        )}
      </div>
    </Wrapper>
  );
}
