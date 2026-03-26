/**
 * VoiceLabPanel — Issue #272 (SI-4)
 *
 * Admin panel for Voice Lab: engine toggle, Kokoro preset browser,
 * and F5-TTS voice profile management (create, list, test, delete).
 *
 * Layout:
 *   Left column:  EngineToggle + Kokoro voice preset grid
 *   Right column: F5-TTS voice profiles with upload + CRUD
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, fetchWithAuth } from "@/lib/api";
import { showToast } from "@/components/toast";
import { EngineToggle } from "./engine-toggle";
import {
  Trash2,
  Play,
  Plus,
  Upload,
  Volume2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Square,
  Mic,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type KokoroVoice = {
  id: string;
  language: string;
  gender: string;
  style: string;
};

// ── F5-TTS Types ─────────────────────────────────────────────────────────────

type F5TTSClip = {
  id: string;
  profile_id: string;
  emotion: string;
  ref_audio_path: string;
  ref_text: string;
  sort_order: number;
  created_at: string;
};

type F5TTSProfileRow = {
  id: string;
  name: string;
  engine_type: string;
  created_at: string;
  clips: F5TTSClip[];
};

function parseApiErrorText(raw: string): string {
  const fallback = raw.trim() || "Request failed.";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    const rec = parsed as Record<string, unknown>;
    const first = rec.error ?? rec.detail ?? rec.message;
    if (typeof first === "string") {
      const nested = parseApiErrorText(first);
      if (nested) {
        return nested;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KokoroPresetGrid() {
  const [filter, setFilter] = useState<"all" | "Female" | "Male">("all");
  const [playingId, setPlayingId] = useState<string | null>(null);

  const voicesQuery = useQuery({
    queryKey: ["kokoro-voices"],
    queryFn: () => fetchJson<{ voices: KokoroVoice[]; default: string }>("/api/admin/audio/voices"),
    staleTime: Infinity,
    retry: false,
  });

  const voices = voicesQuery.data?.voices ?? [];
  const filtered = filter === "all" ? voices : voices.filter((v) => v.gender === filter);

  const handlePreview = async (voiceId: string) => {
    if (playingId === voiceId) return;
    setPlayingId(voiceId);
    try {
      const res = await fetchWithAuth(`/api/voice/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello, this is a voice preview.", voice: voiceId }),
      });
      if (!res.ok) {
        showToast("Preview failed — is the sidecar running?", "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        setPlayingId(null);
        URL.revokeObjectURL(url);
      };
      void audio.play();
    } catch {
      showToast("Preview failed.", "error");
      setPlayingId(null);
    }
  };

  if (voicesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground animate-pulse">Loading voice presets…</p>;
  }
  if (voicesQuery.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Voice presets unavailable — start the audio sidecar first.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Kokoro Voice Presets ({voices.length})
        </span>
        <div className="flex gap-1">
          {(["all", "Female", "Male"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs transition-colors",
                filter === f
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-1">
        {filtered.map((v) => (
          <button
            key={v.id}
            onClick={() => void handlePreview(v.id)}
            className={cn(
              "flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-left text-xs transition-all hover:border-primary/30 hover:bg-primary/4",
              playingId === v.id && "border-primary/40 bg-primary/8",
            )}
          >
            <div>
              <p className="font-medium text-foreground">{v.id}</p>
              <p className="text-muted-foreground">{v.style}</p>
            </div>
            <Volume2
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                playingId === v.id && "text-primary animate-pulse",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── F5-TTS Profile Section ───────────────────────────────────────────────────

const F5TTS_REF_AUDIO_MAX_SECONDS = 15;

function getAudioDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration);
    });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read audio duration"));
    });
  });
}

function F5TTSClipCard({
  clip,
  onDeleted,
}: {
  clip: F5TTSClip;
  onDeleted: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/audio/f5tts/clips/${clip.id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast(`Clip "${clip.emotion}" deleted.`, "success");
      onDeleted();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handlePlayRef = async () => {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
      return;
    }
    try {
      const res = await fetchWithAuth(`/api/admin/audio/f5tts/clips/${clip.id}/audio`);
      if (!res.ok) {
        showToast("Could not load reference audio.", "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null; };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null; };
      setPlaying(true);
      void audio.play();
    } catch {
      showToast("Playback failed.", "error");
      setPlaying(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => void handlePlayRef()}
          title={playing ? "Stop" : "Play reference audio"}
          className="rounded-md border border-border p-1 transition-all hover:border-primary/30 hover:bg-primary/5 shrink-0"
        >
          {playing ? <Square className="h-3 w-3 text-primary" /> : <Play className="h-3 w-3 text-muted-foreground" />}
        </button>
        <div className="min-w-0">
          <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {clip.emotion}
          </span>
          <p className="mt-0.5 text-[11px] text-muted-foreground truncate" title={clip.ref_text}>
            {clip.ref_text || "(no transcript)"}
          </p>
        </div>
      </div>
      <button
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
        title="Remove clip"
        className="rounded-lg border border-border p-1 transition-all hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

function F5TTSAddClipForm({
  profileId,
  onAdded,
}: {
  profileId: string;
  onAdded: () => void;
}) {
  const [emotion, setEmotion] = useState("Regular");
  const [refText, setRefText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const duration = await getAudioDurationSeconds(file);
      if (duration > F5TTS_REF_AUDIO_MAX_SECONDS) {
        showToast(`Audio is ${Math.round(duration)}s — max ${F5TTS_REF_AUDIO_MAX_SECONDS}s for F5-TTS.`, "error");
        return;
      }
      const arrayBuffer = await file.arrayBuffer();
      const res = await fetchWithAuth("/api/admin/audio/upload/f5tts-ref-audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: arrayBuffer,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(parseApiErrorText(errText));
      }
      const data = (await res.json()) as { filePath: string };
      setUploadedPath(data.filePath);
      showToast("Reference audio uploaded!", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed.", "error");
    } finally {
      setUploading(false);
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") return;
    mediaRecorderRef.current.stop();
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (uploading || isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordingChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          showToast("Recording is empty. Try again.", "error");
          setIsRecording(false);
          setRecordingSeconds(0);
          mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
          return;
        }
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `f5tts-clip-${emotion}-${Date.now()}.${ext}`, { type: blob.type });
        void handleUpload(file);
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setIsRecording(false);
        setRecordingSeconds(0);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => {
          const next = s + 1;
          if (next >= F5TTS_REF_AUDIO_MAX_SECONDS) {
            showToast(`Auto-stopped at ${F5TTS_REF_AUDIO_MAX_SECONDS}s.`, "success");
            stopRecording();
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      showToast(`Mic access failed: ${String(err)}`, "error");
    }
  };

  const addMutation = useMutation({
    mutationFn: (body: { emotion: string; ref_audio_path: string; ref_text: string }) =>
      fetchJson(`/api/admin/audio/f5tts/profiles/${profileId}/clips`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      showToast(`Clip "${emotion}" added!`, "success");
      setEmotion("Regular");
      setRefText("");
      setUploadedPath(null);
      void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] });
      onAdded();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emotion.trim()) {
      showToast("Emotion label is required.", "error");
      return;
    }
    if (!uploadedPath) {
      showToast("Upload or record a reference audio clip first.", "error");
      return;
    }
    if (!refText.trim()) {
      showToast("Transcript is required — type exactly what you said in the recording.", "error");
      return;
    }
    addMutation.mutate({ emotion: emotion.trim(), ref_audio_path: uploadedPath, ref_text: refText.trim() });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Add Emotion Clip</p>

      <div>
        <label className="block text-[11px] text-muted-foreground mb-0.5">Emotion Label</label>
        <input
          type="text"
          placeholder="e.g. Regular, Excited, Whisper"
          value={emotion}
          onChange={(e) => setEmotion(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          required
        />
      </div>

      <div>
        <label className="block text-[11px] text-muted-foreground mb-0.5">Reference Audio</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/wav,audio/mp3,audio/mpeg,audio/ogg,.wav,.mp3,.ogg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUpload(f);
            e.target.value = "";
          }}
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || isRecording}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded-lg border border-dashed border-border py-1.5 text-[11px] text-muted-foreground transition-all hover:border-primary/40",
              (uploading || isRecording) && "opacity-50",
              uploadedPath && "border-emerald-500/40 text-emerald-600",
            )}
          >
            <Upload className="h-3 w-3" />
            {uploading ? "Uploading…" : uploadedPath ? "✓ Uploaded" : "Upload .wav/.mp3"}
          </button>
          <button
            type="button"
            onClick={() => (isRecording ? stopRecording() : void startRecording())}
            disabled={uploading}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-all",
              isRecording
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-foreground hover:border-primary/30 hover:bg-primary/5",
              uploading && "cursor-not-allowed opacity-50",
            )}
          >
            {isRecording ? <Square className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
            {isRecording ? `Stop (${recordingSeconds}s)` : "Record"}
          </button>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground/60">Max {F5TTS_REF_AUDIO_MAX_SECONDS}s · record 3–10s of natural speech</p>
      </div>

      <div>
        <label className="block text-[11px] text-muted-foreground mb-0.5">
          Reference Transcript <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          placeholder="Exact words you said in the recording…"
          value={refText}
          onChange={(e) => setRefText(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          required
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground/60">Required — F5-TTS needs the transcript to estimate output duration correctly.</p>
      </div>

      <button
        type="submit"
        disabled={addMutation.isPending || !uploadedPath}
        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {addMutation.isPending ? "Adding…" : "Add Clip"}
      </button>
    </form>
  );
}

function F5TTSProfileCard({
  profile,
  onDeleted,
}: {
  profile: F5TTSProfileRow;
  onDeleted: () => void;
}) {
  const hasClips = profile.clips.length > 0;
  const [expanded, setExpanded] = useState(!hasClips);
  const [testing, setTesting] = useState(false);
  const [testText, setTestText] = useState("Hello, this is an F5-TTS voice test.");
  const [speed, setSpeed] = useState(1.0);
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/audio/f5tts/profiles/${profile.id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast(`Profile "${profile.name}" deleted.`, "success");
      void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] });
      onDeleted();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleTest = async () => {
    if (testing) return;
    if (profile.clips.length === 0) {
      showToast("Add at least one clip first.", "error");
      return;
    }
    setTesting(true);
    try {
      const res = await fetchWithAuth(`/api/admin/audio/f5tts/profiles/${profile.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testText, speed }),
      });
      if (!res.ok) {
        const errText = await res.text();
        showToast(parseApiErrorText(errText), "error");
        setTesting(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setTesting(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setTesting(false);
      };
      void audio.play();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Synthesis failed.", "error");
      setTesting(false);
    }
  };

  const emotions = profile.clips.map((c) => c.emotion);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 min-w-0 text-left"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{profile.name}</p>
            <p className="text-xs text-muted-foreground">
              {hasClips
                ? `${profile.clips.length} clip${profile.clips.length !== 1 ? "s" : ""} · ${emotions.join(", ")}`
                : "No clips yet — add one to get started"}
            </p>
          </div>
        </button>
        <button
          onClick={() => {
            if (confirm(`Delete profile "${profile.name}" and all its clips?`)) {
              deleteMutation.mutate();
            }
          }}
          title="Delete profile"
          disabled={deleteMutation.isPending}
          className="rounded-lg border border-border p-1.5 transition-all hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-50 shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2.5 space-y-3">
          {/* Clips list */}
          {hasClips && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Reference Clips</p>
              {profile.clips.map((clip) => (
                <F5TTSClipCard
                  key={clip.id}
                  clip={clip}
                  onDeleted={() => void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] })}
                />
              ))}
            </div>
          )}

          {/* Add clip form — always visible when expanded */}
          <F5TTSAddClipForm
            profileId={profile.id}
            onAdded={() => void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] })}
          />

          {/* Try Voice — only when clips exist */}
          {hasClips && (
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Try Voice</p>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder="Type something to hear the cloned voice say it…"
                  className="flex-1 rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={() => void handleTest()}
                  disabled={testing || !hasClips}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                    testing
                      ? "bg-primary/20 text-primary animate-pulse"
                      : "bg-primary text-primary-foreground hover:bg-primary/90",
                    "disabled:opacity-50",
                  )}
                >
                  {testing ? "Generating…" : "Speak"}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/60">
                Use emotion tags like <code className="text-[10px]">(Excited)</code> or <code className="text-[10px]">(Whisper)</code> before text segments.
                First run loads the model (~10s).
              </p>
              {/* Speed control */}
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-foreground whitespace-nowrap w-20">Speed: {speed.toFixed(2)}</label>
                <input
                  type="range"
                  min={0.25}
                  max={2.0}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  className="flex-1 h-1 accent-primary"
                />
                <span className="text-[10px] text-muted-foreground/60 w-14 text-right">
                  {speed < 0.8 ? "slower" : speed > 1.2 ? "faster" : "natural"}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function F5TTSSection() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const profilesQuery = useQuery({
    queryKey: ["f5tts-profiles"],
    queryFn: () => fetchJson<{ profiles: F5TTSProfileRow[] }>("/api/admin/audio/f5tts/profiles"),
    refetchInterval: 30_000,
  });

  const profiles = profilesQuery.data?.profiles ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      fetchJson<F5TTSProfileRow>("/api/admin/audio/f5tts/profiles", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      showToast("F5-TTS profile created!", "success");
      setNewName("");
      setShowCreate(false);
      void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      showToast("Profile name required.", "error");
      return;
    }
    createMutation.mutate(newName.trim());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            F5-TTS Profiles · Engine C ({profiles.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => void profilesQuery.refetch()}
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", profilesQuery.isFetching && "animate-spin")} />
          </button>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-primary/30 hover:bg-primary/4 transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            New F5-TTS Profile
          </button>
        </div>
      </div>

      {showCreate && (
        <form onSubmit={handleCreateSubmit} className="flex gap-2 rounded-xl border border-border bg-card p-3">
          <input
            type="text"
            placeholder="Profile name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            required
          />
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      {profilesQuery.isLoading && (
        <p className="text-sm text-muted-foreground animate-pulse">Loading F5-TTS profiles…</p>
      )}

      {!profilesQuery.isLoading && profiles.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <Volume2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No F5-TTS profiles yet.</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Create a profile, then add emotion clips (Regular, Excited, Whisper, etc.) with reference audio for each.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {profiles.map((p) => (
          <F5TTSProfileCard
            key={p.id}
            profile={p}
            onDeleted={() => void queryClient.invalidateQueries({ queryKey: ["f5tts-profiles"] })}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export function VoiceLabPanel() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Left column: Engine + Kokoro presets ── */}
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-4">
            <EngineToggle />
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <KokoroPresetGrid />
          </div>
        </div>

        {/* ── Right column: F5-TTS Voice Profiles ── */}
        <div className="rounded-xl border border-border bg-card p-4">
          <F5TTSSection />
        </div>
      </div>
    </div>
  );
}
