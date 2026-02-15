"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { Check, Monitor, Smartphone, SplitSquareVertical, Presentation, Loader2 } from "lucide-react";
import type { TemplateInfo } from "./types";

interface TemplatePickerStepProps {
  selected: string | null;
  onSelect: (templateId: string) => void;
}

const TEMPLATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Minimalist: Monitor,
  ContentCreator: Smartphone,
  Corporate: Presentation,
  TechDemo: SplitSquareVertical,
};

const TEMPLATE_PREVIEWS: Record<string, { gradient: string; accent: string; border: string }> = {
  Minimalist: {
    gradient: "from-zinc-800 to-zinc-900",
    accent: "text-zinc-300",
    border: "border-zinc-500/50",
  },
  ContentCreator: {
    gradient: "from-pink-900/40 to-purple-900/40",
    accent: "text-pink-400",
    border: "border-pink-500/50",
  },
  Corporate: {
    gradient: "from-blue-900/30 to-indigo-900/30",
    accent: "text-blue-400",
    border: "border-blue-500/50",
  },
  TechDemo: {
    gradient: "from-green-900/30 to-emerald-900/30",
    accent: "text-green-400",
    border: "border-green-500/50",
  },
};

export const TemplatePickerStep = ({ selected, onSelect }: TemplatePickerStepProps) => {
  const { data, isLoading } = useQuery({
    queryKey: ["director-templates"],
    queryFn: () =>
      fetchJson<{ templates: TemplateInfo[]; defaultTemplate: string }>(
        "/api/admin/director/templates",
      ),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading templates…</span>
      </div>
    );
  }

  const templates = data?.templates ?? [];

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground mb-1">
          Pick a Visual Style
        </h2>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Each template defines transitions, typography, layout, and caption style.
          The AI can override your choice if a different template better fits the content.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto">
        {templates.map((template) => {
          const isSelected = selected === template.id;
          const Icon = TEMPLATE_ICONS[template.id] ?? Monitor;
          const preview = TEMPLATE_PREVIEWS[template.id] ?? TEMPLATE_PREVIEWS.Minimalist;

          return (
            <button
              key={template.id}
              onClick={() => onSelect(template.id)}
              className={`group relative text-left rounded-2xl border-2 overflow-hidden transition-all duration-200 ${
                isSelected
                  ? `${preview.border} shadow-lg ring-1 ring-primary/30`
                  : "border-border hover:border-muted-foreground/30 hover:shadow-md"
              }`}
            >
              {/* Preview Header */}
              <div
                className={`bg-gradient-to-br ${preview.gradient} px-5 py-4 relative`}
                style={{ backgroundColor: template.titleCardBackground }}
              >
                {/* Aspect ratio badge */}
                <span className={`absolute top-3 right-3 text-[10px] font-semibold ${preview.accent} bg-black/30 rounded-full px-2 py-0.5`}>
                  {template.aspectRatio}
                </span>

                {/* Template Visual Preview */}
                <div className="flex items-center gap-3">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-black/20`}>
                    <Icon className={`h-6 w-6 ${preview.accent}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white text-sm">{template.name}</h3>
                    <p className="text-xs text-white/60">{template.defaultTransition} • {template.defaultComposition.fps}fps</p>
                  </div>
                </div>

                {/* Resolution bar */}
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] font-mono text-white/40">
                    {template.defaultComposition.width}×{template.defaultComposition.height}
                  </span>
                  {template.captionsEnabled && (
                    <span className="text-[10px] text-white/40 bg-white/10 rounded px-1.5 py-0.5">
                      {template.defaultCaptionStyle} captions
                    </span>
                  )}
                </div>
              </div>

              {/* Description */}
              <div className="bg-card px-5 py-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{template.description}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {template.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Selected indicator */}
              {isSelected && (
                <div className="absolute top-3 left-3">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                    <Check className="h-3 w-3 text-primary-foreground" />
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
