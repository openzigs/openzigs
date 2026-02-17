/**
 * useVoiceInput — React hook for push-to-talk voice transcription
 * Issue #265: Uses the local audio sidecar for STT, not browser SpeechRecognition
 *
 * Workflow:
 *   1. User holds button → startRecording()
 *   2. Browser MediaRecorder captures audio
 *   3. User releases button → stopRecording()
 *   4. Audio blob is sent to /api/voice/transcribe
 *   5. Transcription text is returned via onTranscript callback
 */

"use client";

import { useCallback, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

export type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

export type TranscriptionResult = {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
};

export type UseVoiceInputOptions = {
  /** Called when transcription completes */
  onTranscript?: (result: TranscriptionResult) => void;
  /** Called on error */
  onError?: (error: string) => void;
  /** Max recording duration in milliseconds (default: 120000 = 2 min) */
  maxDuration?: number;
  /** Audio MIME type to prefer (default: audio/webm) */
  mimeType?: string;
};

export type UseVoiceInputReturn = {
  state: VoiceInputState;
  isRecording: boolean;
  isTranscribing: boolean;
  /** Duration of current recording in seconds */
  recordingDuration: number;
  /** Start recording audio */
  startRecording: () => Promise<void>;
  /** Stop recording and transcribe */
  stopRecording: () => Promise<TranscriptionResult | null>;
  /** Cancel recording without transcribing */
  cancelRecording: () => void;
  /** Last error message */
  error: string | null;
};

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onTranscript, onError, maxDuration = 120000 } = options;

  const [state, setState] = useState<VoiceInputState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setRecordingDuration(0);
  }, []);

  const transcribeAudio = useCallback(
    async (blob: Blob): Promise<TranscriptionResult | null> => {
      setState("transcribing");
      try {
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");

        const headers: Record<string, string> = {};
        if (AUTH_TOKEN) {
          headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
        }

        const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
          method: "POST",
          headers,
          body: formData,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Transcription failed (${res.status}): ${errText}`);
        }

        const result = (await res.json()) as TranscriptionResult;
        onTranscript?.(result);
        setState("idle");
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setState("error");
        onError?.(message);
        return null;
      }
    },
    [onTranscript, onError],
  );

  const stopRecording = useCallback(async (): Promise<TranscriptionResult | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cleanup();
      return null;
    }

    return new Promise<TranscriptionResult | null>((resolve) => {
      recorder.onstop = async () => {
        const chunks = chunksRef.current;
        cleanup();

        if (chunks.length === 0) {
          setState("idle");
          resolve(null);
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType });
        const result = await transcribeAudio(blob);
        resolve(result);
      };

      recorder.stop();
    });
  }, [cleanup, transcribeAudio]);

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    cleanup();
    setState("idle");
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      // Determine supported MIME type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.start(250); // Collect data every 250ms
      startTimeRef.current = Date.now();
      setState("recording");

      // Duration tick
      durationTimerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);

      // Max duration safety
      maxDurationTimerRef.current = setTimeout(() => {
        void stopRecording();
      }, maxDuration);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === "NotAllowedError"
            ? "Microphone access denied"
            : err.message
          : String(err);
      setError(message);
      setState("error");
      onError?.(message);
    }
  }, [maxDuration, onError, stopRecording]);

  return {
    state,
    isRecording: state === "recording",
    isTranscribing: state === "transcribing",
    recordingDuration,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  };
}
