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
    <div className="relative overflow-hidden bg-black sm:rounded-xl sm:border sm:border-white/10">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={videoUrl}
        className="max-h-full max-w-full"
        controls
        playsInline
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
        onSeeked={onSeeked}
      />
    </div>
  );
}
