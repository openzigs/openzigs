"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Subtitles, Eye, EyeOff } from "lucide-react";
import type { DirectorManifest, TimelineEntry } from "../types";

type CaptionStyle = "pill" | "underline" | "boxed" | "karaoke";
type CaptionPosition = "bottom" | "center" | "top";

/**
 * Derive word-level frame timings from scene scriptText fields.
 * Mirrors the estimateWordTimings logic in shorts-pipeline.ts.
 */
function deriveWordTimings(
  manifest: DirectorManifest,
): Array<{ word: string; start: number; end: number }> {
  const fps = manifest.composition?.fps ?? 30;
  // Gather all scene entries with scriptText, ordered by startAtFrame
  const scenes = (manifest.timeline ?? [])
    .filter((e) => e.type !== "overlay" && e.type !== "transition" && (e as Record<string, unknown>).scriptText)
    .sort((a, b) => (a.startAtFrame ?? 0) - (b.startAtFrame ?? 0));

  const results: Array<{ word: string; start: number; end: number }> = [];
  const MIN_FRAMES = 4;

  for (const scene of scenes) {
    const scriptText = ((scene as Record<string, unknown>).scriptText as string).replace(/\[PAUSE:\s*[\d.]+s?\]/gi, "").replace(/\*/g, "");
    const words = scriptText.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;

    const sceneDuration = (scene.duration as number | undefined) ?? fps;
    const startAtFrame = scene.startAtFrame ?? 0;
    const totalChars = words.reduce((n, w) => n + w.length, 0);

    const rawDurations = words.map((w) =>
      Math.max(MIN_FRAMES, Math.round(sceneDuration * (w.length / totalChars))),
    );
    const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
    const scale = sceneDuration / rawTotal;
    const durations = rawDurations.map((d) => Math.max(MIN_FRAMES, Math.round(d * scale)));
    const durSum = durations.reduce((a, b) => a + b, 0);
    durations[durations.length - 1] += sceneDuration - durSum;

    let frame = startAtFrame;
    for (let i = 0; i < words.length; i++) {
      const end = Math.min(frame + durations[i], startAtFrame + sceneDuration);
      results.push({ word: words[i], start: frame, end });
      frame = end;
    }
  }

  return results;
}

const STYLE_OPTIONS: { value: CaptionStyle; label: string; preview: string }[] = [
  { value: "karaoke", label: "Karaoke", preview: "Word-by-word highlight with glow" },
  { value: "pill", label: "Pill", preview: "Active word in rounded badge" },
  { value: "underline", label: "Underline", preview: "Underline beneath active word" },
  { value: "boxed", label: "Boxed", preview: "Words in a background box" },
];

const POSITION_OPTIONS: { value: CaptionPosition; label: string }[] = [
  { value: "bottom", label: "Bottom" },
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
];

const FONT_SIZE_OPTIONS = [
  { value: 36, label: "S" },
  { value: 56, label: "M" },
  { value: 80, label: "L" },
  { value: 110, label: "XL" },
];

interface CaptionStylePanelProps {
  manifest: DirectorManifest;
  onManifestUpdate: (manifest: DirectorManifest) => void;
}

function findCaptionOverlay(manifest: DirectorManifest) {
  return manifest.timeline?.find(
    (e) => e.type === "overlay" && (e as Record<string, unknown>).component === "SmartCaptions",
  );
}

function getCaptionProps(overlay: TimelineEntry | undefined) {
  if (!overlay) return undefined;
  return (overlay as Record<string, unknown>).props as
    | { style?: CaptionStyle; fontSize?: number; position?: CaptionPosition; fontColor?: string; backgroundColor?: string; words?: unknown[] }
    | undefined;
}

export function CaptionStylePanel({ manifest, onManifestUpdate }: CaptionStylePanelProps) {
  const captionOverlay = useMemo(() => findCaptionOverlay(manifest), [manifest]);
  const captionProps = useMemo(() => getCaptionProps(captionOverlay), [captionOverlay]);

  // Preserve word timings across off/on toggles so re-enabling doesn't lose them
  const savedWords = useRef<unknown[]>([]);

  // Fingerprint of scene durations & positions — used to detect when word timings need re-derivation
  const sceneDurationFingerprint = useMemo(() => {
    if (!manifest.timeline) return "";
    return manifest.timeline
      .filter((e) => e.type !== "overlay" && e.type !== "transition")
      .map((e) => `${e.startAtFrame ?? 0}:${(e.duration ?? (e as Record<string, unknown>).durationInFrames) ?? 0}`)
      .join("|");
  }, [manifest.timeline]);

  const prevFingerprint = useRef(sceneDurationFingerprint);

  const enabled = !!captionOverlay;
  const currentStyle = captionProps?.style ?? "karaoke";
  const currentPosition = captionProps?.position ?? "bottom";
  const currentFontSize = captionProps?.fontSize ?? 56;

  // Re-derive word timings when scene durations or positions change
  useEffect(() => {
    if (sceneDurationFingerprint === prevFingerprint.current) return;
    prevFingerprint.current = sceneDurationFingerprint;
    if (!enabled || !manifest.timeline) return;

    const freshWords = deriveWordTimings(manifest);
    if (freshWords.length === 0) return;
    savedWords.current = freshWords;
    // Inline overlay update to avoid circular dep on updateOverlayProps
    const timeline = manifest.timeline.map((e) => {
      if (e.type === "overlay" && (e as Record<string, unknown>).component === "SmartCaptions") {
        const existing = (e as Record<string, unknown>).props as Record<string, unknown> | undefined;
        return { ...e, props: { ...existing, words: freshWords } };
      }
      return e;
    });
    onManifestUpdate({ ...manifest, timeline });
  }, [sceneDurationFingerprint, enabled, manifest, onManifestUpdate]);

  const updateOverlayProps = useCallback(
    (updates: Record<string, unknown>) => {
      if (!manifest.timeline) return;
      const timeline = manifest.timeline.map((e) => {
        if (e.type === "overlay" && (e as Record<string, unknown>).component === "SmartCaptions") {
          const existing = (e as Record<string, unknown>).props as Record<string, unknown> | undefined;
          return { ...e, props: { ...existing, ...updates } };
        }
        return e;
      });
      onManifestUpdate({ ...manifest, timeline });
    },
    [manifest, onManifestUpdate],
  );

  const handleToggle = useCallback(() => {
    if (!manifest.timeline) return;

    if (enabled) {
      // Save word timings before removing the overlay so we can restore them
      if (captionProps?.words && captionProps.words.length > 0) {
        savedWords.current = captionProps.words;
      }
      // Remove the overlay
      const timeline = manifest.timeline.filter(
        (e) => !(e.type === "overlay" && (e as Record<string, unknown>).component === "SmartCaptions"),
      );
      onManifestUpdate({ ...manifest, timeline });
    } else {
      // Re-add a SmartCaptions overlay — compute duration from visual segments only
      const visualTypes = new Set(["video_clip", "title_card", "image_scene", "intro_card", "outro_card"]);
      const totalFrames = manifest.timeline.reduce((max, e) => {
        if (!visualTypes.has(e.type)) return max;
        const dur = (e.duration as number | undefined) ?? ((e as Record<string, unknown>).durationInFrames as number | undefined) ?? 0;
        const end = (e.startAtFrame ?? 0) + dur;
        return Math.max(max, end);
      }, 0);
      const newOverlay: TimelineEntry = {
        type: "overlay",
        component: "SmartCaptions",
        props: {
          // Restore saved words from this session, or re-derive from scene
          // scriptText so re-enabling after a page reload still has timings.
          words: deriveWordTimings(manifest),
          style: "karaoke",
          fontSize: 80,
          fontColor: "#ffffff",
          position: "bottom",
        },
        startAtFrame: 0,
        duration: totalFrames,
      };
      onManifestUpdate({ ...manifest, timeline: [...manifest.timeline, newOverlay] });
    }
  }, [manifest, enabled, captionProps, onManifestUpdate]);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Subtitles className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground">Captions</span>
        </div>
        <button
          onClick={handleToggle}
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
            enabled
              ? "bg-primary/15 text-primary hover:bg-primary/25"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          {enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {enabled ? "On" : "Off"}
        </button>
      </div>

      {enabled && (
        <div className="mt-3 space-y-3">
          {/* Style picker */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Style</p>
            <div className="grid grid-cols-2 gap-1.5">
              {STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateOverlayProps({ style: opt.value })}
                  className={`rounded-md border px-2 py-1.5 text-left transition ${
                    currentStyle === opt.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <span className="block text-[11px] font-medium">{opt.label}</span>
                  <span className="block text-[9px] text-muted-foreground">{opt.preview}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Position picker */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Position</p>
            <div className="flex gap-1">
              {POSITION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateOverlayProps({ position: opt.value })}
                  className={`flex-1 rounded-md border px-2 py-1 text-center text-[11px] font-medium transition ${
                    currentPosition === opt.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font size picker */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Size</p>
            <div className="flex gap-1">
              {FONT_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateOverlayProps({ fontSize: opt.value })}
                  className={`flex-1 rounded-md border px-2 py-1 text-center text-[11px] font-medium transition ${
                    currentFontSize === opt.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
