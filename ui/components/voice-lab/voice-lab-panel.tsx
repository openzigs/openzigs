/**
 * VoiceLabPanel — Issue #272 (SI-4)
 *
 * Admin panel for Voice Lab: engine toggle, Kokoro preset browser,
 * and GPT-SoVITS voice profile management (create, list, test, delete).
 *
 * Layout:
 *   Left column:  EngineToggle + Kokoro voice preset grid
 *   Right column: Voice profiles (Engine B) with upload + CRUD
 */

"use client";

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { EngineToggle } from "./engine-toggle";
import {
  Mic,
  Mic2,
  Trash2,
  Play,
  Plus,
  Upload,
  Volume2,
  Sliders,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type KokoroVoice = {
  id: string;
  language: string;
  gender: string;
  style: string;
};

type VoiceProfile = {
  id: string;
  name: string;
  ref_audio_path: string;
  ref_text: string;
  language: string;
  top_p: number;
  temperature: number;
  text_split_method: string;
  speed_factor: number;
  repetition_penalty: number;
  top_k: number;
  created_at: string;
};

type ProfileFormState = {
  name: string;
  ref_text: string;
  language: string;
  top_p: number;
  temperature: number;
  text_split_method: string;
  speed_factor: number;
  repetition_penalty: number;
  top_k: number;
  sample_steps: number;
};

const DEFAULT_FORM: ProfileFormState = {
  name: "",
  ref_text: "",
  language: "en",
  top_p: 0.8,
  temperature: 1.0,
  text_split_method: "cut5",
  speed_factor: 1.0,
  repetition_penalty: 1.35,
  top_k: 15,
  sample_steps: 32,
};

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
      const res = await fetch(`/api/voice/synthesize`, {
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

// ── Profile Form ─────────────────────────────────────────────────────────────

function ProfileForm({
  onSaved,
  uploadedPath,
}: {
  onSaved: () => void;
  uploadedPath: string | null;
}) {
  const [form, setForm] = useState<ProfileFormState>(DEFAULT_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: ProfileFormState & { ref_audio_path: string }) =>
      fetchJson<VoiceProfile>("/api/admin/audio/profiles", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      showToast("Voice profile created!", "success");
      setForm(DEFAULT_FORM);
      void queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
      onSaved();
    },
    onError: (err: Error) => showToast(err.message || "Create failed.", "error"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      showToast("Profile name is required.", "error");
      return;
    }
    if (!uploadedPath) {
      showToast("Upload a reference audio file first.", "error");
      return;
    }
    createMutation.mutate({ ...form, ref_audio_path: uploadedPath });
  };

  const SliderField = ({
    label,
    field,
    min,
    max,
    step,
    format,
  }: {
    label: string;
    field: keyof ProfileFormState;
    min: number;
    max: number;
    step: number;
    format?: (v: number) => string;
  }) => (
    <label className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">
          {format ? format(form[field] as number) : (form[field] as number).toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={form[field] as number}
        onChange={(e) => setForm((f) => ({ ...f, [field]: parseFloat(e.target.value) }))}
        className="w-full accent-primary"
      />
    </label>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Profile Name</label>
        <input
          type="text"
          placeholder="e.g. My Voice Clone"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Reference Transcript <span className="text-muted-foreground/60">(optional but improves quality)</span>
        </label>
        <textarea
          placeholder="Exact words spoken in the reference audio…"
          value={form.ref_text}
          onChange={(e) => setForm((f) => ({ ...f, ref_text: e.target.value }))}
          rows={2}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Language</label>
        <select
          value={form.language}
          onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="en">English</option>
          <option value="zh">Chinese</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="es">Spanish</option>
          <option value="it">Italian</option>
        </select>
      </div>

      {/* Advanced params toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-1"><Sliders className="h-3 w-3" /> Advanced Parameters</span>
        {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {showAdvanced && (
        <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
          <SliderField label="Top P" field="top_p" min={0.1} max={1.0} step={0.05} />
          <SliderField label="Temperature" field="temperature" min={0.1} max={2.0} step={0.05} />
          <SliderField label="Speed Factor" field="speed_factor" min={0.5} max={2.0} step={0.05} />
          <SliderField label="Repetition Penalty" field="repetition_penalty" min={1.0} max={2.0} step={0.05} />
          <SliderField label="Top K" field="top_k" min={1} max={50} step={1} format={(v) => String(Math.round(v))} />
          <SliderField label="Sample Steps" field="sample_steps" min={1} max={200} step={1} format={(v) => String(Math.round(v))} />
        </div>
      )}

      {uploadedPath && (
        <p className="text-xs text-emerald-500 truncate" title={uploadedPath}>
          ✓ Audio: {uploadedPath.split("/").pop()}
        </p>
      )}

      <button
        type="submit"
        disabled={createMutation.isPending}
        className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
      >
        {createMutation.isPending ? "Creating…" : "Create Profile"}
      </button>
    </form>
  );
}

// ── Profile Card ─────────────────────────────────────────────────────────────

function ProfileCard({ profile, onDeleted }: { profile: VoiceProfile; onDeleted: () => void }) {
  const [testing, setTesting] = useState(false);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/admin/audio/profiles/${profile.id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast(`Profile "${profile.name}" deleted.`, "success");
      onDeleted();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleTest = async () => {
    if (testing) {
      audio?.pause();
      setAudio(null);
      setTesting(false);
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(`/api/admin/audio/profiles/${profile.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello, this is a voice cloning test." }),
      });
      if (!res.ok) {
        const err = await res.text();
        showToast(err || "Test failed.", "error");
        setTesting(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      setAudio(a);
      a.onended = () => {
        setTesting(false);
        setAudio(null);
        URL.revokeObjectURL(url);
      };
      void a.play();
    } catch (err) {
      showToast(String(err), "error");
      setTesting(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{profile.name}</p>
        <p className="text-xs text-muted-foreground">
          {profile.language} · top_p={profile.top_p} · temp={profile.temperature} · speed={profile.speed_factor}
        </p>
        <p className="text-xs text-muted-foreground/70 truncate" title={profile.ref_audio_path}>
          {profile.ref_audio_path.split("/").pop() ?? profile.ref_audio_path}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={void handleTest}
          title={testing ? "Stop preview" : "Preview voice"}
          className={cn(
            "rounded-lg border border-border p-1.5 transition-all hover:border-primary/30",
            testing && "border-primary/40 bg-primary/8",
          )}
        >
          <Play className={cn("h-3.5 w-3.5", testing ? "text-primary" : "text-muted-foreground")} />
        </button>
        <button
          onClick={() => {
            if (confirm(`Delete profile "${profile.name}"?`)) {
              deleteMutation.mutate();
            }
          }}
          title="Delete profile"
          disabled={deleteMutation.isPending}
          className="rounded-lg border border-border p-1.5 transition-all hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      </div>
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export function VoiceLabPanel() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const profilesQuery = useQuery({
    queryKey: ["voice-profiles"],
    queryFn: () => fetchJson<{ profiles: VoiceProfile[]; total: number }>("/api/admin/audio/profiles"),
    refetchInterval: 30_000,
  });

  const profiles = profilesQuery.data?.profiles ?? [];

  const handleFileUpload = async (file: File) => {
    setUploading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const res = await fetch("/api/admin/audio/upload/ref-audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: arrayBuffer,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }
      const data = (await res.json()) as { filePath: string };
      setUploadedPath(data.filePath);
      showToast("Reference audio uploaded!", "success");
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      setUploading(false);
    }
  };

  const invalidateProfiles = () => {
    void queryClient.invalidateQueries({ queryKey: ["voice-profiles"] });
  };

  return (
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

      {/* ── Right column: Voice profiles (Engine B) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              Voice Profiles · Engine B ({profiles.length})
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
              New Profile
            </button>
          </div>
        </div>

        {showCreate && (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              New Voice Profile (GPT-SoVITS Engine B)
            </p>

            {/* Reference audio upload */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/wav,audio/mp3,audio/mpeg,audio/ogg,.wav,.mp3,.ogg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-4 text-sm text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/4",
                  uploading && "opacity-50",
                  uploadedPath && "border-emerald-500/40 bg-emerald-500/4",
                )}
              >
                <Upload className="h-4 w-4" />
                {uploading
                  ? "Uploading…"
                  : uploadedPath
                  ? "Replace reference audio"
                  : "Upload reference audio (.wav / .mp3)"}
              </button>
            </div>

            <ProfileForm
              onSaved={() => setShowCreate(false)}
              uploadedPath={uploadedPath}
            />
          </div>
        )}

        {/* Profile list */}
        {profilesQuery.isLoading && (
          <p className="text-sm text-muted-foreground animate-pulse">Loading profiles…</p>
        )}

        {!profilesQuery.isLoading && profiles.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <Mic className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No voice profiles yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Upload a reference audio and create a profile to clone a voice with GPT-SoVITS.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} onDeleted={invalidateProfiles} />
          ))}
        </div>
      </div>
    </div>
  );
}
