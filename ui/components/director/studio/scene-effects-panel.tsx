"use client";

import { useState, useCallback, useMemo } from "react";
import { Sparkles, RotateCcw, ChevronDown } from "lucide-react";

// ── Effect Types ──────────────────────────────────────────────
interface EffectDef {
  type: string;
  [key: string]: unknown;
}

interface KenBurnsParams {
  scaleFrom?: number;
  scaleTo?: number;
  translateXFrom?: number;
  translateXTo?: number;
  translateYFrom?: number;
  translateYTo?: number;
}

interface SceneEffectsPanelProps {
  effects: EffectDef[];
  kenBurns?: KenBurnsParams;
  isImageScene: boolean;
  onEffectsChange: (effects: EffectDef[]) => void;
  onKenBurnsChange?: (kenBurns: KenBurnsParams) => void;
}

// ── Presets ───────────────────────────────────────────────────
interface Preset {
  id: string;
  label: string;
  description: string;
  effects: EffectDef[];
  kenBurns?: KenBurnsParams;
}

const PRESETS: Preset[] = [
  {
    id: "none",
    label: "None",
    description: "No effects",
    effects: [],
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Warm tones, slight vignette feel",
    effects: [
      { type: "brightness", value: 1.05 },
      { type: "contrast", value: 1.1 },
      { type: "saturate", value: 1.15 },
    ],
    kenBurns: { scaleFrom: 1.0, scaleTo: 1.08, translateXFrom: 0, translateXTo: -5, translateYFrom: 0, translateYTo: -3 },
  },
  {
    id: "vintage",
    label: "Vintage",
    description: "Sepia tones, muted colors",
    effects: [
      { type: "sepia", value: 0.4 },
      { type: "saturate", value: 0.8 },
      { type: "contrast", value: 1.1 },
    ],
    kenBurns: { scaleFrom: 1.0, scaleTo: 1.05, translateXFrom: 0, translateXTo: 0, translateYFrom: 0, translateYTo: 0 },
  },
  {
    id: "high-energy",
    label: "High Energy",
    description: "Vivid colors, strong contrast",
    effects: [
      { type: "contrast", value: 1.25 },
      { type: "saturate", value: 1.4 },
      { type: "brightness", value: 1.1 },
    ],
    kenBurns: { scaleFrom: 1.0, scaleTo: 1.2, translateXFrom: -5, translateXTo: 5, translateYFrom: 0, translateYTo: -8 },
  },
  {
    id: "moody",
    label: "Moody",
    description: "Desaturated, darker tones",
    effects: [
      { type: "saturate", value: 0.6 },
      { type: "brightness", value: 0.85 },
      { type: "contrast", value: 1.15 },
    ],
    kenBurns: { scaleFrom: 1.02, scaleTo: 1.0, translateXFrom: 0, translateXTo: 0, translateYFrom: -2, translateYTo: 2 },
  },
  {
    id: "film-noir",
    label: "Film Noir",
    description: "Black & white, dramatic contrast",
    effects: [
      { type: "grayscale" },
      { type: "contrast", value: 1.3 },
      { type: "brightness", value: 0.95 },
    ],
    kenBurns: { scaleFrom: 1.0, scaleTo: 1.1, translateXFrom: 0, translateXTo: -8, translateYFrom: 0, translateYTo: 0 },
  },
  {
    id: "dreamy",
    label: "Dreamy",
    description: "Soft, ethereal look",
    effects: [
      { type: "brightness", value: 1.15 },
      { type: "saturate", value: 0.9 },
      { type: "blur", amount: 1, startFrame: 0, endFrame: 9999 },
    ],
    kenBurns: { scaleFrom: 1.0, scaleTo: 1.12, translateXFrom: -3, translateXTo: 3, translateYFrom: -2, translateYTo: 2 },
  },
];

// ── Granular Controls ──────────────────────────────────────────
interface FilterSlider {
  type: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
  paramKey: string;
}

const FILTER_SLIDERS: FilterSlider[] = [
  { type: "brightness", label: "Brightness", min: 0.5, max: 2.0, step: 0.05, defaultValue: 1.0, unit: "", paramKey: "value" },
  { type: "contrast", label: "Contrast", min: 0.5, max: 2.0, step: 0.05, defaultValue: 1.0, unit: "", paramKey: "value" },
  { type: "saturate", label: "Saturation", min: 0, max: 3.0, step: 0.05, defaultValue: 1.0, unit: "", paramKey: "value" },
  { type: "sepia", label: "Sepia", min: 0, max: 1.0, step: 0.05, defaultValue: 0, unit: "", paramKey: "value" },
  { type: "blur", label: "Blur", min: 0, max: 20, step: 0.5, defaultValue: 0, unit: "px", paramKey: "amount" },
  { type: "hueRotate", label: "Hue Rotate", min: 0, max: 360, step: 5, defaultValue: 0, unit: "°", paramKey: "degrees" },
];

function getEffectValue(effects: EffectDef[], type: string, paramKey: string, defaultValue: number): number {
  const effect = effects.find((e) => e.type === type);
  if (!effect) return defaultValue;
  if (type === "grayscale") return 1;
  return (effect[paramKey] as number) ?? defaultValue;
}

function hasGrayscale(effects: EffectDef[]): boolean {
  return effects.some((e) => e.type === "grayscale");
}

export function SceneEffectsPanel({
  effects,
  kenBurns,
  isImageScene,
  onEffectsChange,
  onKenBurnsChange,
}: SceneEffectsPanelProps) {
  const [showGranular, setShowGranular] = useState(false);
  const [showKenBurns, setShowKenBurns] = useState(false);

  const activePreset = useMemo(() => {
    if (effects.length === 0) return "none";
    return PRESETS.find((p) => {
      if (p.id === "none") return false;
      if (p.effects.length !== effects.length) return false;
      return p.effects.every((pe) => effects.some((e) => e.type === pe.type));
    })?.id ?? "custom";
  }, [effects]);

  const handlePresetSelect = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      onEffectsChange(preset.effects);
      if (preset.kenBurns && onKenBurnsChange && isImageScene) {
        onKenBurnsChange(preset.kenBurns);
      }
    },
    [onEffectsChange, onKenBurnsChange, isImageScene],
  );

  const handleFilterChange = useCallback(
    (type: string, paramKey: string, value: number, defaultValue: number) => {
      const isDefault = Math.abs(value - defaultValue) < 0.001;
      const updated = effects.filter((e) => e.type !== type);

      if (!isDefault) {
        if (type === "blur") {
          updated.push({ type, amount: value, startFrame: 0, endFrame: 99999 });
        } else if (type === "hueRotate") {
          updated.push({ type, degrees: value });
        } else {
          updated.push({ type, [paramKey]: value });
        }
      }

      onEffectsChange(updated);
    },
    [effects, onEffectsChange],
  );

  const handleGrayscaleToggle = useCallback(() => {
    if (hasGrayscale(effects)) {
      onEffectsChange(effects.filter((e) => e.type !== "grayscale"));
    } else {
      onEffectsChange([...effects, { type: "grayscale" }]);
    }
  }, [effects, onEffectsChange]);

  const handleFadeInToggle = useCallback(() => {
    const hasFadeIn = effects.some((e) => e.type === "fadeIn");
    if (hasFadeIn) {
      onEffectsChange(effects.filter((e) => e.type !== "fadeIn"));
    } else {
      onEffectsChange([...effects, { type: "fadeIn", durationFrames: 15 }]);
    }
  }, [effects, onEffectsChange]);

  const handleFadeOutToggle = useCallback(() => {
    const hasFadeOut = effects.some((e) => e.type === "fadeOut");
    if (hasFadeOut) {
      onEffectsChange(effects.filter((e) => e.type !== "fadeOut"));
    } else {
      onEffectsChange([...effects, { type: "fadeOut", durationFrames: 15 }]);
    }
  }, [effects, onEffectsChange]);

  const handleResetAll = useCallback(() => {
    onEffectsChange([]);
    if (onKenBurnsChange && isImageScene) {
      onKenBurnsChange({
        scaleFrom: 1.0,
        scaleTo: 1.15,
        translateXFrom: 0,
        translateXTo: -10,
        translateYFrom: 0,
        translateYTo: -5,
      });
    }
  }, [onEffectsChange, onKenBurnsChange, isImageScene]);

  const handleKenBurnsChange = useCallback(
    (key: keyof KenBurnsParams, value: number) => {
      if (!onKenBurnsChange) return;
      onKenBurnsChange({ ...kenBurns, [key]: value });
    },
    [kenBurns, onKenBurnsChange],
  );

  const kb = kenBurns ?? { scaleFrom: 1.0, scaleTo: 1.15, translateXFrom: 0, translateXTo: -10, translateYFrom: 0, translateYTo: -5 };

  return (
    <div className="rounded-lg border border-border p-3" data-testid="scene-effects-panel">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">Visual Effects</p>
        </div>
        <button
          onClick={handleResetAll}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition"
          data-testid="effects-reset"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      {/* Presets */}
      <div className="mb-3">
        <p className="mb-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Presets</p>
        <div className="grid grid-cols-4 gap-1" data-testid="effects-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handlePresetSelect(preset.id)}
              className={`rounded px-2 py-1.5 text-[10px] font-medium transition ${
                activePreset === preset.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
              title={preset.description}
              data-testid={`preset-${preset.id}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quick toggles */}
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={handleGrayscaleToggle}
          className={`rounded px-2 py-1 text-[10px] font-medium transition ${
            hasGrayscale(effects) ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          data-testid="toggle-grayscale"
        >
          B&W
        </button>
        <button
          onClick={handleFadeInToggle}
          className={`rounded px-2 py-1 text-[10px] font-medium transition ${
            effects.some((e) => e.type === "fadeIn") ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          data-testid="toggle-fade-in"
        >
          Fade In
        </button>
        <button
          onClick={handleFadeOutToggle}
          className={`rounded px-2 py-1 text-[10px] font-medium transition ${
            effects.some((e) => e.type === "fadeOut") ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          data-testid="toggle-fade-out"
        >
          Fade Out
        </button>
      </div>

      {/* Granular controls */}
      <button
        onClick={() => setShowGranular(!showGranular)}
        className="mb-2 flex w-full items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition"
        data-testid="toggle-granular"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${showGranular ? "rotate-0" : "-rotate-90"}`} />
        Fine-tune Controls
      </button>
      {showGranular && (
        <div className="space-y-2 mb-3" data-testid="granular-controls">
          {FILTER_SLIDERS.map((slider) => {
            const value = getEffectValue(effects, slider.type, slider.paramKey, slider.defaultValue);
            return (
              <div key={slider.type} className="flex items-center gap-2">
                <label className="w-16 shrink-0 text-[10px] text-muted-foreground">{slider.label}</label>
                <input
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={value}
                  onChange={(e) => handleFilterChange(slider.type, slider.paramKey, parseFloat(e.target.value), slider.defaultValue)}
                  className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
                  data-testid={`slider-${slider.type}`}
                />
                <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">
                  {value.toFixed(slider.step < 1 ? 2 : 0)}{slider.unit}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Ken Burns controls (image scenes only) */}
      {isImageScene && onKenBurnsChange && (
        <>
          <button
            onClick={() => setShowKenBurns(!showKenBurns)}
            className="mb-2 flex w-full items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition"
            data-testid="toggle-ken-burns"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${showKenBurns ? "rotate-0" : "-rotate-90"}`} />
            Ken Burns (Zoom & Pan)
          </button>
          {showKenBurns && (
            <div className="space-y-2" data-testid="ken-burns-controls">
              {[
                { key: "scaleFrom" as const, label: "Zoom Start", min: 0.8, max: 2, step: 0.05 },
                { key: "scaleTo" as const, label: "Zoom End", min: 0.8, max: 2, step: 0.05 },
                { key: "translateXFrom" as const, label: "Pan X Start", min: -50, max: 50, step: 1 },
                { key: "translateXTo" as const, label: "Pan X End", min: -50, max: 50, step: 1 },
                { key: "translateYFrom" as const, label: "Pan Y Start", min: -50, max: 50, step: 1 },
                { key: "translateYTo" as const, label: "Pan Y End", min: -50, max: 50, step: 1 },
              ].map((ctrl) => (
                <div key={ctrl.key} className="flex items-center gap-2">
                  <label className="w-20 shrink-0 text-[10px] text-muted-foreground">{ctrl.label}</label>
                  <input
                    type="range"
                    min={ctrl.min}
                    max={ctrl.max}
                    step={ctrl.step}
                    value={kb[ctrl.key] ?? 0}
                    onChange={(e) => handleKenBurnsChange(ctrl.key, parseFloat(e.target.value))}
                    className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
                    data-testid={`kb-${ctrl.key}`}
                  />
                  <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">
                    {(kb[ctrl.key] ?? 0).toFixed(ctrl.step < 1 ? 2 : 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
