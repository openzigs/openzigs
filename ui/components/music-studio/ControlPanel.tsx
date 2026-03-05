"use client";

import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Loader2, Send, SlidersHorizontal, Upload, Trash2, Mic, Play, Pause } from "lucide-react";
import { showToast } from "@/components/toast";

interface VoiceReference {
  id: string;
  name: string;
  duration: number;
  sample_rate?: number;
  created?: string;
}

interface ControlPanelProps {
  audioAssets: Array<{ id: string; filename: string; prompt?: string }>;
  onSubmit: (params: Voice2VoiceParams) => void;
  isProcessing: boolean;
}

export interface Voice2VoiceParams {
  source_asset_id: string;
  voice_reference_id: string;
  pitch_shift: number;
  diffusion_steps: number;
  f0_condition: boolean;
  vocal_volume: number;
  instrumental_volume: number;
  output_format: string;
}

export function ControlPanel({ audioAssets, onSubmit, isProcessing }: ControlPanelProps) {
  const queryClient = useQueryClient();
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [selectedRefId, setSelectedRefId] = useState("");
  const [pitchShift, setPitchShift] = useState(0);
  const [diffusionSteps, setDiffusionSteps] = useState(30);
  const [f0Condition, setF0Condition] = useState(true);
  const [vocalVolume, setVocalVolume] = useState(1.0);
  const [instrumentalVolume, setInstrumentalVolume] = useState(1.0);
  const [outputFormat, setOutputFormat] = useState("wav");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewRefId, setPreviewRefId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch voice references
  const { data: refsData, isLoading: refsLoading } = useQuery({
    queryKey: ["voice-references"],
    queryFn: () =>
      fetchJson<{ references: VoiceReference[] }>(
        "/api/admin/music-studio/voice-references"
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const voiceRefs = refsData?.references ?? [];

  // Upload mutation
  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("name", uploadName || file.name.replace(/\.[^.]+$/, ""));
      const apiBase =
        process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const res = await fetch(
        `${apiBase}/api/admin/music-studio/voice-references/upload`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      return res.json() as Promise<VoiceReference>;
    },
    onSuccess: (ref) => {
      showToast(`Voice reference "${ref.name}" uploaded`, "success");
      setSelectedRefId(ref.id);
      setUploadName("");
      queryClient.invalidateQueries({ queryKey: ["voice-references"] });
    },
    onError: (err) => {
      showToast(
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    },
  });

  // Delete mutation
  const deleteMut = useMutation({
    mutationFn: async (refId: string) => {
      await fetchJson(`/api/admin/music-studio/voice-references/${refId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      showToast("Voice reference deleted", "success");
      setSelectedRefId("");
      queryClient.invalidateQueries({ queryKey: ["voice-references"] });
    },
  });

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadMut.mutate(file);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadMut]
  );

  const togglePreview = useCallback(
    (refId: string) => {
      if (previewRefId === refId) {
        audioRef.current?.pause();
        setPreviewRefId(null);
        return;
      }
      setPreviewRefId(refId);
      const apiBase =
        process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
      if (audioRef.current) {
        audioRef.current.src = `${apiBase}/api/admin/music-studio/voice-references/${refId}/audio`;
        audioRef.current.play().catch(() => {});
      }
    },
    [previewRefId]
  );

  const handleSubmit = useCallback(() => {
    if (!sourceAssetId) {
      showToast("Select a source audio track", "error");
      return;
    }
    if (!selectedRefId) {
      showToast("Select or upload a voice reference", "error");
      return;
    }

    onSubmit({
      source_asset_id: sourceAssetId,
      voice_reference_id: selectedRefId,
      pitch_shift: pitchShift,
      diffusion_steps: diffusionSteps,
      f0_condition: f0Condition,
      vocal_volume: vocalVolume,
      instrumental_volume: instrumentalVolume,
      output_format: outputFormat,
    });
  }, [sourceAssetId, selectedRefId, pitchShift, diffusionSteps, f0Condition, vocalVolume, instrumentalVolume, outputFormat, onSubmit]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-300">
        <SlidersHorizontal className="h-4 w-4" />
        Voice2Voice Controls
      </h3>

      {/* Hidden audio element for preview playback */}
      <audio
        ref={audioRef}
        onEnded={() => setPreviewRefId(null)}
        className="hidden"
      />

      {/* Source Track */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs text-zinc-400">Source Track</label>
        <select
          value={sourceAssetId}
          onChange={(e) => setSourceAssetId(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
        >
          <option value="">Select audio file...</option>
          {audioAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.filename} {a.prompt ? `— ${a.prompt.slice(0, 40)}` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Voice Reference */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs text-zinc-400">Voice Reference</label>
        <p className="mb-2 text-[11px] text-zinc-500">
          Upload a 1-30s audio clip of the target voice. Zero-shot — no training required.
        </p>

        {refsLoading ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading references...
          </div>
        ) : voiceRefs.length > 0 ? (
          <div className="mb-2 space-y-1">
            {voiceRefs.map((ref) => (
              <div
                key={ref.id}
                onClick={() => setSelectedRefId(ref.id)}
                className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm transition ${
                  selectedRefId === ref.id
                    ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                    : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Mic className="h-3.5 w-3.5 text-zinc-500" />
                  <span>{ref.name}</span>
                  <span className="text-[10px] text-zinc-500">{ref.duration}s</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePreview(ref.id);
                    }}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                  >
                    {previewRefId === ref.id ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this voice reference?")) {
                        deleteMut.mutate(ref.id);
                      }
                    }}
                    className="rounded p-1 text-zinc-500 hover:bg-red-900/50 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-2 text-xs text-zinc-600">
            No voice references yet. Upload one below.
          </p>
        )}

        {/* Upload */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
            placeholder="Reference name (optional)"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {uploadMut.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            Upload
          </button>
        </div>
      </div>

      {/* Mode Toggle */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs text-zinc-400">Conversion Mode</label>
        <div className="flex gap-2">
          <button
            onClick={() => setF0Condition(true)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              f0Condition
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            Singing (44.1kHz)
          </button>
          <button
            onClick={() => setF0Condition(false)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              !f0Condition
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            Speech (22kHz)
          </button>
        </div>
      </div>

      {/* Pitch Shift */}
      <div className="mb-4">
        <label className="mb-1.5 flex items-center justify-between text-xs text-zinc-400">
          <span>Pitch Shift</span>
          <span className="font-mono">{pitchShift > 0 ? `+${pitchShift}` : pitchShift} semitones</span>
        </label>
        <input
          type="range"
          min={-12}
          max={12}
          step={1}
          value={pitchShift}
          onChange={(e) => setPitchShift(Number(e.target.value))}
          className="w-full accent-indigo-500"
        />
      </div>

      {/* Advanced Settings */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="mb-3 text-xs text-indigo-400 hover:text-indigo-300"
      >
        {showAdvanced ? "Hide" : "Show"} Advanced Settings
      </button>

      {showAdvanced && (
        <div className="mb-4 space-y-3 rounded-md border border-zinc-800 bg-zinc-950 p-3">
          {/* Diffusion Steps */}
          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
              <span>Diffusion Steps</span>
              <span className="font-mono">{diffusionSteps}</span>
            </label>
            <input
              type="range"
              min={4}
              max={200}
              step={1}
              value={diffusionSteps}
              onChange={(e) => setDiffusionSteps(Number(e.target.value))}
              className="w-full accent-indigo-500"
            />
            <p className="mt-0.5 text-[10px] text-zinc-600">
              Higher = better quality but slower. 25-50 recommended.
            </p>
          </div>

          {/* Volumes */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                <span>Vocal Vol</span>
                <span className="font-mono">{vocalVolume.toFixed(1)}</span>
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={vocalVolume}
                onChange={(e) => setVocalVolume(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                <span>Inst Vol</span>
                <span className="font-mono">{instrumentalVolume.toFixed(1)}</span>
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={instrumentalVolume}
                onChange={(e) => setInstrumentalVolume(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>

          {/* Output Format */}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Output Format</label>
            <select
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
            >
              <option value="wav">WAV (lossless)</option>
              <option value="mp3">MP3</option>
            </select>
          </div>
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={isProcessing || !sourceAssetId || !selectedRefId}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isProcessing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Send className="h-4 w-4" />
        )}
        {isProcessing ? "Processing..." : "Start Voice Conversion"}
      </button>
    </div>
  );
}
