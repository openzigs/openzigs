"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface MediaDevicesState {
  /** The local MediaStream (video + audio), or null if not yet acquired. */
  stream: MediaStream | null;
  /** Whether the microphone track is muted. */
  isAudioMuted: boolean;
  /** Whether the camera track is disabled. */
  isVideoMuted: boolean;
  /** Error message if getUserMedia failed. */
  error: string | null;
  /** Whether media is currently being acquired. */
  isAcquiring: boolean;
}

export interface UseMediaDevicesReturn extends MediaDevicesState {
  toggleAudio: () => void;
  toggleVideo: () => void;
  /** Stop all tracks and release the stream. */
  releaseStream: () => void;
}

/**
 * Hook to acquire local camera + microphone via getUserMedia.
 * Users join muted (audio + video off) by default.
 * The stream is acquired once on mount and released on unmount.
 */
export function useMediaDevices(
  options: { video?: boolean; audio?: boolean } = { video: true, audio: true },
): UseMediaDevicesReturn {
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<MediaDevicesState>({
    stream: null,
    isAudioMuted: true,
    isVideoMuted: true,
    error: null,
    isAcquiring: false,
  });

  // Acquire media once on mount
  useEffect(() => {
    let cancelled = false;

    const acquire = async () => {
      setState((s) => ({ ...s, isAcquiring: true, error: null }));
      try {
        const constraints: MediaStreamConstraints = {
          video: options.video !== false ? { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" } : false,
          audio: options.audio !== false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // Start muted by default — disable all tracks
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
        stream.getVideoTracks().forEach((t) => { t.enabled = false; });

        streamRef.current = stream;
        setState({
          stream,
          isAudioMuted: true,
          isVideoMuted: true,
          error: null,
          isAcquiring: false,
        });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Media access denied";
        setState((s) => ({ ...s, error: msg, isAcquiring: false }));
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAudio = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setState((s) => ({ ...s, isAudioMuted: !track.enabled }));
  }, []);

  const toggleVideo = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setState((s) => ({ ...s, isVideoMuted: !track.enabled }));
  }, []);

  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState({
        stream: null,
        isAudioMuted: true,
        isVideoMuted: true,
        error: null,
        isAcquiring: false,
      });
    }
  }, []);

  return {
    ...state,
    toggleAudio,
    toggleVideo,
    releaseStream,
  };
}
