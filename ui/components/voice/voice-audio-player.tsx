/**
 * VoiceAudioPlayer — Hidden audio element for TTS playback
 * Issue #231: Plays MP3 from /api/voice/speak, supports interrupt
 */

"use client";

import { useCallback, useRef, useState, useImperativeHandle, forwardRef } from "react";

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";

export interface VoiceAudioPlayerHandle {
  /** Play TTS for the given text */
  speak: (text: string) => Promise<void>;
  /** Stop current playback immediately */
  stop: () => void;
  /** Whether audio is currently playing */
  isPlaying: boolean;
}

interface VoiceAudioPlayerProps {
  /** Callback when playback starts */
  onPlayStart?: () => void;
  /** Callback when playback ends (naturally or via stop) */
  onPlayEnd?: () => void;
}

export const VoiceAudioPlayer = forwardRef<VoiceAudioPlayerHandle, VoiceAudioPlayerProps>(
  function VoiceAudioPlayer({ onPlayStart, onPlayEnd }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const blobUrlRef = useRef<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);

    const cleanup = useCallback(() => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }, []);

    const stop = useCallback(() => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      cleanup();
      setIsPlaying(false);
      onPlayEnd?.();
    }, [cleanup, onPlayEnd]);

    const speak = useCallback(async (text: string) => {
      // Stop any current playback
      stop();

      try {
        const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
        const res = await fetch(`${API_BASE}/api/voice/speak`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text }),
        });

        if (!res.ok) {
          console.warn("Voice TTS failed:", res.status, await res.text());
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        if (audioRef.current) {
          audioRef.current.src = url;
          audioRef.current.onended = () => {
            setIsPlaying(false);
            cleanup();
            onPlayEnd?.();
          };
          audioRef.current.onerror = () => {
            setIsPlaying(false);
            cleanup();
            onPlayEnd?.();
          };
          await audioRef.current.play();
          setIsPlaying(true);
          onPlayStart?.();
        }
      } catch (err) {
        console.warn("Voice TTS error:", err);
        setIsPlaying(false);
      }
    }, [stop, cleanup, onPlayStart, onPlayEnd]);

    useImperativeHandle(ref, () => ({ speak, stop, isPlaying }), [speak, stop, isPlaying]);

    return <audio ref={audioRef} className="hidden" />;
  }
);
