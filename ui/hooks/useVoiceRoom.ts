"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Peer from "peerjs";
import type { MediaConnection } from "peerjs";
import { useSocket } from "@/lib/socket-context";

const API_BASE =
  process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";

export interface UseVoiceRoomReturn {
  peers: string[];
  isMuted: boolean;
  isRaisingHand: boolean;
  isTranscribing: boolean;
  transcriptionPreview: string | null;
  toggleMic: () => void;
  raiseHand: () => void;
  lowerHand: () => void;
  cleanup: () => void;
}

export function useVoiceRoom(presentationId: string): UseVoiceRoomReturn {
  const { socket } = useSocket();

  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callsRef = useRef<Map<string, MediaConnection>>(new Map());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const [peers, setPeers] = useState<string[]>([]);
  const [isMuted, setIsMuted] = useState(true);
  const [isRaisingHand, setIsRaisingHand] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionPreview, setTranscriptionPreview] = useState<string | null>(null);

  const myPeerIdRef = useRef<string | null>(null);
  const knownPeersRef = useRef<Set<string>>(new Set());

  // Acquire mic once on mount — start muted
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Start muted
        stream.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        localStreamRef.current = stream;
      })
      .catch(() => {
        // Mic permission denied — voice features unavailable
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Helper: play a remote audio stream
  const playRemoteStream = useCallback((peerId: string, remoteStream: MediaStream) => {
    // Reuse or create an <audio> element
    let audio = audioElementsRef.current.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audioElementsRef.current.set(peerId, audio);
    }
    audio.srcObject = remoteStream;
    audio.play().catch(() => {});
  }, []);

  // Helper: call a remote peer
  const callPeer = useCallback(
    (remotePeerId: string) => {
      const peer = peerRef.current;
      const stream = localStreamRef.current;
      if (!peer || !stream || callsRef.current.has(remotePeerId)) return;

      const call = peer.call(remotePeerId, stream);
      callsRef.current.set(remotePeerId, call);

      call.on("stream", (remoteStream) => {
        playRemoteStream(remotePeerId, remoteStream);
      });

      call.on("close", () => {
        callsRef.current.delete(remotePeerId);
        const audio = audioElementsRef.current.get(remotePeerId);
        if (audio) {
          audio.srcObject = null;
          audioElementsRef.current.delete(remotePeerId);
        }
      });
    },
    [playRemoteStream],
  );

  // Initialize PeerJS client + Socket.IO peer discovery
  useEffect(() => {
    if (!socket || !presentationId) return;

    // Parse server URL for PeerJS
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
      if (stream) {
        call.answer(stream);
      } else {
        // Answer with empty stream to receive audio
        call.answer(new MediaStream());
      }

      callsRef.current.set(call.peer, call);

      call.on("stream", (remoteStream) => {
        playRemoteStream(call.peer, remoteStream);
      });

      call.on("close", () => {
        callsRef.current.delete(call.peer);
        const audio = audioElementsRef.current.get(call.peer);
        if (audio) {
          audio.srcObject = null;
          audioElementsRef.current.delete(call.peer);
        }
      });
    });

    // Socket.IO peer discovery
    const onPeersUpdated = (data: { peerIds: string[] }) => {
      const myId = myPeerIdRef.current;
      const remotePeers = data.peerIds.filter((pid) => pid !== myId);
      setPeers(remotePeers);

      // Call any new peers we haven't connected to yet
      for (const pid of remotePeers) {
        if (!knownPeersRef.current.has(pid)) {
          knownPeersRef.current.add(pid);
          callPeer(pid);
        }
      }

      // Remove stale peers from known set
      const currentSet = new Set(remotePeers);
      for (const known of knownPeersRef.current) {
        if (!currentSet.has(known)) {
          knownPeersRef.current.delete(known);
          const call = callsRef.current.get(known);
          if (call) {
            call.close();
            callsRef.current.delete(known);
          }
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

      // Clean up all calls
      for (const call of callsRef.current.values()) {
        call.close();
      }
      callsRef.current.clear();

      // Clean up audio elements
      for (const audio of audioElementsRef.current.values()) {
        audio.srcObject = null;
      }
      audioElementsRef.current.clear();

      knownPeersRef.current.clear();

      peer.destroy();
      peerRef.current = null;
      myPeerIdRef.current = null;
    };
  }, [socket, presentationId, callPeer, playRemoteStream]);

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

    // Unmute
    stream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    setIsMuted(false);
    setIsRaisingHand(true);
    setTranscriptionPreview(null);

    // Start MediaRecorder for STT chunks
    try {
      const recorder = new MediaRecorder(stream, {
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

      recorder.start(3000); // Chunk every 3 seconds
    } catch {
      // MediaRecorder not supported or mimeType not available
    }
  }, [socket, presentationId]);

  const lowerHand = useCallback(() => {
    // Stop MediaRecorder
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;

    // Mute
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
    }
    setIsMuted(true);
    setIsRaisingHand(false);
  }, []);

  const cleanup = useCallback(() => {
    // Stop recorder
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;

    // Stop local stream
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    // Close all calls
    for (const call of callsRef.current.values()) {
      call.close();
    }
    callsRef.current.clear();

    // Clean up audio elements
    for (const audio of audioElementsRef.current.values()) {
      audio.srcObject = null;
    }
    audioElementsRef.current.clear();

    // Destroy peer
    const peer = peerRef.current;
    if (peer) {
      peer.destroy();
      peerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    peers,
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
