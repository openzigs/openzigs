"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { PersonalityConfig } from "@/lib/types";
import { showToast } from "@/components/toast";
import { RotateCw, Eye, EyeOff, RotateCcw, AlertTriangle } from "lucide-react";

export const PersonalityPanel = () => {
  const queryClient = useQueryClient();
  const [showPreview, setShowPreview] = useState(false);

  const query = useQuery({
    queryKey: ["personality"],
    queryFn: () => fetchJson<PersonalityConfig>("/api/admin/personality"),
  });

  const config = query.data;

  const [systemInstruction, setSystemInstruction] = useState("");
  const [prePrompt, setPrePrompt] = useState("");
  const [postPrompt, setPostPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<"append" | "replace">("append");

  // Sync form state when data loads
  useEffect(() => {
    if (config) {
      setSystemInstruction(config.systemInstruction);
      setPrePrompt(config.prePrompt);
      setPostPrompt(config.postPrompt);
      setEnabled(config.enabled);
      setMode(config.mode ?? "append");
    }
  }, [config]);

  const hasChanges =
    config &&
    (systemInstruction !== config.systemInstruction ||
      prePrompt !== config.prePrompt ||
      postPrompt !== config.postPrompt ||
      enabled !== config.enabled ||
      mode !== (config.mode ?? "append"));

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson<PersonalityConfig>("/api/admin/personality", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personality"] });
      showToast("Personality saved", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      fetchJson<PersonalityConfig>("/api/admin/personality/reset", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["personality"] });
      setSystemInstruction(data.systemInstruction);
      setPrePrompt(data.prePrompt);
      setPostPrompt(data.postPrompt);
      setEnabled(data.enabled);
      setMode(data.mode ?? "append");
      showToast("Personality reset to defaults", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleSave = () => {
    saveMutation.mutate({ systemInstruction, prePrompt, postPrompt, enabled, mode });
  };

  const handleReset = () => {
    if (!confirm("Reset personality to defaults? Your current settings will be lost.")) return;
    resetMutation.mutate();
  };

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading personality…</p>;
  }

  if (query.isError) {
    return <p className="text-sm text-destructive">Failed to load personality settings.</p>;
  }

  return (
    <div className="space-y-5">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Personality Injection</p>
          <p className="text-xs text-muted-foreground">
            When enabled, system instruction and pre/post prompts wrap every conversation.
          </p>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            enabled ? "bg-moss" : "bg-muted"
          }`}
          role="switch"
          aria-checked={enabled}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Mode selector */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">System Prompt Mode</p>
        <div className="flex gap-2" role="radiogroup" aria-label="System Prompt Mode">
          {(["append", "replace"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              disabled={!enabled}
              className={`rounded-lg border px-4 py-2 text-xs font-semibold capitalize transition disabled:opacity-40 ${
                mode === m
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/30"
              }`}
            >
              {m}{m === "append" ? " (recommended)" : ""}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          &ldquo;Append&rdquo; keeps Copilot SDK safety guardrails and adds your instructions. &ldquo;Replace&rdquo; overrides ALL default system behavior.
        </p>
        {mode === "replace" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Replace mode removes all SDK safety guardrails. The model will follow ONLY your system instruction. Use with caution.
            </p>
          </div>
        )}
      </div>

      {/* System Instruction */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          System Instruction (Persona)
        </label>
        <textarea
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
          rows={3}
          placeholder="You are a helpful AI assistant…"
          value={systemInstruction}
          onChange={(e) => setSystemInstruction(e.target.value)}
          disabled={!enabled}
        />
        <p className="text-[11px] text-muted-foreground/60">
          Defines who the AI is. Injected as the system-level instruction.
        </p>
      </div>

      {/* Pre-Prompt */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Pre-Prompt</label>
        <textarea
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
          rows={2}
          placeholder="Instructions injected before the user's message…"
          value={prePrompt}
          onChange={(e) => setPrePrompt(e.target.value)}
          disabled={!enabled}
        />
        <p className="text-[11px] text-muted-foreground/60">
          Injected before the conversation history. Use for output format instructions, constraints, etc.
        </p>
      </div>

      {/* Post-Prompt */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Post-Prompt</label>
        <textarea
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
          rows={2}
          placeholder="Instructions injected after the user's message…"
          value={postPrompt}
          onChange={(e) => setPostPrompt(e.target.value)}
          disabled={!enabled}
        />
        <p className="text-[11px] text-muted-foreground/60">
          Injected after the user&apos;s message. Use for guardrails, tone correction, or final instructions.
        </p>
      </div>

      {/* Preview */}
      <div>
        <button
          onClick={() => setShowPreview(!showPreview)}
          className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {showPreview ? "Hide Preview" : "Show Prompt Preview"}
        </button>
        {showPreview && (
          <div className="mt-2 rounded-lg border border-border bg-muted/50 p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              How a message &ldquo;Hello&rdquo; would be composed:
            </p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">
              {enabled
                ? buildPreview(systemInstruction, prePrompt, postPrompt, mode)
                : "(Personality injection disabled — raw message sent)"}
            </pre>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={resetMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to Defaults
          </button>
        </div>
        <div className="flex items-center gap-2">
          {config && (
            <p className="text-[11px] text-muted-foreground">
              Last saved {new Date(config.updatedAt).toLocaleString()}
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {saveMutation.isPending ? (
              <>
                <RotateCw className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save Personality"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

function buildPreview(
  systemInstruction: string,
  prePrompt: string,
  postPrompt: string,
  mode: "append" | "replace"
): string {
  const lines: string[] = [];

  if (mode === "append") {
    lines.push("[SDK Default Guardrails]");
    lines.push("");
  }

  if (systemInstruction) {
    lines.push(`System: ${systemInstruction}`);
    lines.push("");
  }
  if (prePrompt) {
    lines.push(prePrompt);
    lines.push("");
  }
  lines.push("Conversation so far:");
  lines.push("  (previous messages…)");
  lines.push("");
  lines.push("User: Hello");
  if (postPrompt) {
    lines.push("");
    lines.push(postPrompt);
  }

  if (mode === "replace") {
    lines.push("");
    lines.push("⚠ No SDK guardrails applied (Replace mode)");
  }

  return lines.join("\n");
}
