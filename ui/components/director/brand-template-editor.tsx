"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { Film, Plus, Trash2, Check } from "lucide-react";

interface BuiltInTemplate {
  id: string;
  type: "intro" | "outro" | "lower-third";
  style: string;
  name: string;
  description: string;
  durationFrames: number;
}

interface SavedTemplate {
  id: string;
  brandKitId: string;
  templateDefId: string;
  customTitle: string | null;
  customSubtitle: string | null;
  customDurationFrames: number | null;
  autoApply: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  intro: "Intros",
  outro: "Outros",
  "lower-third": "Lower Thirds",
};

/**
 * Brand template gallery and editor.
 * #827 — Video Brand Templates
 */
export function BrandTemplateEditor({ brandKitId }: { brandKitId: string }) {
  const queryClient = useQueryClient();
  const [selectedDef, setSelectedDef] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [autoApply, setAutoApply] = useState(false);

  // Fetch built-in templates
  const { data: builtIn } = useQuery({
    queryKey: ["brand-templates-builtin"],
    queryFn: () =>
      fetchJson<{ templates: BuiltInTemplate[] }>(
        "/api/admin/brand-templates/builtin",
      ),
  });

  // Fetch saved templates for this brand kit
  const { data: saved } = useQuery({
    queryKey: ["brand-templates-saved", brandKitId],
    queryFn: () =>
      fetchJson<{ templates: SavedTemplate[] }>(
        `/api/admin/brand-templates?brandKitId=${brandKitId}`,
      ),
  });

  const addMutation = useMutation({
    mutationFn: (input: {
      brandKitId: string;
      templateDefId: string;
      customTitle?: string;
      autoApply?: boolean;
    }) =>
      fetchJson("/api/admin/brand-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-templates-saved"] });
      setSelectedDef(null);
      setCustomTitle("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/brand-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-templates-saved"] });
    },
  });

  const savedIds = new Set(saved?.templates?.map((s) => s.templateDefId) ?? []);

  return (
    <div className="space-y-6" data-testid="brand-template-editor">
      {/* Template Gallery */}
      {(["intro", "outro", "lower-third"] as const).map((type) => {
        const templates =
          builtIn?.templates?.filter((t) => t.type === type) ?? [];
        if (templates.length === 0) return null;
        return (
          <SectionCard
            key={type}
            title={
              <span className="inline-flex items-center gap-2">
                <Film className="w-4 h-4" /> {TYPE_LABELS[type]}
              </span>
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {templates.map((t) => {
                const isSelected = selectedDef === t.id;
                const isSaved = savedIds.has(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedDef(isSelected ? null : t.id)}
                    className={`text-left p-3 rounded-lg border transition ${
                      isSelected
                        ? "border-blue-500 bg-blue-500/10"
                        : isSaved
                          ? "border-green-600 bg-green-600/5"
                          : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                    }`}
                    data-testid={`template-card-${t.id}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{t.name}</span>
                      {isSaved && <Check className="w-4 h-4 text-green-400" />}
                    </div>
                    <p className="text-xs text-zinc-400">{t.description}</p>
                    {t.durationFrames > 0 && (
                      <span className="text-[10px] text-zinc-500 mt-1 block">
                        {(t.durationFrames / 30).toFixed(1)}s at 30fps
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </SectionCard>
        );
      })}

      {/* Add template form */}
      {selectedDef && !savedIds.has(selectedDef) && (
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold">Customize Template</h3>
          <input
            type="text"
            placeholder="Custom title (optional)"
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            className="w-full px-3 py-2 rounded bg-zinc-800 border border-zinc-600 text-sm"
            data-testid="template-custom-title"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoApply}
              onChange={(e) => setAutoApply(e.target.checked)}
              data-testid="template-auto-apply"
            />
            Auto-apply to new drafts
          </label>
          <button
            onClick={() =>
              addMutation.mutate({
                brandKitId,
                templateDefId: selectedDef,
                customTitle: customTitle || undefined,
                autoApply,
              })
            }
            disabled={addMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium disabled:opacity-50"
            data-testid="template-save-btn"
          >
            <Plus className="w-4 h-4" />
            {addMutation.isPending ? "Saving..." : "Add Template"}
          </button>
        </div>
      )}

      {/* Saved templates list */}
      {saved?.templates && saved.templates.length > 0 && (
        <SectionCard
          title={<span className="inline-flex items-center gap-2"><Check className="w-4 h-4" /> Saved Templates</span>}
        >
          <div className="space-y-2">
            {saved.templates.map((s) => {
              const def = builtIn?.templates?.find(
                (t) => t.id === s.templateDefId,
              );
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between bg-zinc-800 rounded p-2"
                  data-testid={`saved-template-${s.id}`}
                >
                  <div>
                    <span className="text-sm font-medium">
                      {s.customTitle ?? def?.name ?? s.templateDefId}
                    </span>
                    {s.autoApply && (
                      <span className="ml-2 text-[10px] bg-green-700 px-1.5 py-0.5 rounded text-green-100">
                        Auto
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteMutation.mutate(s.id)}
                    className="p-1 text-zinc-400 hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
