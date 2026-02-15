/**
 * VoiceControls — Mic toggle + Speaker toggle + state indicator
 * Issue #231: Chat header integration for voice interface
 */

"use client";

import { useCallback, useRef, useState } from "react";
import { Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceIndicator } from "./voice-indicator";
import { VoiceAudioPlayer, type VoiceAudioPlayerHandle } from "./voice-audio-player";
import { useWakeWord } from "@/lib/hooks/use-wake-word";
import { cn } from "@/lib/utils";

interface VoiceControlsProps {
  /** Called when a voice query is captured (after silence timeout) */
  onQueryCaptured?: (query: string) => void;
  /** Called when TTS should read text aloud (e.g. assistant response) */
  speakText?: string;
  className?: string;
}

export function VoiceControls({ onQueryCaptured, speakText, className }: VoiceControlsProps) {
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioRef = useRef<VoiceAudioPlayerHandle>(null);
  const lastSpokenRef = useRef<string | null>(null);
  const resumeMicAfterPlaybackRef = useRef(false);

  const { state, isSupported, isListening, startListening, stopListening } = useWakeWord({
    silenceTimeout: 5000,
    fuzzyThreshold: 0.7,
    onWakeDetected: () => {
      // Interrupt any playing audio when wake word detected
      audioRef.current?.stop();
    },
    onQueryCaptured: (query) => {
      console.log("[voice] VoiceControls received query:", JSON.stringify(query));
      onQueryCaptured?.(query);
    },
  });

  // Handle TTS for new assistant text
  const handleSpeak = useCallback((text: string) => {
    if (!ttsEnabled || !text || text === lastSpokenRef.current) return;
    lastSpokenRef.current = text;
    void audioRef.current?.speak(text);
  }, [ttsEnabled]);

  // Auto-speak when speakText changes
  if (speakText && speakText !== lastSpokenRef.current && ttsEnabled) {
    // We defer to avoid calling during render
    setTimeout(() => handleSpeak(speakText), 0);
  }

  const toggleMic = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const toggleTts = useCallback(() => {
    if (ttsEnabled) {
      audioRef.current?.stop();
    } else {
      // Mark current text as already spoken so enabling TTS
      // doesn't immediately replay the last assistant message
      lastSpokenRef.current = speakText ?? null;
    }
    setTtsEnabled((prev) => !prev);
  }, [ttsEnabled, speakText]);

  if (!isSupported) return null;

  const handlePlayStart = () => {
    setIsAudioPlaying(true);
    // Prevent the microphone from hearing the app's own TTS output.
    if (isListening) {
      resumeMicAfterPlaybackRef.current = true;
      stopListening();
    }
  };

  const handlePlayEnd = () => {
    setIsAudioPlaying(false);
    if (resumeMicAfterPlaybackRef.current) {
      resumeMicAfterPlaybackRef.current = false;
      startListening();
    }
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <VoiceIndicator state={state} />

      {/* Mic toggle */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-8 w-8 transition-colors",
          isListening && "text-blue-500 hover:text-blue-600",
          state === "ACTIVE" && "text-green-500 hover:text-green-600"
        )}
        onClick={toggleMic}
        title={isListening ? "Stop voice input" : "Start voice input (Hey Zigs)"}
      >
        {isListening ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
      </Button>

      {/* TTS toggle */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-8 w-8 transition-colors",
          ttsEnabled && "text-primary",
          isAudioPlaying && "text-green-500"
        )}
        onClick={toggleTts}
        title={ttsEnabled ? "Disable voice output" : "Enable voice output"}
      >
        {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
      </Button>

      <VoiceAudioPlayer
        ref={audioRef}
        onPlayStart={handlePlayStart}
        onPlayEnd={handlePlayEnd}
      />
    </div>
  );
}
