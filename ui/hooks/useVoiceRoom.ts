"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Peer from "peerjs";
import type { MediaConnection } from "peerjs";
import { useSocket } from "@/lib/socket-context";

const API_BASE =
  process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";

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

  // ── Call a remote peer with our local A/V stream ──
  const callPeer = useCallback(
    (remotePeerId: string) => {
      const peer = peerRef.current;
      const stream = localStreamRef.current;
      if (!peer || !stream || callsRef.current.has(remotePeerId)) return;
      if (callsRef.current.size >= MAX_PEERS - 1) return;

      const call = peer.call(remotePeerId, stream);
      callsRef.current.set(remotePeerId, call);

      call.on("stream", (remoteStream) => {
        addRemoteStream(remotePeerId, remoteStream);
      });

      call.on("close", () => {
        callsRef.current.delete(remotePeerId);
        removeRemoteStream(remotePeerId);
      });

      call.on("error", () => {
        callsRef.current.delete(remotePeerId);
        removeRemoteStream(remotePeerId);
      });
    },
    [addRemoteStream, removeRemoteStream],
  );

  // ── Initialize PeerJS + Socket.IO peer discovery ──
  useEffect(() => {
    if (!socket || !presentationId || !localStream) return;

    let peerHost: string;
    let peerPort: number;
    let peerSecure: boolean;
    try {
      const url = new URL(API_BASE);
      peerHost = url.hostname;
      peerPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      peerSecure = url.protocol === "https:";
    } catch {
      peerHost = window.location.hostname;
      peerPort = window.location.port ? Number(window.location.port) : 443;
      peerSecure = window.location.protocol === "https:";
    }

    const peer = new Peer(undefined as unknown as string, {
      host: peerHost,
      port: peerPort,
      path: "/peerjs",
      key: "openzigs",
      secure: peerSecure,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      },
    });
    peerRef.current = peer;

    peer.on("open", (myPeerId) => {
      myPeerIdRef.current = myPeerId;
      socket.emit("room:announce_peer", { presentationId, peerId: myPeerId });
    });

    // Accept incoming calls
    peer.on("call", (call) => {
      const stream = localStreamRef.current;
      call.answer(stream ?? new MediaStream());

      callsRef.current.set(call.peer, call);

      call.on("stream", (remoteStream) => {
        addRemoteStream(call.peer, remoteStream);
      });

      call.on("close", () => {
        callsRef.current.delete(call.peer);
        removeRemoteStream(call.peer);
      });

      call.on("error", () => {
        callsRef.current.delete(call.peer);
        removeRemoteStream(call.peer);
      });
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
      setRemoteStreams([]);
      setPeerIds([]);

      peer.destroy();
      peerRef.current = null;
      myPeerIdRef.current = null;
    };
  }, [socket, presentationId, localStream, callPeer, addRemoteStream, removeRemoteStream]);

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
