"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, Square, Play, Pause, RotateCcw, Upload, Loader2 } from "lucide-react";

interface VoiceRecorderProps {
  onSave: (blob: Blob, name: string) => void;
  isSaving: boolean;
}

const SAMPLE_SCRIPTS = [
  "The quick brown fox jumps over the lazy dog, while the bright sun sets behind the rolling hills. I can feel the gentle breeze on my face as I walk through the meadow.",
  "Yesterday I went to the market and bought some fresh vegetables. The tomatoes were bright red and the cucumbers were perfectly green. It was a wonderful day for shopping.",
  "In a world of constant change, the only thing that remains certain is our ability to adapt. Every challenge we face becomes an opportunity for growth and discovery.",
];

const MAX_DURATION_S = 30;
const MIN_DURATION_S = 1;

export function VoiceRecorder({ onSave, isSaving }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [refName, setRefName] = useState("");
  const [scriptIdx, setScriptIdx] = useState(0);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [recordedUrl]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
      streamRef.current = stream;
      setPermissionDenied(false);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      mr.start(250); // collect data every 250ms
      setIsRecording(true);
      setDuration(0);

      // Timer for duration display + auto-stop at MAX_DURATION_S
      timerRef.current = setInterval(() => {
        setDuration((prev) => {
          const next = prev + 0.1;
          if (next >= MAX_DURATION_S) {
            mr.stop();
            setIsRecording(false);
            if (timerRef.current) clearInterval(timerRef.current);
          }
          return next;
        });
      }, 100);
    } catch {
      setPermissionDenied(true);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl(null);
    setDuration(0);
    setIsPlaying(false);
  }, [recordedUrl]);

  const togglePlayback = useCallback(() => {
    if (!audioRef.current || !recordedUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.src = recordedUrl;
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, recordedUrl]);

  const handleSave = useCallback(() => {
    if (!recordedBlob) return;
    if (duration < MIN_DURATION_S) return;
    onSave(recordedBlob, refName || `recording-${Date.now()}`);
  }, [recordedBlob, duration, refName, onSave]);

  const formattedDuration = `${Math.floor(duration)}s`;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <h4 className="mb-2 text-xs font-medium text-zinc-300">Record Voice Reference</h4>

      {/* Sample Script */}
      <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Sample Script (read aloud)
          </span>
          <button
            onClick={() => setScriptIdx((i) => (i + 1) % SAMPLE_SCRIPTS.length)}
            className="text-[10px] text-indigo-400 hover:text-indigo-300"
          >
            Different script
          </button>
        </div>
        <p className="text-xs leading-relaxed text-zinc-300">
          &ldquo;{SAMPLE_SCRIPTS[scriptIdx]}&rdquo;
        </p>
        <p className="mt-1.5 text-[10px] text-zinc-600">
          Seed-VC works best with 5-20s of clear speech. No background noise.
        </p>
      </div>

      {/* Hidden audio element */}
      <audio ref={audioRef} onEnded={() => setIsPlaying(false)} className="hidden" />

      {/* Recording Controls */}
      {!recordedBlob ? (
        <div className="flex flex-col items-center gap-2">
          {permissionDenied && (
            <p className="text-xs text-red-400">Microphone access denied. Check browser permissions.</p>
          )}
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
              isRecording
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-indigo-600 text-white hover:bg-indigo-500"
            }`}
          >
            {isRecording ? (
              <>
                <Square className="h-4 w-4" />
                Stop ({formattedDuration} / {MAX_DURATION_S}s)
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                Start Recording
              </>
            )}
          </button>
          {isRecording && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="text-xs text-red-400">Recording...</span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Playback / Reset */}
          <div className="flex items-center gap-2">
            <button
              onClick={togglePlayback}
              className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? "Pause" : "Preview"}
            </button>
            <span className="text-xs text-zinc-500">{formattedDuration}</span>
            <button
              onClick={reset}
              className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Re-record
            </button>
          </div>

          {duration < MIN_DURATION_S && (
            <p className="text-xs text-amber-400">Recording too short (min {MIN_DURATION_S}s)</p>
          )}

          {/* Name + Save */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={refName}
              onChange={(e) => setRefName(e.target.value)}
              placeholder="Reference name (optional)"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
            />
            <button
              onClick={handleSave}
              disabled={isSaving || duration < MIN_DURATION_S}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSaving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              Save Reference
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
