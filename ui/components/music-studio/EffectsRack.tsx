"use client";

import { useState, useCallback, useEffect } from "react";
import {
  SlidersHorizontal,
  Zap,
  Gauge,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useAudioEffectsChain } from "@/hooks/useAudioEffectsChain";

// ── EQ Bands ────────────────────────────────────────────────

const EQ_BANDS = [
  { freq: 32, label: "32" },
  { freq: 64, label: "64" },
  { freq: 125, label: "125" },
  { freq: 250, label: "250" },
  { freq: 500, label: "500" },
  { freq: 1000, label: "1k" },
  { freq: 2000, label: "2k" },
  { freq: 4000, label: "4k" },
  { freq: 8000, label: "8k" },
  { freq: 16000, label: "16k" },
];

// ── Types ───────────────────────────────────────────────────

export interface EffectsState {
  eqGains: number[]; // dB per band (-12 to +12)
  reverbMix: number; // 0 – 1
  stereoPosition: number; // -1 (L) – 1 (R)
  playbackRate: number; // 0.25 – 4
  compressorEnabled: boolean;
  distortionAmount: number; // 0 – 100
}

export const DEFAULT_EFFECTS: EffectsState = {
  eqGains: EQ_BANDS.map(() => 0),
  reverbMix: 0,
  stereoPosition: 0,
  playbackRate: 1,
  compressorEnabled: false,
  distortionAmount: 0,
};

interface EffectsRackProps {
  /** Current effects state */
  effects: EffectsState;
  /** Called when effects change */
  onChange: (effects: EffectsState) => void;
  /** Audio context to connect Web Audio nodes (optional) */
  audioContext?: AudioContext | null;
  /** Source node from wavesurfer */
  sourceNode?: MediaElementAudioSourceNode | null;
}

// ── EQ Band Slider ──────────────────────────────────────────

function EqBandSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[9px] text-zinc-500">
        {value > 0 ? `+${value}` : value}
      </span>
      <input
        type="range"
        min={-12}
        max={12}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-16 w-3 accent-indigo-500"
        style={{
          writingMode: "vertical-lr",
          direction: "rtl",
        }}
      />
      <span className="text-[9px] text-zinc-600">{label}</span>
    </div>
  );
}

// ── Effects Rack Component ──────────────────────────────────

export function EffectsRack({
  effects,
  onChange,
  audioContext,
  sourceNode,
}: EffectsRackProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Wire real-time Web Audio effects chain
  const { connectSource } = useAudioEffectsChain(audioContext ?? null, effects);

  // When sourceNode becomes available, connect it into the chain
  useEffect(() => {
    if (sourceNode && audioContext) {
      connectSource(sourceNode);
    }
  }, [sourceNode, audioContext, connectSource]);

  const updateField = useCallback(
    <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => {
      onChange({ ...effects, [key]: value });
    },
    [effects, onChange]
  );

  const updateEqBand = useCallback(
    (index: number, value: number) => {
      const newGains = [...effects.eqGains];
      newGains[index] = value;
      onChange({ ...effects, eqGains: newGains });
    },
    [effects, onChange]
  );

  const resetAll = useCallback(() => {
    onChange({ ...DEFAULT_EFFECTS });
  }, [onChange]);

  const toggleSection = useCallback(
    (section: string) => {
      setActiveSection((prev) => (prev === section ? null : section));
    },
    []
  );

  const speedPresets = [
    { label: "0.5x", value: 0.5 },
    { label: "0.75x", value: 0.75 },
    { label: "1x", value: 1 },
    { label: "1.25x", value: 1.25 },
    { label: "1.5x", value: 1.5 },
    { label: "2x", value: 2 },
  ];

  const hasChanges =
    effects.eqGains.some((g) => g !== 0) ||
    effects.reverbMix > 0 ||
    effects.stereoPosition !== 0 ||
    effects.playbackRate !== 1 ||
    effects.compressorEnabled ||
    effects.distortionAmount > 0;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-2.5"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-medium text-zinc-300">Effects Rack</span>
          {hasChanges && (
            <span className="rounded-full bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">
              active
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1 border-t border-zinc-800 px-4 pb-4 pt-3">
          {/* ── Playback Speed ────────────────── */}
          <SectionToggle
            label="Playback Speed"
            icon={<Gauge className="h-3.5 w-3.5" />}
            isOpen={activeSection === "speed"}
            onToggle={() => toggleSection("speed")}
          />
          {activeSection === "speed" && (
            <div className="space-y-2 pb-3 pl-5">
              <div className="flex flex-wrap gap-1">
                {speedPresets.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => updateField("playbackRate", p.value)}
                    className={`rounded px-2 py-1 text-xs ${
                      effects.playbackRate === p.value
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={effects.playbackRate}
                  onChange={(e) =>
                    updateField("playbackRate", Number(e.target.value))
                  }
                  className="flex-1 accent-indigo-500"
                />
                <span className="w-10 font-mono text-xs text-zinc-400">
                  {effects.playbackRate.toFixed(2)}x
                </span>
              </div>
            </div>
          )}

          {/* ── 10-Band EQ ────────────────────── */}
          <SectionToggle
            label="10-Band Equalizer"
            icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
            isOpen={activeSection === "eq"}
            onToggle={() => toggleSection("eq")}
          />
          {activeSection === "eq" && (
            <div className="pb-3 pl-5">
              <div className="flex items-end justify-between gap-1">
                {EQ_BANDS.map((band, i) => (
                  <EqBandSlider
                    key={band.freq}
                    label={band.label}
                    value={effects.eqGains[i]}
                    onChange={(v) => updateEqBand(i, v)}
                  />
                ))}
              </div>
              <p className="mt-1 text-[10px] text-zinc-600">
                Adjust gain (dB) per frequency band
              </p>
            </div>
          )}

          {/* ── Stereo Pan ────────────────────── */}
          <SectionToggle
            label="Stereo Pan"
            icon={<Zap className="h-3.5 w-3.5" />}
            isOpen={activeSection === "pan"}
            onToggle={() => toggleSection("pan")}
          />
          {activeSection === "pan" && (
            <div className="space-y-1 pb-3 pl-5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500">L</span>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={effects.stereoPosition}
                  onChange={(e) =>
                    updateField("stereoPosition", Number(e.target.value))
                  }
                  className="flex-1 accent-indigo-500"
                />
                <span className="text-[10px] text-zinc-500">R</span>
              </div>
              <p className="text-center font-mono text-xs text-zinc-400">
                {effects.stereoPosition === 0
                  ? "Center"
                  : effects.stereoPosition < 0
                    ? `L ${Math.round(Math.abs(effects.stereoPosition) * 100)}%`
                    : `R ${Math.round(effects.stereoPosition * 100)}%`}
              </p>
            </div>
          )}

          {/* ── Reverb ────────────────────────── */}
          <SectionToggle
            label="Reverb"
            icon={<Zap className="h-3.5 w-3.5" />}
            isOpen={activeSection === "reverb"}
            onToggle={() => toggleSection("reverb")}
          />
          {activeSection === "reverb" && (
            <div className="space-y-1 pb-3 pl-5">
              <label className="flex items-center justify-between text-xs text-zinc-400">
                <span>Wet/Dry Mix</span>
                <span className="font-mono">
                  {Math.round(effects.reverbMix * 100)}%
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={effects.reverbMix}
                onChange={(e) =>
                  updateField("reverbMix", Number(e.target.value))
                }
                className="w-full accent-indigo-500"
              />
            </div>
          )}

          {/* ── Compressor ────────────────────── */}
          <div className="flex items-center justify-between py-1.5 pl-5">
            <span className="text-xs text-zinc-400">Compressor</span>
            <button
              onClick={() =>
                updateField("compressorEnabled", !effects.compressorEnabled)
              }
              className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                effects.compressorEnabled
                  ? "bg-emerald-600/30 text-emerald-400"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {effects.compressorEnabled ? "ON" : "OFF"}
            </button>
          </div>

          {/* ── Distortion ────────────────────── */}
          <SectionToggle
            label="Distortion"
            icon={<Zap className="h-3.5 w-3.5" />}
            isOpen={activeSection === "distortion"}
            onToggle={() => toggleSection("distortion")}
          />
          {activeSection === "distortion" && (
            <div className="space-y-1 pb-3 pl-5">
              <label className="flex items-center justify-between text-xs text-zinc-400">
                <span>Amount</span>
                <span className="font-mono">
                  {effects.distortionAmount}%
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={effects.distortionAmount}
                onChange={(e) =>
                  updateField("distortionAmount", Number(e.target.value))
                }
                className="w-full accent-indigo-500"
              />
            </div>
          )}

          {/* Reset */}
          {hasChanges && (
            <button
              onClick={resetAll}
              className="mt-2 w-full rounded bg-zinc-800 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
            >
              Reset All Effects
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section Toggle ──────────────────────────────────────────

function SectionToggle({
  label,
  icon,
  isOpen,
  onToggle,
}: {
  label: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded px-0 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
    >
      {icon}
      <span>{label}</span>
      {isOpen ? (
        <ChevronUp className="ml-auto h-3 w-3" />
      ) : (
        <ChevronDown className="ml-auto h-3 w-3" />
      )}
    </button>
  );
}
