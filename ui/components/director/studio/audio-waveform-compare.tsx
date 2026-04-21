"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

export interface AudioWaveformCompareProps {
  /** URL of the original/raw audio. */
  originalUrl: string;
  /** URL of the cleaned/processed audio. Optional. */
  cleanedUrl?: string;
  /** Waveform color for the original track. */
  originalColor?: string;
  /** Waveform color for the cleaned track. */
  cleanedColor?: string;
  /** Visual height of each waveform in pixels. */
  height?: number;
}

/**
 * Side-by-side waveform comparison powered by wavesurfer.js. Renders the
 * original and cleaned audio so users can visually verify cleanup quality.
 *
 * Issue #832 — Audio Cleaner Panel improvements.
 */
export function AudioWaveformCompare({
  originalUrl,
  cleanedUrl,
  originalColor = "#94a3b8",
  cleanedColor = "#10b981",
  height = 64,
}: AudioWaveformCompareProps) {
  const originalContainer = useRef<HTMLDivElement>(null);
  const cleanedContainer = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalReady, setOriginalReady] = useState(false);
  const [cleanedReady, setCleanedReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controllers: { destroy: () => void }[] = [];

    async function load() {
      try {
        const { default: WaveSurfer } = await import("wavesurfer.js");
        if (cancelled) return;
        if (originalContainer.current) {
          const ws = WaveSurfer.create({
            container: originalContainer.current,
            url: originalUrl,
            waveColor: originalColor,
            progressColor: originalColor,
            height,
            barWidth: 2,
            barGap: 1,
          });
          ws.on("ready", () => setOriginalReady(true));
          controllers.push({ destroy: () => ws.destroy() });
        }
        if (cleanedContainer.current && cleanedUrl) {
          const ws = WaveSurfer.create({
            container: cleanedContainer.current,
            url: cleanedUrl,
            waveColor: cleanedColor,
            progressColor: cleanedColor,
            height,
            barWidth: 2,
            barGap: 1,
          });
          ws.on("ready", () => setCleanedReady(true));
          controllers.push({ destroy: () => ws.destroy() });
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load wavesurfer",
        );
      }
    }

    void load();
    return () => {
      cancelled = true;
      for (const c of controllers) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
    };
  }, [originalUrl, cleanedUrl, originalColor, cleanedColor, height]);

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid="audio-waveform-compare"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Volume2 className="h-3.5 w-3.5" />
        Audio comparison
        {error && <span className="ml-2 text-red-500">⚠ {error}</span>}
      </div>
      <div className="space-y-3">
        <div>
          <p className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Original</span>
            {!originalReady && !error && <span>Loading…</span>}
          </p>
          <div
            ref={originalContainer}
            data-testid="waveform-original"
            className="rounded bg-muted"
            style={{ height }}
          />
        </div>
        {cleanedUrl ? (
          <div>
            <p className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>Cleaned</span>
              {!cleanedReady && !error && <span>Loading…</span>}
            </p>
            <div
              ref={cleanedContainer}
              data-testid="waveform-cleaned"
              className="rounded bg-muted"
              style={{ height }}
            />
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Run cleanup to see the cleaned waveform.
          </p>
        )}
      </div>
    </div>
  );
}
