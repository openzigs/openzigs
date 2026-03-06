"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";

type ModelsResponse = { models: ModelInfo[]; selectedModel?: string | null };

/**
 * Reusable hook that fetches available LLM models.
 * Pass `enabled` to defer fetching until a dialog is open.
 */
export function useModelsQuery(enabled = true) {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<ModelsResponse>("/api/models"),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Inline <select> for choosing an LLM model override.
 * Value of "" means "use default".
 */
export function ModelPickerSelect({
  value,
  onChange,
  modelsData,
  className,
  size = "xs",
}: {
  value: string;
  onChange: (value: string) => void;
  modelsData?: ModelsResponse;
  className?: string;
  size?: "xs" | "sm";
}) {
  const sizeClass = size === "sm" ? "px-3 py-2 text-sm" : "px-2 py-1 text-xs";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-border bg-background ${sizeClass} text-foreground ${className ?? ""}`}
    >
      <option value="">
        Default{modelsData?.selectedModel ? ` (${modelsData.selectedModel})` : ""}
      </option>
      {(modelsData?.models ?? []).map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
    </select>
  );
}

/**
 * Small inline model selector label + dropdown used next to AI
 * action buttons. Fetches models on mount.
 */
export function InlineModelPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const modelsQuery = useModelsQuery();
  return (
    <ModelPickerSelect
      value={value}
      onChange={onChange}
      modelsData={modelsQuery.data}
      className={className}
      size="xs"
    />
  );
}
