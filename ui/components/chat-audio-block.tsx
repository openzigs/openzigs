"use client";

import { memo, useState, useRef, useCallback, useEffect } from "react";
import { Play, Pause, Download, Volume2 } from "lucide-react";

const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

type ChatAudioBlockProps = {
  src: string;
  title?: string;
};

/**
 * Inline audio player for chat messages.
 * Renders a compact player with play/pause, progress bar, and download.
 */
export const ChatAudioBlock = memo(function ChatAudioBlock({ src, title }: ChatAudioBlockProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);

  const authedSrc = src.includes("/api/") && AUTH_TOKEN
    ? `${src}${src.includes("?") ? "&" : "?"}token=${AUTH_TOKEN}`
    : src;

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
    setPlaying(!playing);
  }, [playing]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * duration;
  }, [duration]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration);
    const onEnd = () => setPlaying(false);
    const onErr = () => setError(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("error", onErr);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("error", onErr);
    };
  }, []);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  if (error) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Volume2 className="h-4 w-4" />
        <span>Failed to load audio</span>
        {title && <span className="italic">({title})</span>}
      </div>
    );
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="my-2 flex max-w-sm items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <audio ref={audioRef} src={authedSrc} preload="metadata" />
      <button
        onClick={togglePlay}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && (
          <span className="truncate text-xs font-medium text-foreground">{title}</span>
        )}
        <div
          className="h-1.5 cursor-pointer rounded-full bg-muted"
          onClick={handleSeek}
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
      <a
        href={authedSrc}
        download={title || "audio"}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Download"
      >
        <Download className="h-4 w-4" />
      </a>
    </div>
  );
});
