"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  MonitorUp,
  Square,
  Pause,
  Play,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Clock,
  Upload,
  AlertCircle,
  FolderPlus,
  Info,
} from "lucide-react";
import { showToast } from "@/components/toast";
import { fetchJson } from "@/lib/api";

type RecordingState =
  | "idle"
  | "requesting"
  | "recording"
  | "paused"
  | "stopped"
  | "uploading";

interface ScreenRecorderProps {
  onRecordingComplete?: (assetId: string, filename: string) => void;
}

export function ScreenRecorder({ onRecordingComplete }: ScreenRecorderProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [includeMic, setIncludeMic] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vuContextRef = useRef<AudioContext | null>(null);
  const vuAnalyserRef = useRef<AnalyserNode | null>(null);
  const vuAnimFrameRef = useRef<number>(0);
  const mixAudioContextRef = useRef<AudioContext | null>(null);
  const pausedElapsedRef = useRef(0);
  // Continuation support
  const priorChunksRef = useRef<Blob[]>([]);
  const isContinuingRef = useRef(false);
  const continuationElapsedRef = useRef(0);

  // ── VU Meter ──
  const [vuLevel, setVuLevel] = useState(0);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAllStreams();
      if (timerRef.current) clearInterval(timerRef.current);
      if (vuAnimFrameRef.current) cancelAnimationFrame(vuAnimFrameRef.current);
      if (vuContextRef.current) vuContextRef.current.close().catch(() => {});
      if (mixAudioContextRef.current)
        mixAudioContextRef.current.close().catch(() => {});
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAllStreams = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now() - pausedElapsedRef.current * 1000;
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 250);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Setup VU meter from audio stream
  const setupVuMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      vuContextRef.current = ctx;
      vuAnalyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVu = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setVuLevel(avg / 255);
        vuAnimFrameRef.current = requestAnimationFrame(updateVu);
      };
      updateVu();
    } catch {
      // Audio context not available — no VU meter
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setState("requesting");

    try {
      // Use simple boolean for audio — constraint objects can cause browsers to
      // silently skip audio capture in getDisplayMedia.  systemAudio is a top-level
      // DisplayMediaStreamOptions hint (Chrome 105+) for system-wide audio.
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: includeAudio,
        ...(includeAudio ? { systemAudio: "include" } : {}),
      } as DisplayMediaStreamOptions);

      // Warn when audio was requested but none captured (e.g. window/screen share
      // instead of tab share, or user un-checked "Share audio" in the dialog).
      if (
        includeAudio &&
        displayStream.getAudioTracks().length === 0 &&
        !includeMic
      ) {
        showToast(
          "No audio captured — try sharing a browser tab instead of a window, or enable Microphone.",
          "info",
        );
      }

      let combinedStream = displayStream;

      // Optionally add microphone — mix via Web Audio API so both audio sources
      // are combined into one track (MediaRecorder only records one audio track).
      if (includeMic) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const displayHasAudio = displayStream.getAudioTracks().length > 0;

          if (displayHasAudio) {
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            const displaySource = ctx.createMediaStreamSource(
              new MediaStream(displayStream.getAudioTracks()),
            );
            const micSource = ctx.createMediaStreamSource(micStream);
            displaySource.connect(dest);
            micSource.connect(dest);
            combinedStream = new MediaStream([
              ...displayStream.getVideoTracks(),
              ...dest.stream.getAudioTracks(),
            ]);
            mixAudioContextRef.current = ctx;
          } else {
            // No display audio — just add mic tracks to the stream
            combinedStream = new MediaStream([
              ...displayStream.getVideoTracks(),
              ...micStream.getAudioTracks(),
            ]);
          }
        } catch {
          showToast(
            "Microphone access denied — recording without mic.",
            "info",
          );
        }
      }

      streamRef.current = combinedStream;

      // Setup VU meter if we have audio
      const audioTracks = combinedStream.getAudioTracks();
      if (audioTracks.length > 0) {
        setupVuMeter(combinedStream);
      }

      // Choose format: prefer WebM VP9+Opus
      const mimeType = MediaRecorder.isTypeSupported(
        "video/webm;codecs=vp9,opus",
      )
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
          ? "video/webm;codecs=vp8,opus"
          : "video/webm";

      const recorder = new MediaRecorder(combinedStream, { mimeType });
      mediaRecorderRef.current = recorder;
      if (!isContinuingRef.current) {
        chunksRef.current = [];
      }
      isContinuingRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // Merge prior-session chunks (if continuing) with this session's chunks
        const allChunks = [...priorChunksRef.current, ...chunksRef.current];
        chunksRef.current = allChunks;
        priorChunksRef.current = [];
        const blob = new Blob(allChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(url);
        setState("stopped");
        stopTimer();
        stopAllStreams();
      };

      // Handle user stopping via browser UI
      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      });

      pausedElapsedRef.current = isContinuingRef.current
        ? continuationElapsedRef.current
        : 0;
      recorder.start(1000); // 1s timeslice
      setState("recording");
      startTimer();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to start screen capture";
      if (
        msg.includes("Permission denied") ||
        msg.includes("NotAllowedError")
      ) {
        setError(
          "Screen capture permission denied. On macOS, enable Screen Recording in System Settings → Privacy & Security.",
        );
      } else {
        setError(msg);
      }
      setState("idle");
      stopAllStreams();
    }
  }, [
    includeAudio,
    includeMic,
    previewUrl,
    setupVuMeter,
    startTimer,
    stopTimer,
    stopAllStreams,
  ]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      pausedElapsedRef.current = Math.floor(
        (Date.now() - startTimeRef.current) / 1000,
      );
      setState("paused");
      stopTimer();
    }
  }, [stopTimer]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      setState("recording");
      startTimer();
    }
  }, [startTimer]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
    if (vuAnimFrameRef.current) cancelAnimationFrame(vuAnimFrameRef.current);
    if (vuContextRef.current) vuContextRef.current.close().catch(() => {});
    if (mixAudioContextRef.current) {
      mixAudioContextRef.current.close().catch(() => {});
      mixAudioContextRef.current = null;
    }
  }, []);

  const discardRecording = useCallback(() => {
    chunksRef.current = [];
    priorChunksRef.current = [];
    isContinuingRef.current = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setElapsed(0);
    pausedElapsedRef.current = 0;
    setState("idle");
    setError(null);
  }, [previewUrl]);

  const continueRecording = useCallback(() => {
    // Stash the chunks from the previous session; new recording appends to them
    priorChunksRef.current = [...chunksRef.current];
    chunksRef.current = [];
    isContinuingRef.current = true;
    continuationElapsedRef.current = elapsed;
    // Revoke current preview — a new combined one is generated on next stop
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    startRecording();
  }, [elapsed, previewUrl, startRecording]);

  const uploadRecording = useCallback(async () => {
    if (chunksRef.current.length === 0) return;
    setState("uploading");

    try {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? ""}/api/studio/upload-recording`,
        {
          method: "POST",
          headers: {
            "Content-Type": "video/webm",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: blob,
        },
      );

      if (!response.ok) {
        const data = await response
          .json()
          .catch(() => ({ error: "Upload failed" }));
        throw new Error(
          (data as { error?: string }).error ??
            `Upload failed: ${response.status}`,
        );
      }

      const result = (await response.json()) as {
        assetId: string;
        filename: string;
      };
      showToast(`Recording saved: ${result.filename}`, "success");
      onRecordingComplete?.(result.assetId, result.filename);
      discardRecording();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      showToast(msg, "error");
      setState("stopped");
    }
  }, [onRecordingComplete, discardRecording]);

  /** Upload to gallery then create a new Draft with the recording as first scene */
  const saveRecordingToDraft = useCallback(async () => {
    if (chunksRef.current.length === 0) return;
    setState("uploading");

    try {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? ""}/api/studio/upload-recording`,
        {
          method: "POST",
          headers: {
            "Content-Type": "video/webm",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: blob,
        },
      );

      if (!response.ok) {
        const data = await response
          .json()
          .catch(() => ({ error: "Upload failed" }));
        throw new Error(
          (data as { error?: string }).error ??
            `Upload failed: ${response.status}`,
        );
      }

      const result = (await response.json()) as {
        assetId: string;
        filename: string;
      };

      // Fetch the asset to get the file path for the manifest
      const asset = await fetchJson<{
        file_path: string;
        duration_seconds: number | null;
      }>(`/api/queue/assets/${result.assetId}`);

      const fps = 30;
      const durationFrames = Math.round(
        (asset.duration_seconds ?? elapsed) * fps,
      );
      const manifest = {
        projectTitle: `Recording ${new Date().toLocaleDateString()}`,
        templateId: "highlight-16-9",
        composition: { width: 1920, height: 1080, fps },
        audioLayer: { music: null, voiceover: null },
        timeline: [
          {
            type: "video_clip",
            source: asset.file_path,
            startAtFrame: 0,
            duration: durationFrames,
            scriptText: "",
          },
        ],
      };

      const draft = await fetchJson<{ id: string }>(
        "/api/admin/director/drafts",
        {
          method: "POST",
          body: JSON.stringify({
            title: manifest.projectTitle,
            manifest,
            productionMode: "highlight",
          }),
        },
      );

      showToast(`Draft created! Opening editor…`, "success");
      onRecordingComplete?.(result.assetId, result.filename);
      discardRecording();

      // Navigate to draft studio
      window.location.href = `/director/studio/${draft.id}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create draft";
      showToast(msg, "error");
      setState("stopped");
    }
  }, [onRecordingComplete, discardRecording, elapsed]);

  // ── Keyboard Shortcuts ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key.toLowerCase()) {
        case "r":
          if (state === "idle") {
            e.preventDefault();
            startRecording();
          } else if (state === "recording" || state === "paused") {
            e.preventDefault();
            stopRecording();
          }
          break;
        case "p":
          if (state === "recording") {
            e.preventDefault();
            pauseRecording();
          } else if (state === "paused") {
            e.preventDefault();
            resumeRecording();
          }
          break;
        case "escape":
          if (state === "recording" || state === "paused") {
            e.preventDefault();
            stopRecording();
          } else if (state === "stopped") {
            e.preventDefault();
            discardRecording();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    state,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    discardRecording,
  ]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <div
      className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4"
      data-testid="screen-recorder"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorUp className="h-5 w-5 text-red-400" />
          <h3 className="text-sm font-semibold text-zinc-200">
            Screen Recorder
          </h3>
        </div>
        {state === "recording" && (
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs text-red-400 font-mono">
              {formatTime(elapsed)}
            </span>
          </div>
        )}
        {state === "paused" && (
          <div className="flex items-center gap-2">
            <Clock className="h-3 w-3 text-yellow-400" />
            <span className="text-xs text-yellow-400 font-mono">
              {formatTime(elapsed)}
            </span>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded bg-red-950/50 border border-red-800 p-3">
          <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Audio toggles (idle/requesting only) */}
      {(state === "idle" || state === "requesting") && (
        <div className="flex gap-3">
          <button
            onClick={() => setIncludeAudio(!includeAudio)}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
              includeAudio
                ? "bg-blue-600/20 text-blue-400 border border-blue-600/50"
                : "bg-zinc-800 text-zinc-500 border border-zinc-700"
            }`}
          >
            {includeAudio ? (
              <Volume2 className="h-3 w-3" />
            ) : (
              <VolumeX className="h-3 w-3" />
            )}
            System Audio
          </button>
          <button
            onClick={() => setIncludeMic(!includeMic)}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
              includeMic
                ? "bg-blue-600/20 text-blue-400 border border-blue-600/50"
                : "bg-zinc-800 text-zinc-500 border border-zinc-700"
            }`}
          >
            {includeMic ? (
              <Mic className="h-3 w-3" />
            ) : (
              <MicOff className="h-3 w-3" />
            )}
            Microphone
          </button>
        </div>
      )}

      {/* VU Meter (during recording) */}
      {(state === "recording" || state === "paused") && (
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all duration-75"
            style={{ width: `${Math.min(vuLevel * 100, 100)}%` }}
            data-testid="vu-meter"
          />
        </div>
      )}

      {/* Preview (stopped) */}
      {state === "stopped" && previewUrl && (
        <div className="rounded overflow-hidden bg-black">
          <video
            ref={videoRef}
            src={previewUrl}
            controls
            className="w-full max-h-48 object-contain"
          />
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2">
        {state === "idle" && (
          <button
            onClick={startRecording}
            className="flex-1 flex items-center justify-center gap-2 rounded bg-red-600 hover:bg-red-700 px-3 py-2 text-sm text-white font-medium transition"
            data-testid="start-recording"
          >
            <MonitorUp className="h-4 w-4" />
            Start Recording
          </button>
        )}

        {state === "requesting" && (
          <button
            disabled
            className="flex-1 flex items-center justify-center gap-2 rounded bg-zinc-700 px-3 py-2 text-sm text-zinc-400"
          >
            <div className="h-4 w-4 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
            Waiting for permission…
          </button>
        )}

        {state === "recording" && (
          <>
            <button
              onClick={pauseRecording}
              className="flex-1 flex items-center justify-center gap-2 rounded bg-yellow-600 hover:bg-yellow-700 px-3 py-2 text-sm text-white font-medium transition"
            >
              <Pause className="h-4 w-4" />
              Pause
            </button>
            <button
              onClick={stopRecording}
              className="flex items-center justify-center gap-2 rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-2 text-sm text-zinc-200 transition"
              data-testid="stop-recording"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          </>
        )}

        {state === "paused" && (
          <>
            <button
              onClick={resumeRecording}
              className="flex-1 flex items-center justify-center gap-2 rounded bg-green-600 hover:bg-green-700 px-3 py-2 text-sm text-white font-medium transition"
            >
              <Play className="h-4 w-4" />
              Resume
            </button>
            <button
              onClick={stopRecording}
              className="flex items-center justify-center gap-2 rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-2 text-sm text-zinc-200 transition"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          </>
        )}

        {state === "stopped" && (
          <>
            <button
              onClick={uploadRecording}
              className="flex-1 flex items-center justify-center gap-2 rounded bg-blue-600 hover:bg-blue-700 px-3 py-2 text-sm text-white font-medium transition"
              data-testid="upload-recording"
            >
              <Upload className="h-4 w-4" />
              Save to Gallery
            </button>
            <button
              onClick={saveRecordingToDraft}
              className="flex items-center justify-center gap-2 rounded bg-green-600 hover:bg-green-700 px-3 py-2 text-sm text-white font-medium transition"
              title="Create a new Draft project with this recording"
            >
              <FolderPlus className="h-4 w-4" />
              Save to Draft
            </button>
            <button
              onClick={continueRecording}
              className="flex items-center justify-center gap-2 rounded bg-yellow-600 hover:bg-yellow-700 px-3 py-2 text-sm text-white font-medium transition"
              title="Keep existing recording and append a new capture to it"
            >
              <MonitorUp className="h-4 w-4" />
              Continue
            </button>
            <button
              onClick={discardRecording}
              className="flex items-center justify-center gap-2 rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-2 text-sm text-zinc-200 transition"
            >
              Discard
            </button>
          </>
        )}

        {state === "uploading" && (
          <button
            disabled
            className="flex-1 flex items-center justify-center gap-2 rounded bg-zinc-700 px-3 py-2 text-sm text-zinc-400"
          >
            <div className="h-4 w-4 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
            Uploading…
          </button>
        )}
      </div>

      {/* Cross-window recording info */}
      {(state === "recording" || state === "paused") && (
        <div className="flex items-start gap-2 rounded bg-blue-950/50 border border-blue-800 p-2">
          <Info className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" />
          <p className="text-[10px] text-blue-300 leading-tight">
            Recording in another window? Use the browser&apos;s{" "}
            <strong>Stop Sharing</strong> button (in the tab bar or system tray)
            to stop. Keyboard shortcuts only work when this tab has focus.
          </p>
        </div>
      )}

      {/* macOS hint + Hotkeys */}
      {(state === "idle" || state === "recording" || state === "paused") && (
        <div className="space-y-1">
          {state === "idle" && (
            <p className="text-[10px] text-zinc-600 leading-tight">
              macOS: Enable Screen Recording in System Settings → Privacy &amp;
              Security for this browser.
            </p>
          )}
          <p className="text-[10px] text-zinc-600">
            <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
              R
            </kbd>{" "}
            {state === "idle" ? "Record" : "Stop"}
            {" · "}
            <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
              P
            </kbd>{" "}
            {state === "paused" ? "Resume" : "Pause"}
            {" · "}
            <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
              Esc
            </kbd>{" "}
            {state === "idle" ? "Discard" : "Stop"}
            {(state === "recording" || state === "paused") && (
              <span className="text-zinc-700"> (this tab only)</span>
            )}
          </p>
        </div>
      )}

      {/* Hidden canvas for frame extraction */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
