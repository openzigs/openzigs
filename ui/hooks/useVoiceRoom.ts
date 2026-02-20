"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Peer from "peerjs";
import type { MediaConnection } from "peerjs";
import { useSocket } from "@/lib/socket-context";

const RAW_API_BASE =
  process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";

/**
 * Resolve PeerJS signaling host at runtime.
 * When the configured API base points at localhost but the browser is on a
 * remote origin (e.g. Cloudflare tunnel), fall back to window.location so
 * PeerJS traffic goes through the Next.js rewrite proxy.
 */
function resolvePeerConfig(): { host: string; port: number; secure: boolean } {
  let effectiveBase = RAW_API_BASE;
  if (effectiveBase) {
    try {
      const baseHost = new URL(effectiveBase).hostname;
      if (
        (baseHost === "localhost" || baseHost === "127.0.0.1") &&
        window.location.hostname !== "localhost" &&
        window.location.hostname !== "127.0.0.1"
      ) {
        effectiveBase = "";
      }
    } catch { /* malformed URL */ }
  }

  if (effectiveBase) {
    try {
      const url = new URL(effectiveBase);
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        secure: url.protocol === "https:",
      };
    } catch { /* fall through */ }
  }

  // Same-origin mode: PeerJS connects through the Next.js rewrite proxy
  return {
    host: window.location.hostname,
    port: window.location.port
      ? Number(window.location.port)
      : window.location.protocol === "https:" ? 443 : 80,
    secure: window.location.protocol === "https:",
  };
}

/** Build ICE servers list: STUN + optional TURN from env vars. */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      ...(turnUser && { username: turnUser }),
      ...(turnCred && { credential: turnCred }),
    });
  }

  return servers;
}

/** Max participants in the mesh (including self). */
const MAX_PEERS = 5;

export interface RemotePeer {
  peerId: string;
  stream: MediaStream;
}

export interface UseVoiceRoomReturn {
  /** Remote peer IDs currently connected. */
  peerIds: string[];
  /** Remote streams for rendering in VideoGrid. */
  remoteStreams: RemotePeer[];
  isMuted: boolean;
  isRaisingHand: boolean;
  isTranscribing: boolean;
  transcriptionPreview: string | null;
  toggleMic: () => void;
  raiseHand: () => void;
  lowerHand: () => void;
  cleanup: () => void;
}

/**
 * PeerJS mesh network hook for full-duplex video + audio.
 *
 * Accepts an external localStream from useMediaDevices so media lifecycle
 * is separated from mesh networking. Connects to every other peer in the
 * room (up to MAX_PEERS) and exposes remote MediaStreams for VideoGrid.
 *
 * Also handles push-to-talk STT relay via Socket.IO room:audio_chunk.
 */
export function useVoiceRoom(
  presentationId: string,
  localStream: MediaStream | null,
): UseVoiceRoomReturn {
  const { socket } = useSocket();

  const peerRef = useRef<Peer | null>(null);
  const callsRef = useRef<Map<string, MediaConnection>>(new Map());
  const recorderRef = useRef<MediaRecorder | null>(null);

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<RemotePeer[]>([]);
  const [isMuted, setIsMuted] = useState(true);
  const [isRaisingHand, setIsRaisingHand] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionPreview, setTranscriptionPreview] = useState<string | null>(null);

  const myPeerIdRef = useRef<string | null>(null);
  const peerOpenRef = useRef(false);
  const knownPeersRef = useRef<Set<string>>(new Set());
  const localStreamRef = useRef<MediaStream | null>(null);

  // Keep ref in sync with the prop
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  // ── Remote stream helpers ──
  const addRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    setRemoteStreams((prev) => {
      if (prev.some((p) => p.peerId === peerId)) {
        return prev.map((p) => (p.peerId === peerId ? { peerId, stream } : p));
      }
      return [...prev, { peerId, stream }];
    });
  }, []);

  const removeRemoteStream = useCallback((peerId: string) => {
    setRemoteStreams((prev) => prev.filter((p) => p.peerId !== peerId));
  }, []);

  // ── Wire up call event handlers (shared by outgoing & incoming calls) ──
  const wireCallEvents = useCallback(
    (call: MediaConnection, remotePeerId: string) => {
      call.on("stream", (remoteStream) => {
        addRemoteStream(remotePeerId, remoteStream);
      });

      call.on("close", () => {
        // Only clean up if this call is still the active one for this peer
        if (callsRef.current.get(remotePeerId) === call) {
          callsRef.current.delete(remotePeerId);
          removeRemoteStream(remotePeerId);
        }
      });

      call.on("error", (err) => {
        console.warn(`[PeerJS] call error with ${remotePeerId}:`, err);
        if (callsRef.current.get(remotePeerId) === call) {
          callsRef.current.delete(remotePeerId);
          removeRemoteStream(remotePeerId);
        }
      });
    },
    [addRemoteStream, removeRemoteStream],
  );

  // ── Call a remote peer with our local A/V stream (or empty stream) ──
  const callPeer = useCallback(
    (remotePeerId: string) => {
      const peer = peerRef.current;
      if (!peer || !peerOpenRef.current) return;
      if (callsRef.current.has(remotePeerId)) return;
      if (callsRef.current.size >= MAX_PEERS - 1) return;

      const stream = localStreamRef.current ?? new MediaStream();
      console.debug(`[PeerJS] calling ${remotePeerId}`);
      const call = peer.call(remotePeerId, stream);
      callsRef.current.set(remotePeerId, call);
      wireCallEvents(call, remotePeerId);
    },
    [wireCallEvents],
  );

  // ── Initialize PeerJS + Socket.IO peer discovery ──
  // PeerJS initializes independently of localStream so participants can
  // discover each other and receive remote video even without a camera.
  useEffect(() => {
    if (!socket || !presentationId) return;

    const { host: peerHost, port: peerPort, secure: peerSecure } = resolvePeerConfig();
    const iceServers = buildIceServers();

    const peer = new Peer(undefined as unknown as string, {
      host: peerHost,
      port: peerPort,
      path: "/peerjs",
      key: "openzigs",
      secure: peerSecure,
      debug: 2,
      config: {
        iceServers,
        iceCandidatePoolSize: 10,
        sdpSemantics: "unified-plan",
      },
    });
    peerRef.current = peer;

    peer.on("open", (myPeerId) => {
      console.debug(`[PeerJS] open as ${myPeerId} via ${peerSecure ? "wss" : "ws"}://${peerHost}:${peerPort}`);
      myPeerIdRef.current = myPeerId;
      peerOpenRef.current = true;
      socket.emit("room:announce_peer", { presentationId, peerId: myPeerId });

      // Call any peers discovered before PeerJS was ready (race-condition fix)
      for (const pid of knownPeersRef.current) {
        if (!callsRef.current.has(pid)) {
          callPeer(pid);
        }
      }
    });

    peer.on("error", (err) => {
      console.warn("[PeerJS] error:", err.type, err.message);
    });

    peer.on("disconnected", () => {
      console.warn("[PeerJS] disconnected, attempting reconnect");
      if (!peer.destroyed) peer.reconnect();
    });

    // Accept incoming calls — answer with local stream or empty stream
    peer.on("call", (call) => {
      console.debug(`[PeerJS] incoming call from ${call.peer}`);
      call.answer(localStreamRef.current ?? new MediaStream());
      callsRef.current.set(call.peer, call);
      wireCallEvents(call, call.peer);
    });

    // Socket.IO peer discovery
    const onPeersUpdated = (data: { peerIds: string[] }) => {
      const myId = myPeerIdRef.current;
      const remotePeers = data.peerIds.filter((pid) => pid !== myId);
      setPeerIds(remotePeers);

      for (const pid of remotePeers) {
        if (!knownPeersRef.current.has(pid)) {
          knownPeersRef.current.add(pid);
          callPeer(pid);
        }
      }

      const currentSet = new Set(remotePeers);
      for (const known of knownPeersRef.current) {
        if (!currentSet.has(known)) {
          knownPeersRef.current.delete(known);
          const call = callsRef.current.get(known);
          if (call) {
            call.close();
            callsRef.current.delete(known);
          }
          removeRemoteStream(known);
        }
      }
    };

    const onTranscriptionPreview = (data: { text: string }) => {
      setTranscriptionPreview(data.text);
      setIsTranscribing(false);
    };

    socket.on("room:peers_updated", onPeersUpdated);
    socket.on("room:transcription_preview", onTranscriptionPreview);

    return () => {
      socket.off("room:peers_updated", onPeersUpdated);
      socket.off("room:transcription_preview", onTranscriptionPreview);

      for (const call of callsRef.current.values()) {
        call.close();
      }
      callsRef.current.clear();
      knownPeersRef.current.clear();
      peerOpenRef.current = false;
      setRemoteStreams([]);
      setPeerIds([]);

      peer.destroy();
      peerRef.current = null;
      myPeerIdRef.current = null;
    };
  }, [socket, presentationId, callPeer, wireCallEvents, removeRemoteStream]);

  // ── Replace tracks in existing calls when localStream changes ──
  useEffect(() => {
    if (!localStream) return;
    for (const call of callsRef.current.values()) {
      const pc = call.peerConnection;
      if (!pc) continue;
      for (const sender of pc.getSenders()) {
        const newTrack = localStream.getTracks().find(
          (t) => t.kind === sender.track?.kind || (!sender.track && t.kind),
        );
        if (newTrack) {
          sender.replaceTrack(newTrack).catch(() => { /* best effort */ });
        }
      }
    }
  }, [localStream]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMuted(!track.enabled);
  }, []);

  const raiseHand = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || !socket) return;

    stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    setIsMuted(false);
    setIsRaisingHand(true);
    setTranscriptionPreview(null);

    try {
      // Record only audio for STT — create an audio-only stream from the local stream's audio tracks
      const audioOnly = new MediaStream(stream.getAudioTracks());
      const recorder = new MediaRecorder(audioOnly, {
        mimeType: "audio/webm;codecs=opus",
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          event.data.arrayBuffer().then((buf) => {
            socket.emit("room:audio_chunk", {
              presentationId,
              blob: buf,
            });
            setIsTranscribing(true);
          });
        }
      };

      recorder.start(3000);
    } catch {
      // MediaRecorder not supported
    }
  }, [socket, presentationId]);

  const lowerHand = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;

    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    }
    setIsMuted(true);
    setIsRaisingHand(false);
  }, []);

  const cleanup = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;

    for (const call of callsRef.current.values()) {
      call.close();
    }
    callsRef.current.clear();

    const peer = peerRef.current;
    if (peer) {
      peer.destroy();
      peerRef.current = null;
    }

    setRemoteStreams([]);
    setPeerIds([]);
  }, []);

  useEffect(() => {
    return () => { cleanup(); };
  }, [cleanup]);

  return {
    peerIds,
    remoteStreams,
    isMuted,
    isRaisingHand,
    isTranscribing,
    transcriptionPreview,
    toggleMic,
    raiseHand,
    lowerHand,
    cleanup,
  };
}
