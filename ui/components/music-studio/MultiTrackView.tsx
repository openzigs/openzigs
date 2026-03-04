"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import WaveSurfer from "wavesurfer.js";
import { WaveformTrack } from "./WaveformTrack";
import { Play, Pause, SkipBack, Volume2, VolumeX, Trash2 } from "lucide-react";

interface Track {
  id: string;
  label: string;
  url: string;
  color: string;
  progressColor: string;
  muted: boolean;
  volume: number;
}

interface MultiTrackViewProps {
  tracks: Track[];
  onTracksChange?: (tracks: Track[]) => void;
  /** Global playback speed */
  playbackRate?: number;
  /** Show timeline on the first track */
  showTimeline?: boolean;
}

export function MultiTrackView({
  tracks,
  onTracksChange,
  playbackRate = 1,
  showTimeline = true,
}: MultiTrackViewProps) {
  const wsRefs = useRef<Map<string, WaveSurfer | null>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const setWsRef = useCallback((trackId: string) => {
    const ref = { current: null as WaveSurfer | null };
    return {
      get current() { return ref.current; },
      set current(ws: WaveSurfer | null) {
        ref.current = ws;
        wsRefs.current.set(trackId, ws);
      },
    } as React.MutableRefObject<WaveSurfer | null>;
  }, []);

  const playAll = useCallback(() => {
    wsRefs.current.forEach((ws) => ws?.play());
    setIsPlaying(true);
  }, []);

  const pauseAll = useCallback(() => {
    wsRefs.current.forEach((ws) => ws?.pause());
    setIsPlaying(false);
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlaying) pauseAll();
    else playAll();
  }, [isPlaying, playAll, pauseAll]);

  const seekToStart = useCallback(() => {
    wsRefs.current.forEach((ws) => ws?.seekTo(0));
    setCurrentTime(0);
  }, []);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleReady = useCallback((dur: number) => {
    setDuration((prev) => Math.max(prev, dur));
  }, []);

  const toggleMute = useCallback((trackId: string) => {
    const updated = tracks.map((t) =>
      t.id === trackId ? { ...t, muted: !t.muted } : t
    );
    onTracksChange?.(updated);
  }, [tracks, onTracksChange]);

  const removeTrack = useCallback((trackId: string) => {
    wsRefs.current.delete(trackId);
    const updated = tracks.filter((t) => t.id !== trackId);
    onTracksChange?.(updated);
  }, [tracks, onTracksChange]);

  const formatTime = useCallback((t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }, []);

  // Sync all tracks when one finishes
  useEffect(() => {
    const handlers: (() => void)[] = [];
    wsRefs.current.forEach((ws) => {
      if (!ws) return;
      const onFinish = () => {
        setIsPlaying(false);
      };
      ws.on("finish", onFinish);
      handlers.push(() => ws.un("finish", onFinish));
    });
    return () => handlers.forEach((h) => h());
  }, [tracks]);

  return (
    <div className="space-y-3">
      {/* Transport Controls */}
      <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2">
        <button
          onClick={seekToStart}
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          title="Restart"
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          onClick={togglePlayback}
          className="rounded-full bg-indigo-600 p-2 text-white hover:bg-indigo-500"
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="font-mono text-sm text-zinc-400">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        {playbackRate !== 1 && (
          <span className="rounded bg-indigo-600/20 px-1.5 py-0.5 font-mono text-[10px] text-indigo-400">
            {playbackRate.toFixed(2)}x
          </span>
        )}
      </div>

      {/* Tracks */}
      {tracks.map((track, idx) => (
        <div key={track.id} className="flex items-start gap-2">
          <div className="mt-3 flex flex-col gap-1">
            <button
              onClick={() => toggleMute(track.id)}
              className="rounded p-1 text-zinc-500 hover:text-white"
              title={track.muted ? "Unmute" : "Mute"}
            >
              {track.muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={() => removeTrack(track.id)}
              className="rounded p-1 text-zinc-600 hover:text-red-400"
              title="Remove track"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1">
            <WaveformTrack
              url={track.url}
              label={track.label}
              color={track.color}
              progressColor={track.progressColor}
              muted={track.muted}
              volume={track.volume}
              playbackRate={playbackRate}
              showTimeline={showTimeline && idx === 0}
              onTimeUpdate={track.id === tracks[0]?.id ? handleTimeUpdate : undefined}
              onReady={handleReady}
              wsRef={setWsRef(track.id)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
