"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { SavedPrompt, TemplateAnalysis, TemplatePlaceholder } from "@/lib/types";
import { showToast } from "@/components/toast";
import { AlertTriangle, CheckCircle, Upload, X } from "lucide-react";

type Step = "upload" | "preview" | "success";

interface ImportWizardProps {
  onClose: () => void;
}

export const ImportWizard = ({ onClose }: ImportWizardProps) => {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("upload");
  const [rawTemplate, setRawTemplate] = useState<Record<string, unknown> | null>(null);
  const [analysis, setAnalysis] = useState<TemplateAnalysis | null>(null);
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [importedPrompt, setImportedPrompt] = useState<SavedPrompt | null>(null);
  const [dragActive, setDragActive] = useState(false);

  /* ── Analyze mutation ──────────────────────────────────────────── */
  const analyzeMutation = useMutation({
    mutationFn: (template: Record<string, unknown>) =>
      fetchJson<TemplateAnalysis>("/api/admin/templates/analyze", {
        method: "POST",
        body: JSON.stringify(template),
      }),
    onSuccess: (data, template) => {
      setAnalysis(data);
      setRawTemplate(template);
      if (data.valid) {
        // Pre-fill defaults
        const defaults: Record<string, string> = {};
        for (const p of data.placeholders) {
          defaults[p.key] = p.defaultValue ?? "";
        }
        setPlaceholderValues(defaults);
        setStep("preview");
      }
    },
    onError: (err) => showToast(`Analysis failed: ${err.message}`, "error"),
  });

  /* ── Import mutation ───────────────────────────────────────────── */
  const importMutation = useMutation({
    mutationFn: (body: { template: Record<string, unknown>; placeholders: Record<string, string> }) =>
      fetchJson<{ prompt: SavedPrompt }>("/api/admin/templates/import", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setImportedPrompt(data.prompt);
      setStep("success");
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      showToast("Template imported successfully!", "success");
    },
    onError: (err) => showToast(`Import failed: ${err.message}`, "error"),
  });

  /* ── File handling ─────────────────────────────────────────────── */
  const processFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".json")) {
        showToast("Please select a .json template file", "error");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          analyzeMutation.mutate(parsed);
        } catch {
          showToast("Invalid JSON file", "error");
        }
      };
      reader.readAsText(file);
    },
    [analyzeMutation]
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleImport = () => {
    if (!rawTemplate) return;
    // Validate all required placeholders are filled
    const missing = (analysis?.placeholders ?? [])
      .filter((p) => p.required && !placeholderValues[p.key]?.trim());
    if (missing.length > 0) {
      showToast(`Fill all required fields: ${missing.map((p) => p.description).join(", ")}`, "error");
      return;
    }
    importMutation.mutate({ template: rawTemplate, placeholders: placeholderValues });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Import Template"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* ── Step 1: Upload ────────────────────────────────────────── */}
        {step === "upload" && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Import Template</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Upload an <code className="font-mono text-primary">.openzigs-template.json</code> file to import a prompt with its full pipeline configuration.
            </p>

            <div
              className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors ${
                dragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
              <p className="mb-2 text-sm text-muted-foreground">
                Drag & drop template file here
              </p>
              <p className="mb-3 text-xs text-muted-foreground">or</p>
              <label className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
                Browse Files
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </label>
            </div>

            {analyzeMutation.isPending && (
              <p className="mt-3 text-center text-xs text-muted-foreground">Analyzing template…</p>
            )}

            {analysis && !analysis.valid && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Invalid Template
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-destructive/80">
                  {analysis.errors.map((err, i) => (
                    <li key={i}>• {err.message}{err.path ? ` (${err.path})` : ""}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Preview & Placeholder Mapping ─────────────────── */}
        {step === "preview" && analysis?.valid && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Preview & Configure</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Review the template and fill in environment-specific values.
            </p>

            {/* Prompt summary */}
            <div className="mb-4 rounded-xl border border-border bg-muted/30 p-3 space-y-1">
              <p className="text-sm font-semibold text-foreground">{analysis.prompt?.name}</p>
              {analysis.prompt?.description && (
                <p className="text-xs text-muted-foreground">{analysis.prompt.description}</p>
              )}
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                {analysis.prompt?.stageCount && analysis.prompt.stageCount > 0 && (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400">
                    {analysis.prompt.stageCount} stage{analysis.prompt.stageCount !== 1 ? "s" : ""}
                  </span>
                )}
                {analysis.prompt?.tags && analysis.prompt.tags.length > 0 && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                    {analysis.prompt.tags.length} tag{analysis.prompt.tags.length !== 1 ? "s" : ""}
                  </span>
                )}
                {analysis.exportedFrom && (
                  <span className="text-muted-foreground/60">
                    from: {analysis.exportedFrom}
                  </span>
                )}
              </div>
            </div>

            {/* Placeholder inputs */}
            {analysis.placeholders.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Environment-Specific Values
                </p>
                {analysis.placeholders.map((p) => (
                  <PlaceholderInput
                    key={p.key}
                    placeholder={p}
                    value={placeholderValues[p.key] ?? ""}
                    onChange={(val) =>
                      setPlaceholderValues((prev) => ({ ...prev, [p.key]: val }))
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No environment-specific values needed — this template imports as-is.
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setStep("upload"); setAnalysis(null); setRawTemplate(null); }}
                className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={importMutation.isPending}
                className="rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
              >
                {importMutation.isPending ? "Importing…" : "Import Template"}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Success ───────────────────────────────────────── */}
        {step === "success" && importedPrompt && (
          <div className="text-center">
            <CheckCircle className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
            <h3 className="mb-1 text-sm font-semibold text-foreground">Template Imported!</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              &ldquo;{importedPrompt.name}&rdquo; has been added to your library.
            </p>
            <button
              onClick={onClose}
              className="rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Placeholder input subcomponent ─────────────────────────────── */

const PlaceholderInput = ({
  placeholder,
  value,
  onChange,
}: {
  placeholder: TemplatePlaceholder;
  value: string;
  onChange: (val: string) => void;
}) => (
  <div className="space-y-1">
    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      {placeholder.description}
      {placeholder.required && <span className="text-destructive">*</span>}
    </label>
    <input
      type="text"
      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground font-mono"
      placeholder={placeholder.defaultValue ?? `Enter ${placeholder.key}…`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
    <p className="text-[10px] text-muted-foreground/50 font-mono">{placeholder.path}</p>
  </div>
);
