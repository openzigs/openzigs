"use client";

import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { PipelineEditor, type AvailablePrompt } from "./pipeline-editor";
import { type ToolOption } from "./tool-multi-select";
import { Wand2, ArrowRight, ArrowLeft, Check, Loader2 } from "lucide-react";

/* ── Types ── */

type BackendPipelineNode = {
  type?: "prompt" | "parallel";
  name: string;
  prompt?: string;
  tools?: string[] | null;
  model?: string;
  timeoutSeconds?: number;
  branches?: BackendPipelineNode[];
};

type PlannerResponse = {
  rationale: string;
  pipeline: {
    stages: BackendPipelineNode[];
  };
};

type WizardStep = "goal" | "plan" | "edit" | "confirm";

export type WorkflowWizardProps = {
  /** Called when the user confirms the final pipeline. */
  onComplete?: (pipeline: { stages: BackendPipelineNode[] }) => void;
  /** Called when the wizard is cancelled. */
  onCancel?: () => void;
  /** Available tools for stage tool selection. */
  availableTools?: ToolOption[];
  /** Available saved prompts for the prompt selector. */
  availablePrompts?: AvailablePrompt[];
};

/* ── Step Indicator ── */

const STEPS: { key: WizardStep; label: string }[] = [
  { key: "goal", label: "Describe Goal" },
  { key: "plan", label: "Auto-Plan" },
  { key: "edit", label: "Edit Pipeline" },
  { key: "confirm", label: "Confirm" },
];

const StepIndicator = ({ current }: { current: WizardStep }) => (
  <div className="flex gap-2 items-center mb-6">
    {STEPS.map((step, i) => {
      const isActive = step.key === current;
      const isPast = STEPS.findIndex((s) => s.key === current) > i;
      return (
        <div key={step.key} className="flex items-center gap-2">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${
              isActive
                ? "bg-primary text-primary-foreground"
                : isPast
                  ? "bg-emerald-500 text-white"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {isPast ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span
            className={`text-xs font-medium ${
              isActive ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {step.label}
          </span>
          {i < STEPS.length - 1 && (
            <div className="h-px w-6 bg-border" />
          )}
        </div>
      );
    })}
  </div>
);

/* ── Main Wizard ── */

export const WorkflowWizard = ({ onComplete, onCancel, availableTools = [], availablePrompts = [] }: WorkflowWizardProps) => {
  const [step, setStep] = useState<WizardStep>("goal");
  const [goal, setGoal] = useState("");
  const [rationale, setRationale] = useState("");
  const [stages, setStages] = useState<BackendPipelineNode[]>([]);

  // Auto-plan mutation
  const planMutation = useMutation({
    mutationFn: (goalText: string) =>
      fetchJson<PlannerResponse>("/api/admin/pipeline/plan", {
        method: "POST",
        body: JSON.stringify({ goal: goalText }),
      }),
    onSuccess: (data) => {
      setRationale(data.rationale);
      setStages(data.pipeline.stages);
      setStep("edit");
      showToast("Pipeline planned successfully!", "success");
    },
    onError: (err) => {
      showToast(`Planning failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  const handlePlan = useCallback(() => {
    if (!goal.trim()) {
      showToast("Please describe your goal first.", "error");
      return;
    }
    planMutation.mutate(goal);
    setStep("plan");
  }, [goal, planMutation]);

  const handleSkipPlan = useCallback(() => {
    // Skip auto-plan and go straight to editor with a default 2-stage pipeline
    setStages([
      { type: "prompt", name: "stage-1", prompt: "", tools: null },
      { type: "prompt", name: "stage-2", prompt: "", tools: null },
    ]);
    setRationale("");
    setStep("edit");
  }, []);

  const handleEditorSave = useCallback((updated: BackendPipelineNode[]) => {
    setStages(updated);
    setStep("confirm");
  }, []);

  const handleConfirm = useCallback(() => {
    onComplete?.({ stages });
    showToast("Pipeline created!", "success");
  }, [stages, onComplete]);

  return (
    <div className="space-y-4">
      <StepIndicator current={step} />

      {/* Step 1: Goal */}
      {step === "goal" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Describe your workflow goal</h3>
            <p className="text-xs text-muted-foreground">
              Tell the planner what you want to accomplish. It will generate a multi-stage pipeline
              that breaks your goal into sequential and parallel steps.
            </p>
            <textarea
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm min-h-[120px] resize-y"
              placeholder="e.g., Research competitor pricing, analyze the data, then generate a report with recommendations and create GitHub issues for action items."
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePlan}
              disabled={!goal.trim()}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition disabled:opacity-40"
            >
              <Wand2 className="h-4 w-4" />
              Auto-Plan Pipeline
            </button>
            <button
              onClick={handleSkipPlan}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition"
            >
              Skip to Manual Editor
              <ArrowRight className="h-4 w-4" />
            </button>
            {onCancel && (
              <button
                onClick={onCancel}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step 2: Planning (loading) */}
      {step === "plan" && (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Planning your pipeline...</p>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            The AI planner is analyzing your goal and designing a multi-stage pipeline.
            This usually takes 10-30 seconds.
          </p>
        </div>
      )}

      {/* Step 3: Visual Editor */}
      {step === "edit" && (
        <div className="space-y-3">
          {rationale && (
            <div className="rounded-xl border border-border bg-sky-50 dark:bg-sky-950/30 p-3">
              <p className="text-xs font-medium text-sky-700 dark:text-sky-400">
                Planner Rationale: {rationale}
              </p>
            </div>
          )}
          <PipelineEditor
            initialStages={stages}
            onSave={handleEditorSave}
            onChange={handleEditorSave}
            height="450px"
            availableTools={availableTools}
            availablePrompts={availablePrompts}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setStep("goal")}
              className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-muted transition"
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Confirmation */}
      {step === "confirm" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Pipeline Summary</h3>
            <p className="text-xs text-muted-foreground">
              {stages.length} stage{stages.length !== 1 ? "s" : ""} configured
              {goal && ` for: "${goal.slice(0, 100)}${goal.length > 100 ? "..." : ""}"`}
            </p>
            <div className="space-y-2">
              {stages.map((stage, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      stage.type === "parallel" ? "bg-sky-500" : "bg-emerald-500"
                    }`}
                  />
                  <span className="text-sm font-medium text-foreground">{stage.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {stage.type === "parallel"
                      ? `${stage.branches?.length ?? 0} branches`
                      : (stage.prompt?.slice(0, 60) ?? "No prompt")}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("edit")}
              className="flex items-center gap-1 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted transition"
            >
              <ArrowLeft className="h-4 w-4" /> Edit Pipeline
            </button>
            <button
              onClick={handleConfirm}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition"
            >
              <Check className="h-4 w-4" /> Create Pipeline
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
