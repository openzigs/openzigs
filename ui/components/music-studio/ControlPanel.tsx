"use client";

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Loader2, Send, SlidersHorizontal } from "lucide-react";
import { showToast } from "@/components/toast";

interface VoiceModel {
  name: string;
  path: string;
  has_index: boolean;
}

interface ControlPanelProps {
  /** List of available audio assets to use as source */
  audioAssets: Array<{ id: string; filename: string; prompt?: string }>;
  /** Called when a job is submitted */
  onSubmit: (params: Voice2VoiceParams) => void;
  /** Whether a job is currently processing */
  isProcessing: boolean;
}

export interface Voice2VoiceParams {
  source_asset_id: string;
  voice_model: string;
  pitch_shift: number;
  index_rate: number;
  filter_radius: number;
  vocal_volume: number;
  instrumental_volume: number;
  output_format: string;
}

export function ControlPanel({ audioAssets, onSubmit, isProcessing }: ControlPanelProps) {
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [voiceModel, setVoiceModel] = useState("");
  const [pitchShift, setPitchShift] = useState(0);
  const [indexRate, setIndexRate] = useState(0.75);
  const [filterRadius, setFilterRadius] = useState(3);
  const [vocalVolume, setVocalVolume] = useState(1.0);
  const [instrumentalVolume, setInstrumentalVolume] = useState(1.0);
  const [outputFormat, setOutputFormat] = useState("wav");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Fetch available voice models from the sidecar (via admin API proxy)
  const { data: modelsData } = useQuery({
    queryKey: ["voice-models"],
    queryFn: () => fetchJson<{ models: VoiceModel[] }>("/api/admin/music-studio/models"),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const voiceModels = modelsData?.models ?? [];

  const handleSubmit = useCallback(() => {
    if (!sourceAssetId) {
      showToast("Select a source audio track", "error");
      return;
    }
    if (!voiceModel) {
      showToast("Select a voice model", "error");
      return;
    }

    onSubmit({
      source_asset_id: sourceAssetId,
      voice_model: voiceModel,
      pitch_shift: pitchShift,
      index_rate: indexRate,
      filter_radius: filterRadius,
      vocal_volume: vocalVolume,
      instrumental_volume: instrumentalVolume,
      output_format: outputFormat,
    });
  }, [sourceAssetId, voiceModel, pitchShift, indexRate, filterRadius, vocalVolume, instrumentalVolume, outputFormat, onSubmit]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-300">
        <SlidersHorizontal className="h-4 w-4" />
        Voice2Voice Controls
      </h3>

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

      {/* Voice Model */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs text-zinc-400">Voice Model</label>
        {voiceModels.length > 0 ? (
          <select
            value={voiceModel}
            onChange={(e) => setVoiceModel(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">Select voice model...</option>
            {voiceModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} {m.has_index ? "✓" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={voiceModel}
            onChange={(e) => setVoiceModel(e.target.value)}
            placeholder="e.g. artist_name"
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
        )}
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
          {/* Index Rate */}
          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
              <span>Index Rate</span>
              <span className="font-mono">{indexRate.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={indexRate}
              onChange={(e) => setIndexRate(Number(e.target.value))}
              className="w-full accent-indigo-500"
            />
          </div>

          {/* Filter Radius */}
          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
              <span>Filter Radius</span>
              <span className="font-mono">{filterRadius}</span>
            </label>
            <input
              type="range"
              min={0}
              max={7}
              step={1}
              value={filterRadius}
              onChange={(e) => setFilterRadius(Number(e.target.value))}
              className="w-full accent-indigo-500"
            />
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
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="wav">WAV (lossless)</option>
              <option value="mp3">MP3 (320kbps)</option>
            </select>
          </div>
        </div>
      )}

      {/* Submit Button */}
      <button
        onClick={handleSubmit}
        disabled={isProcessing || !sourceAssetId || !voiceModel}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <Send className="h-4 w-4" />
            Start Voice2Voice
          </>
        )}
      </button>
    </div>
  );
}
