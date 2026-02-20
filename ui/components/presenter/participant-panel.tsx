"use client";

import { memo, useRef, useEffect } from "react";
import { Mic, MicOff, VideoOff, Video } from "lucide-react";
import type { RemotePeer } from "@/hooks/useVoiceRoom";

interface ParticipantPanelProps {
  localStream: MediaStream | null;
  remoteStreams: RemotePeer[];
  isAudioMuted: boolean;
  isVideoMuted: boolean;
  /** Socket.IO room member count (authoritative; may exceed PeerJS peers). */
  memberCount?: number;
  /** Role of the local user (host or guest). */
  role?: "host" | "guest";
}

/**
 * Teams-style participant list panel shown inside the SlideDrawer.
 * Lists all connected peers with their video feeds and audio indicators.
 */
export function ParticipantPanel({
  localStream,
  remoteStreams,
  isAudioMuted,
  isVideoMuted,
  memberCount,
  role = "host",
}: ParticipantPanelProps) {
  // Use Socket.IO member count when available (authoritative), fall back to PeerJS count
  const total = memberCount ?? (1 + remoteStreams.length);
  const localLabel = role === "host" ? "You (Host)" : "You (Guest)";

  // Number of remote members without a PeerJS stream yet
  const unconnectedRemotes = Math.max(0, total - 1 - remoteStreams.length);

  return (
    <div className="flex flex-col gap-1 p-3">
      <p className="mb-2 text-xs text-white/40">
        {total} participant{total !== 1 ? "s" : ""} in this session
      </p>

      {/* Local participant */}
      {localStream && (
        <ParticipantRow
          stream={localStream}
          label={localLabel}
          isLocal
          audioMuted={isAudioMuted}
          videoMuted={isVideoMuted}
        />
      )}

      {/* Remote participants with PeerJS stream */}
      {remoteStreams.map((rp) => (
        <ParticipantRow
          key={rp.peerId}
          stream={rp.stream}
          label={`Participant ${rp.peerId.slice(0, 4)}`}
          audioMuted={false}
          videoMuted={false}
        />
      ))}

      {/* Placeholder rows for members connected via Socket.IO but not yet via PeerJS */}
      {Array.from({ length: unconnectedRemotes }, (_, i) => (
        <div key={`pending-${i}`} className="flex items-center gap-3 rounded-lg px-3 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800">
            <span className="text-xs font-bold text-white/40">?</span>
          </div>
          <span className="min-w-0 flex-1 truncate text-sm text-white/40">Connecting…</span>
        </div>
      ))}
    </div>
  );
}

const ParticipantRow = memo(function ParticipantRow({
  stream,
  label,
  isLocal,
  audioMuted,
  videoMuted,
}: {
  stream: MediaStream;
  label: string;
  isLocal?: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.play()?.catch(() => {/* autoplay may be blocked */});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const hasVideo = stream.getVideoTracks().some((t) => t.enabled) && !videoMuted;

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5">
      {/* Thumbnail */}
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        {hasVideo ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isLocal}
            className="h-full w-full object-cover"
          />
        ) : (
          <>
            <div className="flex h-full w-full items-center justify-center text-xs font-bold text-white/40">
              {label.charAt(0).toUpperCase()}
            </div>
            <video ref={videoRef} autoPlay playsInline muted={isLocal} className="hidden" />
          </>
        )}
      </div>

      {/* Name */}
      <span className="min-w-0 flex-1 truncate text-sm text-white/80">{label}</span>

      {/* Status icons */}
      <div className="flex items-center gap-1.5">
        {audioMuted ? (
          <MicOff className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <Mic className="h-3.5 w-3.5 text-white/30" />
        )}
        {videoMuted ? (
          <VideoOff className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <Video className="h-3.5 w-3.5 text-white/30" />
        )}
      </div>
    </div>
  );
});
