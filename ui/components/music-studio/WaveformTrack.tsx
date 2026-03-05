"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { AlertCircle, X } from "lucide-react";

interface WaveformTrackProps {
  /** URL of the audio file */
  url: string;
  /** Track label */
  label: string;
  /** Waveform color */
  color?: string;
  /** Progress (played) color */
  progressColor?: string;
  /** Height in pixels */
  height?: number;
  /** Whether this track is muted */
  muted?: boolean;
  /** Volume 0-1 */
  volume?: number;
  /** Show timeline with time labels */
  showTimeline?: boolean;
  /** Playback speed (0.25 – 4) */
  playbackRate?: number;
  /** Called when playback position changes */
  onTimeUpdate?: (time: number) => void;
  /** Called when wavesurfer is ready */
  onReady?: (duration: number) => void;
  /** Called when track fails to load */
  onError?: (message: string) => void;
  /** Called when user wants to remove this track */
  onRemove?: () => void;
  /** External ref for controlling playback */
  wsRef?: React.MutableRefObject<WaveSurfer | null>;
}

export function WaveformTrack({
  url,
  label,
  color = "#6366f1",
  progressColor = "#818cf8",
  height = 80,
  muted = false,
  volume = 1,
  showTimeline = false,
  playbackRate = 1,
  onTimeUpdate,
  onReady,
  onError,
  onRemove,
  wsRef,
}: WaveformTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    setIsLoading(true);
    setError(null);

    const plugins: Array<ReturnType<typeof TimelinePlugin.create> | ReturnType<typeof HoverPlugin.create>> = [];

    if (showTimeline) {
      plugins.push(
        TimelinePlugin.create({
          height: 16,
          timeInterval: 5,
          primaryLabelInterval: 10,
          style: { fontSize: "10px", color: "#71717a" },
        })
      );
    }

    plugins.push(
      HoverPlugin.create({
        lineColor: "#f59e0b",
        lineWidth: 1,
        labelSize: 10,
        labelColor: "#f59e0b",
        labelBackground: "#18181b",
      })
    );

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: color,
      progressColor,
      height,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      cursorWidth: 1,
      cursorColor: "#f59e0b",
      normalize: true,
      interact: true,
      plugins,
    });

    wavesurferRef.current = ws;
    if (wsRef) wsRef.current = ws;

    ws.on("ready", () => {
      const dur = ws.getDuration();
      setDuration(dur);
      setIsLoading(false);
      ws.setPlaybackRate(playbackRate, true);
      onReady?.(dur);
    });

    ws.on("timeupdate", (time: number) => {
      setCurrentTime(time);
      onTimeUpdate?.(time);
    });

    ws.on("error", (err: Error) => {
      const msg = err?.message ?? "Failed to load audio";
      // Ignore abort errors (triggered by cleanup/unmount)
      if (msg.includes("abort") || msg.includes("AbortError")) return;
      setError(msg);
      setIsLoading(false);
      onError?.(msg);
    });

    ws.load(url);

    return () => {
      ws.destroy();
      wavesurferRef.current = null;
      if (wsRef) wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, showTimeline]);

  useEffect(() => {
    if (wavesurferRef.current) {
      const clamped = Math.min(1, Math.max(0, volume));
      wavesurferRef.current.setVolume(muted ? 0 : clamped);
    }
  }, [muted, volume]);

  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.setPlaybackRate(playbackRate, true);
    }
  }, [playbackRate]);

  const formatTime = useCallback((t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }, []);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-zinc-500">
            {error
              ? "error"
              : isLoading
                ? "loading..."
                : `${formatTime(currentTime)} / ${formatTime(duration)}`}
          </span>
          {onRemove && (
            <button
              onClick={onRemove}
              className="rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
              title="Remove track"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded border border-red-900/50 bg-red-950/30 px-3 py-3 text-xs text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
    </div>
  );
}
