"use client";

import { Film, Sparkles, Mic } from "lucide-react";
import type { ProductionMode } from "./types";

interface ModeSelectionStepProps {
  selected: ProductionMode | null;
  onSelect: (mode: ProductionMode) => void;
}

const MODES = [
  {
    id: "highlight" as const,
    title: "Highlight Reel",
    subtitle: "Video-First",
    description:
      "Drop in raw video clips and let the AI analyze transcripts, detect scenes, reorder for narrative flow, remove dead air, and apply cinematic effects.",
    features: [
      "Auto scene detection & reordering",
      "Dead air & filler word removal",
      "Ken Burns on static shots",
      "Smart transition selection",
    ],
    icon: Film,
    gradient: "from-violet-500/20 to-purple-600/20",
    accent: "text-violet-400",
    border: "border-violet-500/50",
    bgHover: "hover:border-violet-400",
  },
  {
    id: "script" as const,
    title: "Script-Driven",
    subtitle: "Audio-First",
    description:
      "Provide a script and B-Roll clips. The AI generates a voiceover via TTS, aligns visuals to narration, mutes originals, and adds background music.",
    features: [
      "TTS voiceover generation",
      "B-Roll to script alignment",
      "Auto visual duration matching",
      "Music ducking under narration",
    ],
    icon: Mic,
    gradient: "from-emerald-500/20 to-teal-600/20",
    accent: "text-emerald-400",
    border: "border-emerald-500/50",
    bgHover: "hover:border-emerald-400",
  },
];

export const ModeSelectionStep = ({ selected, onSelect }: ModeSelectionStepProps) => {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold text-foreground">Choose Production Mode</h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Select how you want to produce your video. Each mode uses a single-shot LLM call
          for cost-efficient, AI-driven editing decisions.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const isSelected = selected === mode.id;

          return (
            <button
              key={mode.id}
              onClick={() => onSelect(mode.id)}
              className={`group relative text-left rounded-2xl border-2 p-6 transition-all duration-200 ${
                isSelected
                  ? `${mode.border} bg-gradient-to-br ${mode.gradient} shadow-lg`
                  : `border-border bg-card ${mode.bgHover} hover:shadow-md`
              }`}
            >
              {/* Selected indicator */}
              {isSelected && (
                <div className="absolute top-4 right-4">
                  <div className={`h-3 w-3 rounded-full bg-current ${mode.accent}`} />
                </div>
              )}

              {/* Icon + Title */}
              <div className="flex items-center gap-3 mb-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                    isSelected ? `bg-gradient-to-br ${mode.gradient}` : "bg-muted"
                  }`}
                >
                  <Icon className={`h-5 w-5 ${isSelected ? mode.accent : "text-muted-foreground"}`} />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">{mode.title}</h3>
                  <span className={`text-xs font-medium ${mode.accent}`}>{mode.subtitle}</span>
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{mode.description}</p>

              {/* Features */}
              <ul className="space-y-1.5">
                {mode.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={`h-1 w-1 rounded-full ${isSelected ? `bg-current ${mode.accent}` : "bg-muted-foreground/50"}`} />
                    {feature}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
};
