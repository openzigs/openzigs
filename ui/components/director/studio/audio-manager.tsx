"use client";

import { useState, useCallback, useRef } from "react";
import { Music, Volume2, VolumeX, Upload, RotateCcw } from "lucide-react";

interface AudioManagerProps {
  music: { track: string; volume: number; loop: boolean; ducking?: boolean; fadeInFrames?: number; fadeOutFrames?: number } | null;
  onMusicChange: (music: AudioManagerProps["music"]) => void;
  fps: number;
}

export function AudioManager({ music, onMusicChange, fps }: AudioManagerProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const volume = music?.volume ?? 1;
  const ducking = music?.ducking ?? false;
  const loop = music?.loop ?? true;
  const fadeIn = music?.fadeInFrames ?? 0;
  const fadeOut = music?.fadeOutFrames ?? 0;

  const handleVolumeChange = useCallback(
    (value: number) => {
      if (!music) return;
      onMusicChange({ ...music, volume: value });
    },
    [music, onMusicChange],
  );

  const handleDuckingToggle = useCallback(() => {
    if (!music) return;
    onMusicChange({ ...music, ducking: !ducking });
  }, [music, ducking, onMusicChange]);

  const handleLoopToggle = useCallback(() => {
    if (!music) return;
    onMusicChange({ ...music, loop: !loop });
  }, [music, loop, onMusicChange]);

  const handleFadeInChange = useCallback(
    (seconds: number) => {
      if (!music) return;
      onMusicChange({ ...music, fadeInFrames: Math.round(seconds * fps) });
    },
    [music, fps, onMusicChange],
  );

  const handleFadeOutChange = useCallback(
    (seconds: number) => {
      if (!music) return;
      onMusicChange({ ...music, fadeOutFrames: Math.round(seconds * fps) });
    },
    [music, fps, onMusicChange],
  );

  const handleRemoveMusic = useCallback(() => {
    onMusicChange(null);
  }, [onMusicChange]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const formData = new FormData();
      formData.append("file", file);

      try {
        const apiBase = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
        const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
        const res = await fetch(`${apiBase}/api/admin/director/upload`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json() as { filePath: string };
        onMusicChange({
          track: data.filePath,
          volume: 0.3,
          loop: true,
          ducking: true,
          fadeInFrames: Math.round(fps * 2),
          fadeOutFrames: Math.round(fps * 3),
        });
      } catch (err) {
        console.error("Music upload failed:", err);
      }
    },
    [fps, onMusicChange],
  );

  const trackName = music?.track ? String(music.track).split("/").pop() : null;

  return (
    <div className="rounded-lg border border-border p-3" data-testid="audio-manager">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Music className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">Background Music</p>
        </div>
        {music && (
          <button
            onClick={handleRemoveMusic}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive transition"
            data-testid="remove-music"
          >
            <VolumeX className="h-3 w-3" />
            Remove
          </button>
        )}
      </div>

      {!music ? (
        <div className="flex flex-col items-center gap-2 py-3">
          <p className="text-[10px] text-muted-foreground">No music track assigned</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition"
            data-testid="upload-music"
          >
            <Upload className="h-3 w-3" />
            Upload Track
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleFileUpload}
          />
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* Track info */}
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded bg-muted/50 px-2 py-1 text-[10px] text-foreground" data-testid="track-name">
              🎵 {trackName ?? "Unknown track"}
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded p-1 text-muted-foreground hover:bg-muted transition"
              title="Replace track"
              data-testid="replace-music"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2">
            <Volume2 className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
              data-testid="volume-slider"
            />
            <span className="w-8 text-right text-[10px] text-muted-foreground tabular-nums">
              {Math.round(volume * 100)}%
            </span>
          </div>

          {/* Quick toggles */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleDuckingToggle}
              className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                ducking ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
              data-testid="toggle-ducking"
            >
              Ducking
            </button>
            <button
              onClick={handleLoopToggle}
              className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                loop ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
              data-testid="toggle-loop"
            >
              Loop
            </button>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition"
              data-testid="toggle-advanced"
            >
              {showAdvanced ? "Hide" : "More"}
            </button>
          </div>

          {/* Advanced fade controls */}
          {showAdvanced && (
            <div className="space-y-2 border-t border-border pt-2" data-testid="advanced-audio">
              <div className="flex items-center gap-2">
                <label className="w-16 shrink-0 text-[10px] text-muted-foreground">Fade In</label>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.5}
                  value={fadeIn / fps}
                  onChange={(e) => handleFadeInChange(parseFloat(e.target.value))}
                  className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
                  data-testid="fade-in-slider"
                />
                <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">
                  {(fadeIn / fps).toFixed(1)}s
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="w-16 shrink-0 text-[10px] text-muted-foreground">Fade Out</label>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.5}
                  value={fadeOut / fps}
                  onChange={(e) => handleFadeOutChange(parseFloat(e.target.value))}
                  className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
                  data-testid="fade-out-slider"
                />
                <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">
                  {(fadeOut / fps).toFixed(1)}s
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
