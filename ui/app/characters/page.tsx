"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { buildMediaUrl } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TelegramNotifyToggle } from "@/components/telegram-notify-toggle";
import {
  User,
  Plus,
  Trash2,
  Upload,
  Loader2,
  Zap,
  CheckCircle,
  AlertCircle,
  Clock,
  Sparkles,
  Info,
  RotateCcw,
  Pause,
  Play,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

interface CharacterProfile {
  id: string;
  name: string;
  description: string;
  triggerWord: string;
  referencePhotos: string[];
  photoCaptions: Record<string, string>;
  trainedLoraPath: string | null;
  loraScale: number;
  trainingConfig: Record<string, unknown> | null;
  status: "pending" | "training" | "ready" | "failed";
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────

function statusBadge(status: CharacterProfile["status"]) {
  const map = {
    pending: {
      icon: <Clock className="h-3 w-3" />,
      label: "Pending",
      classes: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    },
    training: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      label: "Training",
      classes: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    ready: {
      icon: <CheckCircle className="h-3 w-3" />,
      label: "Ready",
      classes: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    failed: {
      icon: <AlertCircle className="h-3 w-3" />,
      label: "Failed",
      classes: "bg-red-500/10 text-red-600 dark:text-red-400",
    },
  };
  const b = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.classes}`}
    >
      {b.icon} {b.label}
    </span>
  );
}

function photoUrl(characterId: string, photoPath: string): string {
  const filename = photoPath.split(/[\/\\]/).pop() ?? "";
  return buildMediaUrl(
    `/api/characters/${characterId}/photos/${encodeURIComponent(filename)}`,
  );
}

// ── Page ────────────────────────────────────────────────────

export default function CharactersPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── State ─────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createTrigger, setCreateTrigger] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createScale, setCreateScale] = useState(0.8);
  const [selectedChar, setSelectedChar] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CharacterProfile | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [dragFileCount, setDragFileCount] = useState(0);

  // Training config
  const [trainSteps, setTrainSteps] = useState(25);
  const [trainLR, setTrainLR] = useState(0.0001);
  const [trainRank, setTrainRank] = useState(16);
  const [trainEpochs, setTrainEpochs] = useState(200);
  const [trainNotifyViaTelegram, setTrainNotifyViaTelegram] = useState(false);

  // AI Enhance model selection dialog
  const [showEnhanceDialog, setShowEnhanceDialog] = useState(false);
  const [enhanceModel, setEnhanceModel] = useState<string>("");

  // Resume training
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [resumeCharId, setResumeCharId] = useState<string | null>(null);
  const [trainingPaused, setTrainingPaused] = useState(false);

  // ── Queries ───────────────────────────────────────────
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: () =>
      fetchJson<{ characters: CharacterProfile[] }>("/api/characters"),
    refetchInterval: 5000,
  });

  const characters = charactersQuery.data?.characters ?? [];
  const selected = characters.find((c) => c.id === selectedChar) ?? null;

  // Fetch available models for AI Enhance model picker
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      fetchJson<{ models: { id: string }[]; selectedModel?: string | null }>(
        "/api/models",
      ),
    enabled: showEnhanceDialog,
    staleTime: 30_000,
  });

  // ── Mutations ─────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      triggerWord: string;
      loraScale: number;
    }) =>
      fetchJson<CharacterProfile>("/api/characters", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: (char) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      showToast(`Character '${char.name}' created`, "success");
      setShowCreate(false);
      setCreateName("");
      setCreateTrigger("");
      setCreateDescription("");
      setCreateScale(0.8);
      setSelectedChar(char.id);
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean }>(`/api/characters/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      showToast("Character deleted", "success");
      if (selectedChar === deleteTarget?.id) setSelectedChar(null);
      setDeleteTarget(null);
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ id, files }: { id: string; files: FileList }) => {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append("photos", files[i]);
      }
      const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(buildUrl(`/api/characters/${id}/photos`), {
        method: "POST",
        headers,
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ uploaded: number; totalPhotos: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      showToast(`Uploaded ${data.uploaded} photo(s)`, "success");
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const trainMutation = useMutation({
    mutationFn: (data: {
      id: string;
      steps: number;
      learningRate: number;
      loraRank: number;
      numEpochs: number;
      notifyViaTelegram?: boolean;
    }) =>
      fetchJson<{ ok: boolean; message: string }>(
        `/api/characters/${data.id}/train`,
        {
          method: "POST",
          body: JSON.stringify({
            steps: data.steps,
            learningRate: data.learningRate,
            loraRank: data.loraRank,
            numEpochs: data.numEpochs,
            notifyViaTelegram: data.notifyViaTelegram,
          }),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      showToast(data.message, "success");
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const resumeMutation = useMutation({
    mutationFn: ({
      id,
      checkpoint_path,
    }: {
      id: string;
      checkpoint_path: string;
    }) =>
      fetchJson<{ ok: boolean; message: string }>(
        `/api/characters/${id}/resume-training`,
        {
          method: "POST",
          body: JSON.stringify({ checkpoint_path }),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      setShowResumeDialog(false);
      setTrainingPaused(false);
      showToast(data.message, "success");
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const pauseMutation = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      fetchJson<{ ok: boolean; message: string }>(
        `/api/characters/${id}/${paused ? "pause" : "unpause"}-training`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      setTrainingPaused(variables.paused);
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const recoverMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<{
        ok: boolean;
        recovered: boolean;
        message: string;
        loraPath?: string;
      }>(`/api/characters/${id}/recover-training`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      showToast(data.message, data.recovered ? "success" : "info");
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const checkpointsQuery = useQuery({
    queryKey: ["train-checkpoints", resumeCharId],
    queryFn: () =>
      fetchJson<{
        character_id: string;
        checkpoints: Array<{ path: string; name: string; size: number }>;
        train_dir: string;
      }>(`/api/characters/${resumeCharId}/checkpoints`),
    enabled: showResumeDialog && !!resumeCharId,
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      silent: _silent,
      ...data
    }: {
      id: string;
      silent?: boolean;
      loraScale?: number;
      name?: string;
      triggerWord?: string;
      description?: string;
      photoCaptions?: Record<string, string>;
    }) =>
      fetchJson<CharacterProfile>(`/api/characters/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      if (!variables.silent) {
        showToast("Character updated", "success");
      }
    },
    onError: (err) => showToast(err.message, "error"),
  });

  const aiEnhanceMutation = useMutation({
    mutationFn: ({ id, model }: { id: string; model?: string }) =>
      fetchJson<{
        captions: Record<string, string>;
        totalSteps: number;
        model?: string;
      }>(`/api/characters/${id}/ai-enhance`, {
        method: "POST",
        body: JSON.stringify(model ? { model } : {}),
      }),
    onSuccess: (data, { id }) => {
      // Apply captions only — training params are intentionally not changed by AI Enhance
      updateMutation.mutate({ id, photoCaptions: data.captions, silent: true });
      showToast(
        `AI enhanced: ${Object.keys(data.captions).length} captions generated (${data.model ?? "default"})`,
        "success",
      );
    },
    onError: (err) => showToast(err.message, "error"),
  });

  // ── Handlers ──────────────────────────────────────────
  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim() || !createTrigger.trim()) return;
    createMutation.mutate({
      name: createName.trim(),
      description: createDescription.trim(),
      triggerWord: createTrigger.trim(),
      loraScale: createScale,
    });
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || !selected) return;
    uploadMutation.mutate({ id: selected.id, files: e.target.files });
    e.target.value = "";
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragFileCount(e.dataTransfer.items.length);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
      setDragFileCount(0);
    }
  }

  function handleDrop(e: React.DragEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    setDragFileCount(0);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadMutation.mutate({ id, files });
    }
  }

  // ── Render ────────────────────────────────────────────
  return (
    <main className="container mx-auto max-w-7xl space-y-6 p-6">
      <ToastContainer />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Character Lab</h1>
          <p className="text-sm text-muted-foreground">
            Create characters with LoRA training for consistent identity across
            generations
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New Character
        </button>
      </div>

      {/* Create Dialog */}
      {showCreate && (
        <SectionCard title="Create Character" className="border-primary/20">
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Character Name</label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Alice"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium">Trigger Word</label>
                <input
                  type="text"
                  value={createTrigger}
                  onChange={(e) => setCreateTrigger(e.target.value)}
                  placeholder="e.g. ALICE_TOK"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Unique token to trigger character identity in prompts
                </p>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <input
                type="text"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="e.g. a husky dog with blue eyes"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Describes what the character looks like — used in training
                prompts for better LoRA quality
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">
                LoRA Scale: {createScale}
              </label>
              <p className="mb-1 text-[10px] text-muted-foreground">
                How strongly the character identity overrides the base model.
                0.6–0.7 = good balance (works with other subjects in scene).
                0.8+ = strong likeness but may prevent other characters from
                appearing.
              </p>
              <input
                type="range"
                min={0.1}
                max={1.5}
                step={0.05}
                value={createScale}
                onChange={(e) => setCreateScale(parseFloat(e.target.value))}
                className="mt-1 w-full"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Create"
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          </form>
        </SectionCard>
      )}

      {/* Characters Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Character List */}
        <div className="space-y-3 lg:col-span-1">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Characters ({characters.length})
          </h2>
          {charactersQuery.isPending && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {characters.length === 0 && !charactersQuery.isPending && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              <User className="mx-auto h-8 w-8 mb-2 opacity-50" />
              No characters yet. Click &quot;New Character&quot; to get started.
            </div>
          )}
          {characters.map((char) => (
            <button
              key={char.id}
              onClick={() => setSelectedChar(char.id)}
              className={`w-full rounded-lg border p-4 text-left transition-colors ${
                selectedChar === char.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-accent/50"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{char.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                      {char.triggerWord}
                    </code>
                    {statusBadge(char.status)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {char.referencePhotos.length} photo
                    {char.referencePhotos.length !== 1 ? "s" : ""}
                    {" · LoRA "}
                    {char.loraScale}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(char);
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </button>
          ))}
        </div>

        {/* Detail Panel */}
        <div className="lg:col-span-2">
          {!selected && (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-12 text-sm text-muted-foreground">
              Select a character to view details
            </div>
          )}
          {selected && (
            <div className="space-y-6">
              {/* Character Header */}
              <SectionCard title={selected.name}>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">
                        Trigger Word:
                      </span>{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {selected.triggerWord}
                      </code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status:</span>{" "}
                      {statusBadge(selected.status)}
                    </div>
                    <div className="col-span-2">
                      <span className="text-muted-foreground">
                        Description:
                      </span>{" "}
                      <input
                        type="text"
                        value={selected.description}
                        onChange={(e) =>
                          updateMutation.mutate({
                            id: selected.id,
                            description: e.target.value,
                            silent: true,
                          })
                        }
                        placeholder="e.g. a husky dog with blue eyes"
                        className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs"
                      />
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Used in training prompts so the LoRA learns what the
                        trigger word represents
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">LoRA Scale:</span>{" "}
                      <input
                        type="number"
                        min={0.1}
                        max={1.5}
                        step={0.05}
                        value={selected.loraScale}
                        onChange={(e) =>
                          updateMutation.mutate({
                            id: selected.id,
                            loraScale: parseFloat(e.target.value),
                          })
                        }
                        className="w-20 rounded border border-border bg-background px-2 py-0.5 text-xs"
                      />
                    </div>
                    <div>
                      <span className="text-muted-foreground">Photos:</span>{" "}
                      {selected.referencePhotos.length}
                    </div>
                    {selected.trainedLoraPath && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">
                          LoRA Path:
                        </span>{" "}
                        <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {selected.trainedLoraPath}
                        </code>
                      </div>
                    )}
                    {selected.errorMessage && (
                      <div className="col-span-2 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                        <AlertCircle className="mr-1 inline h-3 w-3" />
                        {selected.errorMessage}
                      </div>
                    )}
                  </div>
                </div>
              </SectionCard>

              {/* Reference Photos with Captions */}
              <SectionCard
                title={`Reference Photos (${selected.referencePhotos.length})`}
              >
                <div className="space-y-4">
                  {selected.referencePhotos.length > 0 && (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                      {selected.referencePhotos.map((photo, i) => {
                        const filename = photo.split(/[\/\\]/).pop() ?? "";
                        const caption =
                          selected.photoCaptions?.[filename] ?? "";
                        return (
                          <div key={i} className="space-y-1">
                            <div className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted">
                              <img
                                src={photoUrl(selected.id, photo)}
                                alt={`Reference ${i + 1}`}
                                className="h-full w-full object-cover"
                              />
                              <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 text-[9px] text-white/80 truncate">
                                {filename}
                              </div>
                            </div>
                            <input
                              type="text"
                              value={caption}
                              onChange={(e) => {
                                const updated = {
                                  ...selected.photoCaptions,
                                  [filename]: e.target.value,
                                };
                                updateMutation.mutate({
                                  id: selected.id,
                                  photoCaptions: updated,
                                  silent: true,
                                });
                              }}
                              placeholder="Caption for training..."
                              className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[10px] placeholder:text-muted-foreground/50"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Drag-and-drop upload zone */}
                  <div
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, selected.id)}
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    aria-label="Upload reference photos"
                    onKeyDown={(e) =>
                      e.key === "Enter" && fileInputRef.current?.click()
                    }
                    className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                      isDragging
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50 hover:bg-accent/50"
                    }`}
                  >
                    {uploadMutation.isPending ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />{" "}
                        Uploading...
                      </div>
                    ) : isDragging ? (
                      <div className="text-center">
                        <Upload className="mx-auto h-8 w-8 text-primary" />
                        <p className="mt-2 text-sm font-medium text-primary">
                          {dragFileCount > 0
                            ? `Drop ${dragFileCount} photo${dragFileCount !== 1 ? "s" : ""}`
                            : "Drop photos here"}
                        </p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
                        <p className="mt-2 text-sm font-medium">
                          Drop photos here or click to browse
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          JPEG, PNG, WebP, HEIC · up to 20 files · 20 MB each
                        </p>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload 10–20 reference photos from various angles and
                    lighting conditions. Minimum 5 photos required for training.
                  </p>
                </div>
              </SectionCard>

              {/* Training Controls */}
              <SectionCard title="LoRA Training">
                <div className="space-y-4">
                  {/* AI Enhance Button */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        setEnhanceModel("");
                        setShowEnhanceDialog(true);
                      }}
                      disabled={
                        aiEnhanceMutation.isPending ||
                        !selected.description ||
                        selected.referencePhotos.length === 0
                      }
                      className="inline-flex items-center gap-2 rounded-md border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-500/20 disabled:opacity-50 dark:text-purple-300"
                    >
                      {aiEnhanceMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      AI Enhance
                    </button>
                    <span className="text-[10px] text-muted-foreground">
                      {!selected.description
                        ? "Set a description first to enable AI enhance"
                        : "Uses AI to generate unique varied captions for each photo (training params unchanged)"}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div>
                      <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        Epochs
                        <span className="group relative cursor-help">
                          <Info className="h-3 w-3 opacity-50" />
                          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-56 -translate-x-1/2 rounded-md bg-popover px-3 py-2 text-[10px] leading-snug text-popover-foreground shadow-md border border-border opacity-0 transition-opacity group-hover:opacity-100">
                            Number of full passes over all reference photos.
                            Total training steps = epochs × photo count.
                            Recommended: 150–200 with 5+ photos (≈1000
                            steps). More photos = fewer epochs needed.
                          </span>
                        </span>
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={trainEpochs}
                        onChange={(e) =>
                          setTrainEpochs(parseInt(e.target.value))
                        }
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      />
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        ~{trainEpochs * (selected.referencePhotos.length || 1)}{" "}
                        total steps
                      </p>
                    </div>
                    <div>
                      <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        Inference Steps
                        <span className="group relative cursor-help">
                          <Info className="h-3 w-3 opacity-50" />
                          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-56 -translate-x-1/2 rounded-md bg-popover px-3 py-2 text-[10px] leading-snug text-popover-foreground shadow-md border border-border opacity-0 transition-opacity group-hover:opacity-100">
                            Denoising steps during training&apos;s internal
                            image generation. For Flux Dev, 20–30 steps is
                            ideal. Higher values improve quality but are slower.
                          </span>
                        </span>
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        step={1}
                        value={trainSteps}
                        onChange={(e) =>
                          setTrainSteps(parseInt(e.target.value))
                        }
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        Learning Rate
                        <span className="group relative cursor-help">
                          <Info className="h-3 w-3 opacity-50" />
                          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-56 -translate-x-1/2 rounded-md bg-popover px-3 py-2 text-[10px] leading-snug text-popover-foreground shadow-md border border-border opacity-0 transition-opacity group-hover:opacity-100">
                            How aggressively LoRA weights update per step. 1e-4
                            (0.0001) is standard. Too high →
                            artifacts/overfitting. Too low → LoRA learns
                            nothing.
                          </span>
                        </span>
                      </label>
                      <input
                        type="number"
                        min={0.00001}
                        max={0.01}
                        step={0.00001}
                        value={trainLR}
                        onChange={(e) => setTrainLR(parseFloat(e.target.value))}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        LoRA Rank
                        <span className="group relative cursor-help">
                          <Info className="h-3 w-3 opacity-50" />
                          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-56 -translate-x-1/2 rounded-md bg-popover px-3 py-2 text-[10px] leading-snug text-popover-foreground shadow-md border border-border opacity-0 transition-opacity group-hover:opacity-100">
                            Dimensionality of LoRA adapter. Higher → more
                            expressive but uses more memory. 16 is good for
                            most subjects. 32 gives highest fidelity for
                            complex patterns (unique markings, multi-color
                            coats). Use 8 for simple styles or limited VRAM.
                          </span>
                        </span>
                      </label>
                      <select
                        value={trainRank}
                        onChange={(e) => setTrainRank(parseInt(e.target.value))}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      >
                        <option value={4}>4</option>
                        <option value={8}>8</option>
                        <option value={16}>16 (default)</option>
                        <option value={32}>32 (high fidelity)</option>
                      </select>
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      trainMutation.mutate({
                        id: selected.id,
                        steps: trainSteps,
                        learningRate: trainLR,
                        loraRank: trainRank,
                        numEpochs: trainEpochs,
                        notifyViaTelegram: trainNotifyViaTelegram || undefined,
                      })
                    }
                    disabled={
                      trainMutation.isPending ||
                      selected.status === "training" ||
                      selected.referencePhotos.length < 5
                    }
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {trainMutation.isPending ||
                    selected.status === "training" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    {selected.status === "training"
                      ? "Training in Progress..."
                      : "Start Training"}
                  </button>
                  <TelegramNotifyToggle
                    compact
                    checked={trainNotifyViaTelegram}
                    onChange={setTrainNotifyViaTelegram}
                    disabled={
                      trainMutation.isPending || selected.status === "training"
                    }
                  />
                  {selected.status === "training" && (
                    <button
                      onClick={() =>
                        pauseMutation.mutate({
                          id: selected.id,
                          paused: !trainingPaused,
                        })
                      }
                      disabled={pauseMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      title={
                        trainingPaused ? "Resume training" : "Pause training"
                      }
                    >
                      {pauseMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : trainingPaused ? (
                        <Play className="h-4 w-4" />
                      ) : (
                        <Pause className="h-4 w-4" />
                      )}
                      {trainingPaused ? "Resume" : "Pause"}
                    </button>
                  )}
                  {selected.referencePhotos.length < 5 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      ⚠ Need at least 5 reference photos (
                      {selected.referencePhotos.length}/5 uploaded)
                    </p>
                  )}
                  {(selected.status === "failed" ||
                    selected.status === "training") && (
                    <button
                      onClick={() => recoverMutation.mutate(selected.id)}
                      disabled={recoverMutation.isPending}
                      className="flex items-center gap-1.5 text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100 disabled:opacity-50"
                      title="Check whether training completed on the sidecar and recover the LoRA if so"
                    >
                      {recoverMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle className="h-3 w-3" />
                      )}
                      Check if complete
                    </button>
                  )}
                  {selected.status === "failed" && (
                    <button
                      onClick={() => {
                        setResumeCharId(selected.id);
                        setShowResumeDialog(true);
                      }}
                      className="flex items-center gap-1.5 text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Resume from checkpoint
                    </button>
                  )}
                  {selected.status === "ready" && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      ✓ LoRA adapter trained and ready. Use trigger word &quot;
                      {selected.triggerWord}&quot; in your prompts.
                    </p>
                  )}
                </div>
              </SectionCard>
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input for photo uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete Character"
          message={`Delete "${deleteTarget.name}" and all associated photos and LoRA weights? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Resume Training Dialog */}
      {showResumeDialog && resumeCharId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={() => setShowResumeDialog(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Resume Training"
          >
            <h3 className="mb-1 text-sm font-semibold text-foreground">
              Resume Training
            </h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Select a checkpoint to resume from. Training will continue from
              that point.
            </p>

            {checkpointsQuery.isLoading && (
              <p className="mb-4 text-xs text-muted-foreground">
                Loading checkpoints…
              </p>
            )}
            {checkpointsQuery.isError && (
              <p className="mb-4 text-xs text-red-500">
                Failed to load checkpoints. Is the image-gen sidecar running?
              </p>
            )}
            {checkpointsQuery.data &&
              (checkpointsQuery.data.checkpoints.length === 0 ? (
                <p className="mb-4 text-xs text-amber-600">
                  No checkpoints found on the sidecar. The training data may
                  have been cleaned up.
                </p>
              ) : (
                <>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Checkpoint
                  </label>
                  <select
                    id="resume-checkpoint-select"
                    className="mb-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                    defaultValue={checkpointsQuery.data.checkpoints[0]?.path}
                  >
                    {checkpointsQuery.data.checkpoints.map((cp) => (
                      <option key={cp.path} value={cp.path}>
                        {cp.name} ({(cp.size / 1024 / 1024).toFixed(1)} MB)
                      </option>
                    ))}
                  </select>
                </>
              ))}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowResumeDialog(false)}
                className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                disabled={
                  resumeMutation.isPending ||
                  !checkpointsQuery.data?.checkpoints.length
                }
                onClick={() => {
                  const sel = document.getElementById(
                    "resume-checkpoint-select",
                  ) as HTMLSelectElement | null;
                  const checkpoint_path =
                    sel?.value ??
                    checkpointsQuery.data?.checkpoints[0]?.path ??
                    "";
                  if (!checkpoint_path) return;
                  resumeMutation.mutate({ id: resumeCharId, checkpoint_path });
                }}
                className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {resumeMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Resume
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Enhance Model Confirmation */}
      {showEnhanceDialog && selected && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={() => setShowEnhanceDialog(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="AI Enhance Settings"
          >
            <h3 className="mb-1 text-sm font-semibold text-foreground">
              AI Enhance
            </h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Each photo will be analyzed individually using vision. This will
              make {selected.referencePhotos.length} model request
              {selected.referencePhotos.length !== 1 ? "s" : ""}.
            </p>

            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Model
            </label>
            <select
              value={enhanceModel}
              onChange={(e) => setEnhanceModel(e.target.value)}
              className="mb-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
            >
              <option value="">
                Default
                {modelsQuery.data?.selectedModel
                  ? ` (${modelsQuery.data.selectedModel})`
                  : ""}
              </option>
              {(modelsQuery.data?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowEnhanceDialog(false)}
                className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowEnhanceDialog(false);
                  aiEnhanceMutation.mutate({
                    id: selected.id,
                    ...(enhanceModel ? { model: enhanceModel } : {}),
                  });
                }}
                className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-700"
              >
                Enhance
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
