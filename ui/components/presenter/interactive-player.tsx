"use client";

import { type RefObject } from "react";

interface InteractivePlayerProps {
  videoRef: RefObject<HTMLVideoElement>;
  videoUrl: string;
  onTimeUpdate: () => void;
  onEnded: () => void;
  onPlay: () => void;
}

export function InteractivePlayer({
  videoRef,
  videoUrl,
  onTimeUpdate,
  onEnded,
  onPlay,
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
      />
    </div>
  );
}
