"use client";

import { useRef, useEffect, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import { Activity } from "lucide-react";

interface SpectrogramViewProps {
  /** URL of the audio file to render */
  url: string;
  /** Height of spectrogram in pixels */
  height?: number;
  /** FFT sample size (power of 2) */
  fftSamples?: number;
}

export function SpectrogramView({
  url,
  height = 128,
  fftSamples = 1024,
}: SpectrogramViewProps) {
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const spectroContainerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waveContainerRef.current || !spectroContainerRef.current) return;

    setIsLoading(true);
    setError(null);

    const ws = WaveSurfer.create({
      container: waveContainerRef.current,
      waveColor: "rgba(99,102,241,0.3)",
      progressColor: "rgba(99,102,241,0.5)",
      height: 0,
      interact: false,
      plugins: [
        SpectrogramPlugin.create({
          container: spectroContainerRef.current,
          height,
          fftSamples,
          labels: true,
          labelsColor: "#71717a",
          labelsBackground: "transparent",
        }),
      ],
    });

    ws.on("ready", () => setIsLoading(false));
    ws.on("error", (err: Error) => {
      setError(err?.message ?? "Failed to load audio");
      setIsLoading(false);
    });

    ws.load(url);

    return () => ws.destroy();
  }, [url, height, fftSamples]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-indigo-400" />
        <span className="text-xs font-medium text-zinc-400">
          Frequency Spectrogram
        </span>
        {isLoading && (
          <span className="text-[10px] text-zinc-600">analyzing...</span>
        )}
      </div>
      {/* Hidden waveform container (needed by wavesurfer but we only show spectrogram) */}
      <div ref={waveContainerRef} className="hidden" />
      {error ? (
        <p className="py-4 text-center text-xs text-red-400">{error}</p>
      ) : (
        <div ref={spectroContainerRef} className="w-full overflow-hidden rounded" />
      )}
    </div>
  );
}
