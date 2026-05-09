"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Brain, Cloud } from "lucide-react";
import type { ReasoningEffort, ProviderInfo } from "@/lib/types";

const EFFORT_LEVELS: { value: ReasoningEffort; label: string; dots: number; description: string }[] = [
  { value: "low", label: "Low", dots: 1, description: "Fast, minimal chain-of-thought" },
  { value: "medium", label: "Medium", dots: 2, description: "Balanced speed and depth" },
  { value: "high", label: "High", dots: 3, description: "Thorough reasoning, slower" },
  { value: "xhigh", label: "xHigh", dots: 4, description: "Maximum depth, significantly slower and more expensive" },
];

/** Models known to support reasoning effort (static fallback when capabilities aren't available). */
const REASONING_MODELS = new Set(["o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini"]);

/** Returns true if a model ID likely supports reasoning effort. */
export const supportsReasoning = (modelId: string, modelCapabilities?: { supports?: { reasoningEffort?: boolean } }): boolean => {
  // Use dynamic capabilities from the SDK when available
  if (modelCapabilities?.supports?.reasoningEffort !== undefined) {
    return modelCapabilities.supports.reasoningEffort;
  }
  // Fall back to static set when capabilities aren't loaded yet
  const lower = modelId.toLowerCase();
  return REASONING_MODELS.has(lower) || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
};

/* ── Reasoning Effort Selector ── */

export const ReasoningEffortSelector = ({
  value,
  onChange,
  modelId,
  modelCapabilities,
}: {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  modelId: string;
  modelCapabilities?: { supports?: { reasoningEffort?: boolean } };
}) => {
  if (!supportsReasoning(modelId, modelCapabilities)) return null;

  const currentLevel = EFFORT_LEVELS.find((l) => l.value === value) ?? EFFORT_LEVELS[1];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1.5">
        <Brain className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Reasoning:</span>
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Reasoning effort">
          {EFFORT_LEVELS.map((level) => (
            <Tooltip key={level.value}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  role="radio"
                  aria-checked={value === level.value}
                  aria-label={level.label}
                  className={cn(
                    "h-7 px-2 text-xs font-medium rounded-md transition-colors",
                    value === level.value
                      ? "bg-primary/10 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => onChange(level.value)}
                >
                  <span className="flex items-center gap-1">
                    {Array.from({ length: level.dots }).map((_, i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          value === level.value ? "bg-primary" : "bg-muted-foreground/40"
                        )}
                      />
                    ))}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="font-medium">{level.label}</p>
                <p className="text-xs text-muted-foreground">{level.description}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <span className="text-xs font-medium text-foreground">{currentLevel.label}</span>
      </div>
    </TooltipProvider>
  );
};

/* ── Provider Badge ── */

export const ProviderBadge = ({ provider }: { provider: ProviderInfo | null }) => {
  // Bug #1064-PN-D: always show the provider so users can see at a glance
  // whether the active chat is hitting Copilot, a local model, or a third
  // party — even when they haven't configured anything custom yet.
  const resolved: ProviderInfo =
    provider ?? { type: "copilot", label: "GitHub Copilot" };
  const isLocal = resolved.type === "local-copilot";
  const isCopilot = resolved.type === "copilot";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium " +
              (isLocal
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : isCopilot
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300")
            }
            data-testid="chat-provider-badge"
          >
            <Cloud className="h-3 w-3" />
            {resolved.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Using {resolved.label} as model provider</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
