"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ToastContainer, showToast } from "@/components/toast";
import {
  Plus,
  Edit,
  Trash2,
  Webhook,
  Terminal,
  Wrench,
  ArrowLeft,
  Zap,
  RotateCw,
  X,
} from "lucide-react";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type TemplateType = "webhook" | "script";

interface CustomFieldDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "array";
  title: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  enumLabels?: string[];
  placeholder?: string;
  minimum?: number;
  maximum?: number;
}

interface CustomPostAction {
  type: string;
  label: string;
  description: string;
  category: string;
  icon?: string;
  templateType?: TemplateType;
  templateConfig?: Record<string, unknown>;
  customFields?: CustomFieldDefinition[];
  scriptBody?: string;
  scriptTimeout?: number;
  createdAt: string;
  updatedAt: string;
}

interface BuiltinPostAction {
  type: string;
  label: string;
  description: string;
  category: string;
  icon?: string;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function PostActionsPage() {
  const queryClient = useQueryClient();

  const builtinQuery = useQuery({
    queryKey: ["post-actions"],
    queryFn: () => fetchJson<{ actions: BuiltinPostAction[] }>("/api/admin/post-actions"),
  });

  const customQuery = useQuery({
    queryKey: ["custom-post-actions"],
    queryFn: () =>
      fetchJson<{ actions: CustomPostAction[] }>("/api/admin/post-actions/custom"),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<CustomPostAction | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson<CustomPostAction>("/api/admin/post-actions/custom", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-post-actions"] });
      queryClient.invalidateQueries({ queryKey: ["post-actions"] });
      showToast("Post-action created", "success");
      setDialogOpen(false);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ type, body }: { type: string; body: Record<string, unknown> }) =>
      fetchJson<CustomPostAction>(
        `/api/admin/post-actions/custom/${encodeURIComponent(type)}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-post-actions"] });
      queryClient.invalidateQueries({ queryKey: ["post-actions"] });
      showToast("Post-action updated", "success");
      setDialogOpen(false);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (type: string) =>
      fetchJson(`/api/admin/post-actions/custom/${encodeURIComponent(type)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-post-actions"] });
      queryClient.invalidateQueries({ queryKey: ["post-actions"] });
      showToast("Post-action deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleCreate = () => {
    setEditingAction(null);
    setDialogOpen(true);
  };

  const handleEdit = (action: CustomPostAction) => {
    setEditingAction(action);
    setDialogOpen(true);
  };

  const handleSave = (body: Record<string, unknown>) => {
    if (editingAction) {
      updateMutation.mutate({ type: editingAction.type, body });
    } else {
      createMutation.mutate(body);
    }
  };

  const builtinActions = builtinQuery.data?.actions ?? [];
  const customActions = customQuery.data?.actions ?? [];
  // Separate built-in from custom in the builtin list via the custom list
  const customTypes = new Set(customActions.map((a) => a.type));
  const pureBuiltins = builtinActions.filter((a) => !customTypes.has(a.type));
  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <Link
          href="/admin"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Admin
        </Link>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
              OpenZigs
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-foreground">
              Post-Actions
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage deterministic actions that run after pipeline stages complete.
              Create custom webhook integrations, shell scripts, or advanced actions.
            </p>
          </div>
          <button
            onClick={handleCreate}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Post-Action
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-8">
        {/* Built-in Actions */}
        <SectionCard title="Built-in Actions">
          {builtinQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pureBuiltins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No built-in actions registered.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pureBuiltins.map((action) => (
                <BuiltinActionCard key={action.type} action={action} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* Custom Actions */}
        <SectionCard title="Custom Actions">
          {customQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : customActions.length === 0 ? (
            <div className="py-8 text-center">
              <Wrench className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                No custom post-actions yet. Click &ldquo;New Post-Action&rdquo; to create one.
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Custom actions appear in the post-action dropdown for every stage in the pipeline editor.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {customActions.map((action) => (
                <CustomActionCard
                  key={action.type}
                  action={action}
                  onEdit={() => handleEdit(action)}
                  onDelete={() => setPendingDelete(action.type)}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {dialogOpen && (
        <PostActionEditorDialog
          action={editingAction}
          onSave={handleSave}
          isSaving={isSaving}
          onClose={() => setDialogOpen(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete Post-Action"
          message={`Delete custom post-action "${pendingDelete}"? Stages currently using it will lose their post-action configuration.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => {
            deleteMutation.mutate(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <ToastContainer />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  Cards                                                             */
/* ------------------------------------------------------------------ */

const TEMPLATE_ICONS: Record<string, typeof Webhook> = {
  webhook: Webhook,
  script: Terminal,
};

const BuiltinActionCard = ({ action }: { action: BuiltinPostAction }) => (
  <div className="rounded-2xl border border-border bg-card p-4">
    <div className="mb-2 flex items-center gap-2">
      <Zap className="h-4 w-4 text-primary" />
      <span className="text-sm font-semibold text-foreground">{action.label}</span>
    </div>
    <p className="mb-2 text-xs text-muted-foreground">{action.description}</p>
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {action.category}
    </span>
    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      Built-in
    </span>
  </div>
);

const CustomActionCard = ({
  action,
  onEdit,
  onDelete,
}: {
  action: CustomPostAction;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const Icon = action.templateType
    ? (TEMPLATE_ICONS[action.templateType] ?? Wrench)
    : Wrench;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{action.label}</span>
        </div>
        {action.templateType && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary capitalize">
            {action.templateType}
          </span>
        )}
        {!action.templateType && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">
            Advanced
          </span>
        )}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{action.description}</p>
      <div className="mb-3">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {action.category}
        </span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onEdit}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-primary/30"
        >
          <Edit className="h-3 w-3" />
          Edit
        </button>
        <button
          onClick={onDelete}
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-destructive hover:border-destructive/30"
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Editor Dialog                                                     */
/* ------------------------------------------------------------------ */

type EditorMode = "template" | "advanced";

const PostActionEditorDialog = ({
  action,
  onSave,
  isSaving,
  onClose,
}: {
  action: CustomPostAction | null;
  onSave: (body: Record<string, unknown>) => void;
  isSaving: boolean;
  onClose: () => void;
}) => {
  const isEdit = !!action;

  // ── Determine initial mode ──
  const initialMode: EditorMode = action
    ? action.templateType
      ? "template"
      : "advanced"
    : "template";

  const [mode, setMode] = useState<EditorMode>(initialMode);

  // ── Common fields ──
  const [type, setType] = useState(action?.type ?? "");
  const [label, setLabel] = useState(action?.label ?? "");
  const [description, setDescription] = useState(action?.description ?? "");
  const [category, setCategory] = useState(action?.category ?? "Custom");

  // ── Template fields ──
  const [templateType, setTemplateType] = useState<TemplateType>(
    action?.templateType ?? "webhook",
  );
  const [webhookUrl, setWebhookUrl] = useState(
    (action?.templateConfig?.url as string) ?? "",
  );
  const [webhookMethod, setWebhookMethod] = useState(
    (action?.templateConfig?.method as string) ?? "POST",
  );
  const [webhookIncludeOutput, setWebhookIncludeOutput] = useState(
    (action?.templateConfig?.includeOutput as boolean) ?? true,
  );

  // ── Script fields (template + advanced) ──
  const [scriptBody, setScriptBody] = useState(action?.scriptBody ?? "");
  const [scriptTimeout, setScriptTimeout] = useState(
    action?.scriptTimeout ?? 30000,
  );

  // ── Advanced: custom config fields ──
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>(
    action?.customFields ?? [],
  );

  const [errors, setErrors] = useState<string[]>([]);

  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!type.trim()) errs.push("Type slug is required");
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(type))
      errs.push("Type must be lowercase alphanumeric with hyphens");
    if (!label.trim()) errs.push("Label is required");
    if (mode === "template" && templateType === "script" && !scriptBody.trim())
      errs.push("Script body is required for script template");
    if (mode === "advanced" && !scriptBody.trim())
      errs.push("Script body is required for advanced actions");
    if (
      mode === "advanced" &&
      customFields.some((f) => !f.key.trim() || !f.title.trim())
    )
      errs.push("All custom fields need a key and title");
    return errs;
  }, [type, label, mode, templateType, scriptBody, customFields]);

  const handleSave = () => {
    const errs = validate();
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);

    const body: Record<string, unknown> = {
      type: type.trim(),
      label: label.trim(),
      description: description.trim(),
      category: category.trim() || "Custom",
    };

    if (mode === "template") {
      body.templateType = templateType;
      if (templateType === "webhook") {
        body.templateConfig = {
          url: webhookUrl.trim() || undefined,
          method: webhookMethod,
          includeOutput: webhookIncludeOutput,
        };
      } else {
        body.scriptBody = scriptBody;
        body.scriptTimeout = scriptTimeout;
      }
    } else {
      // Advanced
      body.customFields = customFields;
      body.scriptBody = scriptBody;
      body.scriptTimeout = scriptTimeout;
    }

    onSave(body);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? "Edit Post-Action" : "Create Post-Action"}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="mb-4 text-lg font-semibold text-foreground">
          {isEdit ? "Edit Post-Action" : "Create Post-Action"}
        </h3>

        {errors.length > 0 && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-destructive">
                {e}
              </p>
            ))}
          </div>
        )}

        {/* ── Mode Tabs ── */}
        {!isEdit && (
          <div className="mb-5 flex gap-2">
            <button
              onClick={() => setMode("template")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                mode === "template"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              <Webhook className="h-3.5 w-3.5" />
              Template
            </button>
            <button
              onClick={() => setMode("advanced")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                mode === "advanced"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              Advanced
            </button>
          </div>
        )}

        <div className="space-y-4">
          {/* Common fields */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Type Slug
              </label>
              <input
                type="text"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground disabled:opacity-40"
                placeholder="custom-slack-notify"
                value={type}
                onChange={(e) =>
                  setType(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, ""),
                  )
                }
                disabled={isEdit}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Display Label
              </label>
              <input
                type="text"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                placeholder="Slack Notification"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Description
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Send a summary to the #deployments Slack channel"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Category
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Notifications"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>

          {/* ── Template Mode ── */}
          {mode === "template" && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Template Type
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTemplateType("webhook")}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                      templateType === "webhook"
                        ? "border border-primary bg-primary/10 text-primary"
                        : "border border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    <Webhook className="h-3.5 w-3.5" />
                    Webhook
                  </button>
                  <button
                    onClick={() => setTemplateType("script")}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                      templateType === "script"
                        ? "border border-primary bg-primary/10 text-primary"
                        : "border border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    Shell Script
                  </button>
                </div>
              </div>

              {templateType === "webhook" && (
                <WebhookTemplateForm
                  url={webhookUrl}
                  setUrl={setWebhookUrl}
                  method={webhookMethod}
                  setMethod={setWebhookMethod}
                  includeOutput={webhookIncludeOutput}
                  setIncludeOutput={setWebhookIncludeOutput}
                />
              )}

              {templateType === "script" && (
                <ScriptForm
                  scriptBody={scriptBody}
                  setScriptBody={setScriptBody}
                  scriptTimeout={scriptTimeout}
                  setScriptTimeout={setScriptTimeout}
                />
              )}
            </>
          )}

          {/* ── Advanced Mode ── */}
          {mode === "advanced" && (
            <>
              <ScriptForm
                scriptBody={scriptBody}
                setScriptBody={setScriptBody}
                scriptTimeout={scriptTimeout}
                setScriptTimeout={setScriptTimeout}
              />
              <CustomFieldsEditor
                fields={customFields}
                onChange={setCustomFields}
              />
            </>
          )}
        </div>

        {/* Dialog Actions */}
        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {isSaving ? (
              <>
                <RotateCw className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : isEdit ? (
              "Save Changes"
            ) : (
              "Create Post-Action"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Webhook Template Form                                             */
/* ------------------------------------------------------------------ */

const WebhookTemplateForm = ({
  url,
  setUrl,
  method,
  setMethod,
  includeOutput,
  setIncludeOutput,
}: {
  url: string;
  setUrl: (v: string) => void;
  method: string;
  setMethod: (v: string) => void;
  includeOutput: boolean;
  setIncludeOutput: (v: boolean) => void;
}) => (
  <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
    <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      Webhook Defaults
    </h4>
    <p className="text-[11px] text-muted-foreground/70">
      Set default values here. Users can override them per-stage in the pipeline editor.
      Leave URL empty to require it at the stage level.
    </p>
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        Default URL
      </label>
      <input
        type="text"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        placeholder="https://hooks.slack.com/services/..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
    </div>
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          HTTP Method
        </label>
        <select
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
        </select>
      </div>
      <div className="flex items-end">
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            className="rounded border-border"
            checked={includeOutput}
            onChange={(e) => setIncludeOutput(e.target.checked)}
          />
          <span className="text-xs text-muted-foreground">
            Include stage output
          </span>
        </label>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Script Form                                                       */
/* ------------------------------------------------------------------ */

const ScriptForm = ({
  scriptBody,
  setScriptBody,
  scriptTimeout,
  setScriptTimeout,
}: {
  scriptBody: string;
  setScriptBody: (v: string) => void;
  scriptTimeout: number;
  setScriptTimeout: (v: number) => void;
}) => (
  <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
    <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      Shell Script
    </h4>
    <p className="text-[11px] text-muted-foreground/70">
      Stage output is piped to stdin. Config values are available as{" "}
      <code className="text-[10px]">OPENZIGS_CONFIG_*</code> environment variables.
    </p>
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        Script Body
      </label>
      <textarea
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
        rows={6}
        placeholder={'#!/bin/sh\n# Stage output on stdin\ncat | curl -X POST -d @- "$OPENZIGS_CONFIG_URL"'}
        value={scriptBody}
        onChange={(e) => setScriptBody(e.target.value)}
      />
    </div>
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        Timeout (ms)
      </label>
      <input
        type="number"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        value={scriptTimeout}
        onChange={(e) => setScriptTimeout(Number(e.target.value))}
        min={1000}
        max={300000}
      />
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Custom Fields Editor (Advanced mode)                              */
/* ------------------------------------------------------------------ */

const FIELD_TYPES = ["string", "number", "boolean", "array"] as const;

const CustomFieldsEditor = ({
  fields,
  onChange,
}: {
  fields: CustomFieldDefinition[];
  onChange: (fields: CustomFieldDefinition[]) => void;
}) => {
  const addField = () => {
    onChange([
      ...fields,
      { key: "", type: "string", title: "", required: false },
    ]);
  };

  const removeField = (idx: number) => {
    onChange(fields.filter((_, i) => i !== idx));
  };

  const updateField = (idx: number, patch: Partial<CustomFieldDefinition>) => {
    onChange(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Config Fields
          </h4>
          <p className="text-[11px] text-muted-foreground/70">
            Define the configuration form users see when selecting this action in
            the stage editor.
          </p>
        </div>
        <button
          onClick={addField}
          className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary/90"
        >
          <Plus className="h-3 w-3" />
          Add Field
        </button>
      </div>

      {fields.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          No config fields defined. Your script will receive stage output only.
        </p>
      )}

      <div className="space-y-3">
        {fields.map((field, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-border bg-card p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground">
                Field #{idx + 1}
              </span>
              <button
                onClick={() => removeField(idx)}
                className="text-destructive hover:text-destructive/80"
                aria-label="Remove field"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Key</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
                  placeholder="url"
                  value={field.key}
                  onChange={(e) =>
                    updateField(idx, {
                      key: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, ""),
                    })
                  }
                />
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">
                  Title
                </label>
                <input
                  type="text"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  placeholder="Webhook URL"
                  value={field.title}
                  onChange={(e) =>
                    updateField(idx, { title: e.target.value })
                  }
                />
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Type</label>
                <select
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  value={field.type}
                  onChange={(e) =>
                    updateField(idx, {
                      type: e.target.value as CustomFieldDefinition["type"],
                    })
                  }
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">
                  Description
                </label>
                <input
                  type="text"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  placeholder="The webhook endpoint URL"
                  value={field.description ?? ""}
                  onChange={(e) =>
                    updateField(idx, {
                      description: e.target.value || undefined,
                    })
                  }
                />
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">
                  Placeholder
                </label>
                <input
                  type="text"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  placeholder="https://..."
                  value={field.placeholder ?? ""}
                  onChange={(e) =>
                    updateField(idx, {
                      placeholder: e.target.value || undefined,
                    })
                  }
                />
              </div>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={field.required ?? false}
                onChange={(e) =>
                  updateField(idx, { required: e.target.checked })
                }
              />
              <span className="text-[10px] text-muted-foreground">Required</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
};
