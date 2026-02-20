"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import type { RemotePeer } from "@/hooks/useVoiceRoom";

/**
 * Host-only hook: mixes local mic + all remote peer audio streams
 * using the Web Audio API, then records the mix with MediaRecorder
 * and pipes chunks to the server via Socket.IO room:audio_chunk.
 *
 * This lets anyone in the room ask the AI a question and have
 * it transcribed — the host acts as the aggregation point.
 */
export function useVoicePipe(
  presentationId: string,
  isHost: boolean,
  isRecording: boolean,
  localStream: MediaStream | null,
  remoteStreams: RemotePeer[],
) {
  const { socket } = useSocket();
  const ctxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sourceNodesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [isActive, setIsActive] = useState(false);

  // Build / update the Web Audio graph whenever streams change
  useEffect(() => {
    if (!isHost || !isRecording || !localStream) return;

    // Create AudioContext lazily
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      ctxRef.current = ctx;
    }

    // Create destination node (outputs a combined MediaStream)
    if (!destRef.current || destRef.current.context !== ctx) {
      destRef.current = ctx.createMediaStreamDestination();
    }
    const dest = destRef.current;

    // Disconnect all old source nodes
    for (const [id, node] of sourceNodesRef.current) {
      try { node.disconnect(); } catch { /* already disconnected */ }
      sourceNodesRef.current.delete(id);
    }

    // Connect local mic
    if (localStream.getAudioTracks().length > 0) {
      const localSource = ctx.createMediaStreamSource(localStream);
      localSource.connect(dest);
      sourceNodesRef.current.set("__local__", localSource);
    }

    // Connect every remote peer's audio
    for (const rp of remoteStreams) {
      if (rp.stream.getAudioTracks().length > 0) {
        const source = ctx.createMediaStreamSource(rp.stream);
        source.connect(dest);
        sourceNodesRef.current.set(rp.peerId, source);
      }
    }

    return () => {
      for (const node of sourceNodesRef.current.values()) {
        try { node.disconnect(); } catch { /* ok */ }
      }
      sourceNodesRef.current.clear();
    };
  }, [isHost, isRecording, localStream, remoteStreams]);

  // Start/stop recording the mixed output
  useEffect(() => {
    if (!isHost || !isRecording || !socket || !destRef.current) {
      // Stop any existing recorder
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.stop();
      }
      recorderRef.current = null;
      setIsActive(false);
      return;
    }

    const mixedStream = destRef.current.stream;
    if (mixedStream.getAudioTracks().length === 0) return;

    try {
      const recorder = new MediaRecorder(mixedStream, {
        mimeType: "audio/webm;codecs=opus",
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.connected) {
          event.data.arrayBuffer().then((buf) => {
            socket.emit("room:audio_chunk", {
              presentationId,
              blob: buf,
            });
          });
        }
      };

      recorder.start(3000); // chunk every 3s
      setIsActive(true);
    } catch {
      setIsActive(false);
    }

    return () => {
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.stop();
      }
      recorderRef.current = null;
      setIsActive(false);
    };
  }, [isHost, isRecording, socket, presentationId]);

  // Teardown AudioContext on unmount
  useEffect(() => {
    return () => {
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "closed") {
        void ctx.close();
      }
      ctxRef.current = null;
      destRef.current = null;
    };
  }, []);

  const stopPipe = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    }
    recorderRef.current = null;
    setIsActive(false);
  }, []);

  return { isActive, stopPipe };
}
