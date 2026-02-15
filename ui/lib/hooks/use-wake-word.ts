/**
 * useWakeWord — React hook for "Hey Zigs" wake word detection
 * Issue #230: Wake word state machine with fuzzy matching + keep-alive
 *
 * State machine:
 *   IDLE ──[startListening()]──> STANDBY
 *   STANDBY ──[wake word detected]──> ACTIVE
 *   ACTIVE ──[query captured OR silence timeout]──> STANDBY
 *   STANDBY|ACTIVE ──[stopListening()]──> IDLE
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ──

export type WakeWordState = "IDLE" | "STANDBY" | "ACTIVE";

export interface UseWakeWordOptions {
  /** Wake phrase to detect (default: "hey zigs") */
  wakePhrase?: string;
  /** Fuzzy match threshold (0-1, default: 0.7) */
  fuzzyThreshold?: number;
  /** Silence timeout in ms before returning to STANDBY (default: 5000) */
  silenceTimeout?: number;
  /** Callback when wake word detected */
  onWakeDetected?: () => void;
  /** Callback when query captured (after silence timeout) */
  onQueryCaptured?: (query: string) => void;
  /** Callback on state change */
  onStateChange?: (state: WakeWordState) => void;
}

export interface UseWakeWordReturn {
  /** Current state machine state */
  state: WakeWordState;
  /** Raw transcript from speech recognition */
  transcript: string;
  /** Whether the browser supports speech recognition */
  isSupported: boolean;
  /** Whether currently listening */
  isListening: boolean;
  /** Start listening (enter STANDBY) */
  startListening: () => void;
  /** Stop listening (return to IDLE) */
  stopListening: () => void;
  /** Reset transcript */
  resetTranscript: () => void;
}

// ── Wake Word Detection ──

const WAKE_VARIANTS = ["hey zigs", "hey zig", "hey sig", "hey sigs"];

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Similarity score between 0 and 1 based on Levenshtein distance.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Detect wake word in a transcript using exact + fuzzy matching.
 */
export function detectWakeWord(transcript: string, threshold: number = 0.7): boolean {
  const normalized = transcript.toLowerCase().trim();

  // Fast path: exact substring match
  for (const variant of WAKE_VARIANTS) {
    if (normalized.includes(variant)) {
      return true;
    }
  }

  // Fuzzy match: check consecutive word pairs
  const words = normalized.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    for (const variant of WAKE_VARIANTS) {
      if (levenshteinSimilarity(phrase, variant) >= threshold) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract the query portion after the wake word.
 */
export function extractQueryAfterWakeWord(transcript: string): string {
  const normalized = transcript.toLowerCase();

  for (const variant of WAKE_VARIANTS) {
    const index = normalized.indexOf(variant);
    if (index !== -1) {
      return transcript.slice(index + variant.length).trim();
    }
  }

  return "";
}

// ── SpeechRecognition Browser API ──

// Web Speech API types (browser-native, not all environments have these)
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// ── Hook ──

export function useWakeWord(options: UseWakeWordOptions = {}): UseWakeWordReturn {
  const {
    fuzzyThreshold = 0.7,
    silenceTimeout = 5000,
    onWakeDetected,
    onQueryCaptured,
    onStateChange,
  } = options;

  const [state, setState] = useState<WakeWordState>("IDLE");
  const [transcript, setTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);

  const stateRef = useRef<WakeWordState>("IDLE");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTranscriptRef = useRef("");
  const keepAliveRef = useRef(false);

  const SpeechRecognitionClass = getSpeechRecognition();
  const isSupported = SpeechRecognitionClass !== null;

  // Callbacks via refs to avoid stale closures
  const onWakeDetectedRef = useRef(onWakeDetected);
  const onQueryCapturedRef = useRef(onQueryCaptured);
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => { onWakeDetectedRef.current = onWakeDetected; }, [onWakeDetected]);
  useEffect(() => { onQueryCapturedRef.current = onQueryCaptured; }, [onQueryCaptured]);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);

  const transitionTo = useCallback((newState: WakeWordState) => {
    stateRef.current = newState;
    setState(newState);
    onStateChangeRef.current?.(newState);
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const startSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (stateRef.current === "ACTIVE") {
        const query = activeTranscriptRef.current.trim();
        if (query) {
          onQueryCapturedRef.current?.(query);
        }
        activeTranscriptRef.current = "";
        setTranscript("");
        transitionTo("STANDBY");
      }
    }, silenceTimeout);
  }, [silenceTimeout, clearSilenceTimer, transitionTo]);

  const createRecognition = useCallback(() => {
    if (!SpeechRecognitionClass) return null;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let fullTranscript = "";
      for (let i = 0; i < event.results.length; i++) {
        fullTranscript += event.results[i][0].transcript;
      }

      setTranscript(fullTranscript);

      if (stateRef.current === "STANDBY") {
        if (detectWakeWord(fullTranscript, fuzzyThreshold)) {
          onWakeDetectedRef.current?.();
          const remainder = extractQueryAfterWakeWord(fullTranscript);
          activeTranscriptRef.current = remainder;
          transitionTo("ACTIVE");
          if (remainder) {
            startSilenceTimer();
          }
        }
      } else if (stateRef.current === "ACTIVE") {
        // Accumulate the query after wake word
        const remainder = extractQueryAfterWakeWord(fullTranscript);
        activeTranscriptRef.current = remainder;
        startSilenceTimer();
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      // Keep-alive: restart if we're supposed to be listening
      if (keepAliveRef.current && (stateRef.current === "STANDBY" || stateRef.current === "ACTIVE")) {
        setTimeout(() => {
          if (keepAliveRef.current && stateRef.current !== "IDLE") {
            try {
              recognition.start();
              setIsListening(true);
            } catch {
              // Already started or browser refused
            }
          }
        }, 100);
      }
    };

    recognition.onerror = (event: { error: string }) => {
      // "no-speech" and "aborted" are expected during keep-alive
      if (event.error !== "no-speech" && event.error !== "aborted") {
        console.warn("SpeechRecognition error:", event.error);
      }
    };

    return recognition;
  }, [SpeechRecognitionClass, fuzzyThreshold, transitionTo, startSilenceTimer]);

  const startListening = useCallback(() => {
    if (!isSupported || stateRef.current !== "IDLE") return;

    const recognition = createRecognition();
    if (!recognition) return;

    recognitionRef.current = recognition;
    keepAliveRef.current = true;
    activeTranscriptRef.current = "";
    setTranscript("");

    try {
      recognition.start();
      setIsListening(true);
      transitionTo("STANDBY");
    } catch {
      // Browser may block without user gesture
    }
  }, [isSupported, createRecognition, transitionTo]);

  const stopListening = useCallback(() => {
    keepAliveRef.current = false;
    clearSilenceTimer();

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }

    setIsListening(false);
    setTranscript("");
    activeTranscriptRef.current = "";
    transitionTo("IDLE");
  }, [clearSilenceTimer, transitionTo]);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    activeTranscriptRef.current = "";
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      keepAliveRef.current = false;
      clearSilenceTimer();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Already stopped
        }
      }
    };
  }, [clearSilenceTimer]);

  return {
    state,
    transcript,
    isSupported,
    isListening,
    startListening,
    stopListening,
    resetTranscript,
  };
}
