"use client";

import { memo, useRef, useEffect } from "react";
import { VideoOff } from "lucide-react";
import type { RemotePeer } from "@/hooks/useVoiceRoom";

interface RemotePeerTilesProps {
  /** All known remote peer IDs from Socket.IO discovery. */
  peerIds: string[];
  /** Remote peers with active media streams via PeerJS calls. */
  remoteStreams: RemotePeer[];
}

/**
 * Teams-style remote participant video tiles overlaid on the presentation.
 * Shows a tile for every discovered peer; uses the PeerJS stream when available.
 */
export function RemotePeerTiles({ peerIds, remoteStreams }: RemotePeerTilesProps) {
  if (peerIds.length === 0) return null;

  const streamMap = new Map(remoteStreams.map((rp) => [rp.peerId, rp.stream]));

  return (
    <div className="absolute left-3 top-3 z-10 flex gap-2">
      {peerIds.map((pid) => (
        <RemoteTile key={pid} peerId={pid} stream={streamMap.get(pid) ?? null} />
      ))}
    </div>
  );
}

const RemoteTile = memo(function RemoteTile({
  peerId,
  stream,
}: {
  peerId: string;
  stream: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.play()?.catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const hasVideo = stream?.getVideoTracks().some((t) => t.enabled) ?? false;

  return (
    <div className="h-20 w-28 overflow-hidden rounded-xl border-2 border-white/20 bg-zinc-900 shadow-2xl sm:h-24 sm:w-36">
      {hasVideo && stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1">
          <VideoOff className="h-4 w-4 text-white/30" />
          <span className="text-[10px] text-white/40">
            Guest {peerId.slice(0, 4)}
          </span>
          {stream && <video ref={videoRef} autoPlay playsInline className="hidden" />}
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 px-2 py-0.5">
        <span className="text-[10px] text-white/70">Guest {peerId.slice(0, 4)}</span>
      </div>
    </div>
  );
});
