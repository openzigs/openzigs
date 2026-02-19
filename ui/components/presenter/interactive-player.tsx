"use client";

import { type RefObject } from "react";

interface InteractivePlayerProps {
  videoRef: RefObject<HTMLVideoElement>;
  videoUrl: string;
  onTimeUpdate: () => void;
  onEnded: () => void;
  onPlay: () => void;
  onPause?: () => void;
  onSeeked?: () => void;
}

export function InteractivePlayer({
  videoRef,
  videoUrl,
  onTimeUpdate,
  onEnded,
  onPlay,
  onPause,
  onSeeked,
}: InteractivePlayerProps) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-black">
      <video
        ref={videoRef}
        src={videoUrl}
        className="aspect-video w-full"
        controls
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
        onSeeked={onSeeked}
      />
    </div>
  );
}
