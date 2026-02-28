"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { BrandVoice, BrandVoiceRulebook } from "@/lib/types";
import { showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Plus, Trash2, Star, StarOff, Loader2, ChevronDown, ChevronRight, Pencil, X, Check, Upload, RefreshCw } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

/** Upload files and extract text samples from them */
async function uploadSampleFiles(files: File[]): Promise<{ samples: string[]; errors: string[] }> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

  const res = await fetch(`${API_BASE}/api/admin/brand-voice/upload-samples`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

export const BrandVoicePanel = () => {
  const queryClient = useQueryClient();
  const [showAnalyzeForm, setShowAnalyzeForm] = useState(false);
  const [name, setName] = useState("");
  const [sampleEntries, setSampleEntries] = useState<string[]>([""]);
  const [setActive, setSetActive] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRulebook, setEditRulebook] = useState<BrandVoiceRulebook | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    variant?: "danger" | "default";
    onConfirm: () => void;
  } | null>(null);

  const voicesQuery = useQuery({
    queryKey: ["brand-voices"],
    queryFn: () => fetchJson<{ voices: BrandVoice[] }>("/api/admin/brand-voice"),
  });

  const voices = voicesQuery.data?.voices ?? [];
  const activeVoice = voices.find((v) => v.active);

  const analyzeMutation = useMutation({
    mutationFn: (payload: { name: string; samples: string[]; active: boolean }) =>
      fetchJson<BrandVoice>("/api/admin/brand-voice/analyze", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("Brand voice analyzed and saved!", "success");
      setShowAnalyzeForm(false);
      setName("");
      setSampleEntries([""]);
    },
    onError: (err) => showToast(`Analysis failed: ${err.message}`, "error"),
  });

  const reanalyzeMutation = useMutation({
    mutationFn: ({ id, samples }: { id: string; samples: string[] }) =>
      fetchJson<BrandVoice>(`/api/admin/brand-voice/${id}/reanalyze`, {
        method: "POST",
        body: JSON.stringify({ samples }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("Brand voice re-analyzed!", "success");
    },
    onError: (err) => showToast(`Re-analysis failed: ${err.message}`, "error"),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<BrandVoice>(`/api/admin/brand-voice/${id}/activate`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("Brand voice activated", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deactivateMutation = useMutation({
    mutationFn: () =>
      fetchJson("/api/admin/brand-voice/deactivate", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("All brand voices deactivated", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/brand-voice/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("Brand voice deleted", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, rulebook }: { id: string; rulebook: BrandVoiceRulebook }) =>
      fetchJson<BrandVoice>(`/api/admin/brand-voice/${id}`, {
        method: "PUT",
        body: JSON.stringify({ rulebook }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-voices"] });
      showToast("Brand voice updated", "success");
      setEditingId(null);
      setEditRulebook(null);
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const handleAnalyze = () => {
    const validSamples = sampleEntries.map((s) => s.trim()).filter(Boolean);

    if (!name.trim()) {
      showToast("Name is required", "error");
      return;
    }
    if (validSamples.length === 0) {
      showToast("At least one writing sample is required", "error");
      return;
    }
    analyzeMutation.mutate({ name: name.trim(), samples: validSamples, active: setActive });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const result = await uploadSampleFiles(files);
      if (result.errors.length > 0) {
        showToast(`Some files failed: ${result.errors.join("; ")}`, "error");
      }
      if (result.samples.length > 0) {
        setSampleEntries((prev) => {
          const nonEmpty = prev.filter((s) => s.trim());
          return [...nonEmpty, ...result.samples];
        });
        showToast(`Extracted ${result.samples.length} sample(s) from files`, "success");
      }
    } catch (err) {
      showToast(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addSampleEntry = () => setSampleEntries((prev) => [...prev, ""]);
  const removeSampleEntry = (index: number) =>
    setSampleEntries((prev) => prev.filter((_, i) => i !== index));
  const updateSampleEntry = (index: number, value: string) =>
    setSampleEntries((prev) => prev.map((s, i) => (i === index ? value : s)));

  const handleReanalyze = (voice: BrandVoice) => {
    setPendingConfirm({
      title: "Re-analyze Voice",
      message: `Re-analyze "${voice.name}" with its current samples? This will regenerate the rulebook.`,
      onConfirm: () => {
        setPendingConfirm(null);
        reanalyzeMutation.mutate({ id: voice.id, samples: voice.samples });
      },
    });
  };

  const handleDelete = (id: string, voiceName: string) => {
    setPendingConfirm({
      title: "Delete Brand Voice",
      message: `Delete brand voice "${voiceName}"? This cannot be undone.`,
      variant: "danger",
      onConfirm: () => {
        setPendingConfirm(null);
        deleteMutation.mutate(id);
      },
    });
  };

  const startEditing = (voice: BrandVoice) => {
    setEditingId(voice.id);
    setEditRulebook({ ...voice.rulebook });
    setExpandedId(voice.id);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditRulebook(null);
  };

  const saveEditing = () => {
    if (!editingId || !editRulebook) return;
    updateMutation.mutate({ id: editingId, rulebook: editRulebook });
  };

  if (voicesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading brand voices…</p>;
  }

  return (
    <div className="space-y-5">
      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          variant={pendingConfirm.variant}
          confirmLabel={pendingConfirm.variant === "danger" ? "Delete" : "Confirm"}
          onConfirm={pendingConfirm.onConfirm}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
      {/* Active voice indicator */}
      {activeVoice && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <Star className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            Active: <span className="text-primary">{activeVoice.name}</span>
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {activeVoice.rulebook.tone}
          </span>
          <button
            className="ml-2 text-xs text-muted-foreground hover:text-destructive transition"
            onClick={() => deactivateMutation.mutate()}
            title="Deactivate all brand voices"
          >
            <StarOff className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Voice list */}
      {voices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No brand voices created yet. Analyze writing samples to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {voices.map((voice) => (
            <div
              key={voice.id}
              className={`rounded-lg border ${
                voice.active ? "border-primary/30 bg-primary/5" : "border-border bg-card"
              }`}
            >
              {/* Header row */}
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  className="text-muted-foreground hover:text-foreground transition"
                  onClick={() => setExpandedId(expandedId === voice.id ? null : voice.id)}
                >
                  {expandedId === voice.id ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{voice.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{voice.rulebook.tone}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {!voice.active && (
                    <button
                      className="rounded p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition"
                      onClick={() => activateMutation.mutate(voice.id)}
                      title="Set as active brand voice"
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-40"
                    onClick={() => handleReanalyze(voice)}
                    disabled={reanalyzeMutation.isPending}
                    title="Re-analyze writing samples"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${reanalyzeMutation.isPending ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition"
                    onClick={() => startEditing(voice)}
                    title="Edit rulebook"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
                    onClick={() => handleDelete(voice.id, voice.name)}
                    title="Delete brand voice"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {expandedId === voice.id && (
                <div className="border-t border-border px-4 py-3 space-y-3">
                  {editingId === voice.id && editRulebook ? (
                    /* Editing mode */
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Tone</label>
                        <input
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                          value={editRulebook.tone}
                          onChange={(e) => setEditRulebook({ ...editRulebook, tone: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Sentence Structure</label>
                        <input
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                          value={editRulebook.sentence_structure}
                          onChange={(e) => setEditRulebook({ ...editRulebook, sentence_structure: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Vocabulary Level</label>
                        <input
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                          value={editRulebook.vocabulary_level}
                          onChange={(e) => setEditRulebook({ ...editRulebook, vocabulary_level: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Formatting Quirks</label>
                        <input
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                          value={editRulebook.formatting_quirks}
                          onChange={(e) => setEditRulebook({ ...editRulebook, formatting_quirks: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Banned Words (comma-separated)
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                          value={editRulebook.banned_words.join(", ")}
                          onChange={(e) =>
                            setEditRulebook({
                              ...editRulebook,
                              banned_words: e.target.value.split(",").map((w) => w.trim()).filter(Boolean),
                            })
                          }
                        />
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
                          onClick={saveEditing}
                        >
                          <Check className="h-3.5 w-3.5" /> Save
                        </button>
                        <button
                          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                          onClick={cancelEditing}
                        >
                          <X className="h-3.5 w-3.5" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div className="space-y-2">
                      <RulebookField label="Tone" value={voice.rulebook.tone} />
                      <RulebookField label="Sentence Structure" value={voice.rulebook.sentence_structure} />
                      <RulebookField label="Vocabulary Level" value={voice.rulebook.vocabulary_level} />
                      <RulebookField label="Formatting Quirks" value={voice.rulebook.formatting_quirks} />
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Banned Words</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {voice.rulebook.banned_words.map((word) => (
                            <span
                              key={word}
                              className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
                            >
                              {word}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground pt-1">
                        Analyzed from {voice.samples.length} sample(s) · Created{" "}
                        {new Date(voice.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Analyze form */}
      {showAnalyzeForm ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Analyze Writing Samples</h4>
          <p className="text-xs text-muted-foreground">
            Add your writing samples individually below, or upload Word/PDF/TXT files to extract text.
          </p>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Voice Name</label>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              placeholder="e.g. Corporate Blog Voice"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Individual sample entries */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Writing Samples ({sampleEntries.filter((s) => s.trim()).length} added)
            </label>
            <div className="space-y-2">
              {sampleEntries.map((sample, i) => (
                <div key={i} className="flex gap-2">
                  <textarea
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground font-mono"
                    rows={4}
                    placeholder={`Writing sample ${i + 1}…`}
                    value={sample}
                    onChange={(e) => updateSampleEntry(i, e.target.value)}
                  />
                  {sampleEntries.length > 1 && (
                    <button
                      className="self-start rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
                      onClick={() => removeSampleEntry(i)}
                      title="Remove sample"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <button
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
                onClick={addSampleEntry}
              >
                <Plus className="h-3 w-3" /> Add Sample
              </button>
              <button
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-40"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Upload Files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.doc,.txt"
                multiple
                onChange={handleFileUpload}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Supported file types: .pdf, .docx, .doc, .txt
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={setActive}
                onChange={(e) => setSetActive(e.target.checked)}
                className="rounded border-border"
              />
              Set as active voice
            </label>
          </div>
          <div className="flex gap-2">
            <button
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              onClick={handleAnalyze}
              disabled={analyzeMutation.isPending}
            >
              {analyzeMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Analyzing…
                </>
              ) : (
                "Analyze & Save"
              )}
            </button>
            <button
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
              onClick={() => {
                setShowAnalyzeForm(false);
                setSampleEntries([""]);
                setName("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted hover:border-primary/30"
          onClick={() => setShowAnalyzeForm(true)}
        >
          <Plus className="h-4 w-4" /> New Brand Voice
        </button>
      )}
    </div>
  );
};

const RulebookField = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-xs font-medium text-muted-foreground">{label}</p>
    <p className="text-sm text-foreground">{value}</p>
  </div>
);
