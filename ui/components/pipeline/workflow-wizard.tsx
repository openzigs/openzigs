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

type AutomationPlanResponse = PlannerResponse & {
  skill: { name: string; confidence: number; reason: string } | null;
  prompt: { name: string; template: string; variables: Record<string, string>; preferredTools: string[] } | null;
  schedule: { cronExpression: string; cronHumanReadable: string; timezone: string } | null;
  autoApproveTools: string[];
};

type WizardStep = "goal" | "plan" | "edit" | "confirm" | "review-automation" | "confirm-create";

export type WorkflowWizardProps = {
  /** Called when the user confirms the final pipeline. */
  onComplete?: (pipeline: { stages: BackendPipelineNode[] }) => void;
  /** Called when automation is fully created (prompt + job). */
  onAutomationCreated?: (result: { promptName: string; jobId?: string }) => void;
  /** Called when the wizard is cancelled. */
  onCancel?: () => void;
  /** Available tools for stage tool selection. */
  availableTools?: ToolOption[];
  /** Available saved prompts for the prompt selector. */
  availablePrompts?: AvailablePrompt[];
  /** Enable automation mode: skill + prompt + schedule flow. */
  automationMode?: boolean;
};

/* ── Step Indicator ── */

const PIPELINE_STEPS: { key: WizardStep; label: string }[] = [
  { key: "goal", label: "Describe Goal" },
  { key: "plan", label: "Auto-Plan" },
  { key: "edit", label: "Edit Pipeline" },
  { key: "confirm", label: "Confirm" },
];

const AUTOMATION_STEPS: { key: WizardStep; label: string }[] = [
  { key: "goal", label: "Describe Goal" },
  { key: "plan", label: "Auto-Plan" },
  { key: "edit", label: "Edit Pipeline" },
  { key: "review-automation", label: "Review" },
  { key: "confirm-create", label: "Create" },
];

const StepIndicator = ({ current, automationMode }: { current: WizardStep; automationMode?: boolean }) => {
  const steps = automationMode ? AUTOMATION_STEPS : PIPELINE_STEPS;
  return (
    <div className="flex gap-2 items-center mb-6">
      {steps.map((step, i) => {
        const isActive = step.key === current;
        const isPast = steps.findIndex((s) => s.key === current) > i;
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
            {i < steps.length - 1 && (
              <div className="h-px w-6 bg-border" />
            )}
          </div>
        );
      })}
    </div>
  );
};

/* ── Main Wizard ── */

export const WorkflowWizard = ({ onComplete, onAutomationCreated, onCancel, availableTools = [], availablePrompts = [], automationMode = false }: WorkflowWizardProps) => {
  const [step, setStep] = useState<WizardStep>("goal");
  const [goal, setGoal] = useState("");
  const [rationale, setRationale] = useState("");
  const [stages, setStages] = useState<BackendPipelineNode[]>([]);
  const [automationPlan, setAutomationPlan] = useState<AutomationPlanResponse | null>(null);
  const [editSkill, setEditSkill] = useState("");
  const [editPromptName, setEditPromptName] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editTimezone, setEditTimezone] = useState("UTC");
  const [creating, setCreating] = useState(false);

  // Auto-plan mutation
  const planMutation = useMutation({
    mutationFn: (goalText: string) =>
      fetchJson<PlannerResponse>(automationMode ? "/api/admin/automation/plan" : "/api/admin/pipeline/plan", {
        method: "POST",
        body: JSON.stringify({ goal: goalText }),
      }),
    onSuccess: (data) => {
      setRationale(data.rationale);
      setStages(data.pipeline.stages);
      if (automationMode && "skill" in data) {
        const autoPlan = data as unknown as AutomationPlanResponse;
        setAutomationPlan(autoPlan);
        setEditSkill(autoPlan.skill?.name ?? "");
        setEditPromptName(autoPlan.prompt?.name ?? goal.slice(0, 50));
        setEditCron(autoPlan.schedule?.cronExpression ?? "");
        setEditTimezone(autoPlan.schedule?.timezone ?? "UTC");
      }
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
    setStep(automationMode ? "review-automation" : "confirm");
  }, [automationMode]);

  const handleConfirm = useCallback(() => {
    onComplete?.({ stages });
    showToast("Pipeline created!", "success");
  }, [stages, onComplete]);

  return (
    <div className="space-y-4">
      <StepIndicator current={step} automationMode={automationMode} />

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

      {/* Step: Review Automation (automation mode only) */}
      {step === "review-automation" && automationPlan && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Automation Plan Review</h3>

            {/* Skill */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Recommended Skill</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={editSkill}
                onChange={(e) => setEditSkill(e.target.value)}
                placeholder="e.g., pinterest-marketer"
              />
              {automationPlan.skill && (
                <p className="text-[11px] text-muted-foreground">
                  {automationPlan.skill.reason} (confidence: {Math.round(automationPlan.skill.confidence * 100)}%)
                </p>
              )}
            </div>

            {/* Prompt Name */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Prompt Name</label>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={editPromptName}
                onChange={(e) => setEditPromptName(e.target.value)}
              />
            </div>

            {/* Prompt Template */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Prompt Template</label>
              <pre className="max-h-32 overflow-auto rounded-lg bg-muted p-2 text-xs">{automationPlan.prompt?.template ?? goal}</pre>
            </div>

            {/* Schedule */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground">Cron Expression</label>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
                  value={editCron}
                  onChange={(e) => setEditCron(e.target.value)}
                  placeholder="0 8 * * *"
                />
                {automationPlan.schedule && (
                  <p className="text-[11px] text-muted-foreground">{automationPlan.schedule.cronHumanReadable}</p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground">Timezone</label>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={editTimezone}
                  onChange={(e) => setEditTimezone(e.target.value)}
                />
              </div>
            </div>

            {/* Pipeline stages summary */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Pipeline Stages</label>
              <p className="text-xs text-muted-foreground">{stages.length} stage{stages.length !== 1 ? "s" : ""}</p>
            </div>

            {/* Tools */}
            {automationPlan.autoApproveTools.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground">Auto-Approve Tools</label>
                <div className="flex flex-wrap gap-1">
                  {automationPlan.autoApproveTools.map((t) => (
                    <span key={t} className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("edit")}
              className="flex items-center gap-1 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted transition"
            >
              <ArrowLeft className="h-4 w-4" /> Edit Pipeline
            </button>
            <button
              onClick={() => setStep("confirm-create")}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition"
            >
              Continue <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step: Confirm & Create (automation mode only) */}
      {step === "confirm-create" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Create Automation</h3>
            <p className="text-xs text-muted-foreground">
              This will create a saved prompt and{editCron ? " a scheduled job" : " no schedule (on-demand only)"}.
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Prompt:</span>
                <span className="font-medium">{editPromptName}</span>
              </div>
              {editSkill && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Skill:</span>
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600">★ {editSkill}</span>
                </div>
              )}
              {editCron && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Schedule:</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{editCron}</code>
                  <span className="text-xs text-muted-foreground">({editTimezone})</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Pipeline:</span>
                <span className="text-xs">{stages.length} stage{stages.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("review-automation")}
              className="flex items-center gap-1 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted transition"
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
            <button
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                try {
                  // 1. Create saved prompt
                  const promptBody = {
                    name: editPromptName,
                    template: automationPlan?.prompt?.template ?? goal,
                    suggestedSkill: editSkill || undefined,
                    preferredTools: automationPlan?.autoApproveTools ?? [],
                    stages: stages.length > 0 ? stages : undefined,
                  };
                  await fetchJson("/api/admin/prompts", {
                    method: "POST",
                    body: JSON.stringify(promptBody),
                  });

                  // 2. Create scheduled job (if cron specified)
                  let jobId: string | undefined;
                  if (editCron) {
                    const jobBody = {
                      name: editPromptName,
                      actionType: "prompt",
                      actionPayload: {
                        promptName: editPromptName,
                        skillName: editSkill || undefined,
                      },
                      cronExpression: editCron,
                      timezone: editTimezone,
                      autoApproveTools: automationPlan?.autoApproveTools ?? [],
                    };
                    const result = await fetchJson<{ id: string }>("/api/admin/jobs", {
                      method: "POST",
                      body: JSON.stringify(jobBody),
                    });
                    jobId = result.id;
                  }

                  showToast("Automation created!", "success");
                  onAutomationCreated?.({ promptName: editPromptName, jobId });
                } catch (err) {
                  showToast(`Creation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                } finally {
                  setCreating(false);
                }
              }}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {creating ? "Creating…" : "Create Automation"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
