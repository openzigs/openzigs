"use client";

import { useRef, useEffect, memo } from "react";
import { Mic, MicOff, VideoOff } from "lucide-react";
import type { RemotePeer } from "@/hooks/useVoiceRoom";

/** Single video tile — memoized to avoid re-renders killing srcObject. */
const VideoTile = memo(function VideoTile({
  stream,
  label,
  muted,
  isLocal,
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  isLocal?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach srcObject via ref — never let React reconciler touch it.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const hasVideo = stream.getVideoTracks().some((t) => t.enabled);

  return (
    <div className="relative overflow-hidden rounded-lg bg-zinc-900">
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal} // always mute local to prevent echo
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <VideoOff className="h-6 w-6 text-zinc-500" />
          {/* Hidden video to keep the stream playing for audio */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isLocal}
            className="hidden"
          />
        </div>
      )}

      {/* Name badge + mic indicator */}
      <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">
        {muted ? (
          <MicOff className="h-2.5 w-2.5 text-red-400" />
        ) : (
          <Mic className="h-2.5 w-2.5 text-green-400" />
        )}
        <span className="max-w-[80px] truncate">{label}</span>
      </div>
    </div>
  );
});

interface VideoGridProps {
  /** The local MediaStream (from useMediaDevices). */
  localStream: MediaStream | null;
  /** Remote peers with their streams (from useVoiceRoom). */
  remoteStreams: RemotePeer[];
  /** Whether local audio is muted. */
  isAudioMuted: boolean;
  /** Whether local video is disabled. */
  isVideoMuted: boolean;
  /** Callback to toggle local audio mute. */
  onToggleAudio: () => void;
  /** Callback to toggle local video. */
  onToggleVideo: () => void;
}

/**
 * Responsive video grid for up to 5 participants.
 * Adapts layout: 1 tile = full width, 2 = side-by-side, 3-4 = 2x2, 5 = 2+3 rows.
 */
export function VideoGrid({
  localStream,
  remoteStreams,
  isAudioMuted,
  isVideoMuted,
  onToggleAudio,
  onToggleVideo,
}: VideoGridProps) {
  const totalTiles = 1 + remoteStreams.length; // local + remotes

  // Determine grid class based on participant count
  const gridClass =
    totalTiles <= 1
      ? "grid-cols-1"
      : totalTiles === 2
        ? "grid-cols-2"
        : totalTiles <= 4
          ? "grid-cols-2 grid-rows-2"
          : "grid-cols-3 grid-rows-2"; // 5 tiles

  return (
    <div className="flex flex-col gap-2">
      <div
        className={`grid gap-1 ${gridClass}`}
        style={{ aspectRatio: totalTiles <= 2 ? "16/9" : "4/3" }}
      >
        {/* Local tile */}
        {localStream && (
          <VideoTile
            stream={localStream}
            label="You"
            muted={isAudioMuted}
            isLocal
          />
        )}

        {/* Remote tiles */}
        {remoteStreams.map((rp) => (
          <VideoTile
            key={rp.peerId}
            stream={rp.stream}
            label={`Peer ${rp.peerId.slice(0, 4)}`}
            muted={false}
          />
        ))}
      </div>

      {/* A/V controls */}
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={onToggleAudio}
          title={isAudioMuted ? "Unmute mic" : "Mute mic"}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
            isAudioMuted
              ? "bg-red-600 text-white"
              : "bg-zinc-700 text-white hover:bg-zinc-600"
          }`}
        >
          {isAudioMuted ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={onToggleVideo}
          title={isVideoMuted ? "Turn on camera" : "Turn off camera"}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
            isVideoMuted
              ? "bg-red-600 text-white"
              : "bg-zinc-700 text-white hover:bg-zinc-600"
          }`}
        >
          <VideoOff className="h-4 w-4" />
        </button>

        <span className="ml-2 text-[10px] text-muted-foreground">
          {remoteStreams.length + 1} in call
        </span>
      </div>
    </div>
  );
}
