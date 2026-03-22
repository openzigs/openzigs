"use client";

import { useState, useCallback, useEffect } from "react";
import { X, Loader2, Sparkles, Youtube, Globe, Lock, Clock, Tag } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";

export interface YouTubeMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "public" | "unlisted" | "private";
  scheduledAt?: string;
  chapters?: string;
}

interface YouTubeCategory {
  id: string;
  name: string;
}

interface YouTubeMetadataEditorProps {
  draftId: string;
  defaultTitle: string;
  open: boolean;
  onClose: () => void;
  onPublish: (metadata: YouTubeMetadata) => void;
  publishing?: boolean;
  warning?: string;
}

const PRIVACY_OPTIONS: { value: YouTubeMetadata["privacyStatus"]; label: string; icon: React.ReactNode; description: string }[] = [
  { value: "public", label: "Public", icon: <Globe className="h-3.5 w-3.5" />, description: "Anyone can search for and view" },
  { value: "unlisted", label: "Unlisted", icon: <Clock className="h-3.5 w-3.5" />, description: "Anyone with the link can view" },
  { value: "private", label: "Private", icon: <Lock className="h-3.5 w-3.5" />, description: "Only you can view" },
];

export function YouTubeMetadataEditor({
  draftId,
  defaultTitle,
  open,
  onClose,
  onPublish,
  publishing,
  warning,
}: YouTubeMetadataEditorProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState("22"); // People & Blogs default
  const [privacyStatus, setPrivacyStatus] = useState<YouTubeMetadata["privacyStatus"]>("private");
  const [categories, setCategories] = useState<YouTubeCategory[]>([]);
  const [chapters, setChapters] = useState("");
  const [generating, setGenerating] = useState(false);
  const [aiModel, setAiModel] = useState("");

  // Load categories on mount
  useEffect(() => {
    if (!open) return;
    fetchJson<{ categories: YouTubeCategory[] }>("/api/admin/director/youtube/categories")
      .then((res) => setCategories(res.categories))
      .catch(() => {/* silent */});
  }, [open]);

  // Reset form when opening with new draft
  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setDescription("");
      setTags([]);
      setTagInput("");
      setChapters("");
      setPrivacyStatus("private");
      setCategoryId("22");
    }
  }, [open, defaultTitle]);

  const handleGenerateAI = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetchJson<{
        title: string;
        description: string;
        tags: string[];
        suggestedCategory: string;
        chapters: string;
      }>("/api/admin/director/youtube/generate-metadata", {
        method: "POST",
        body: JSON.stringify({ draftId, ...(aiModel ? { model: aiModel } : {}) }),
      });

      if (res.title) setTitle(res.title);
      if (res.description) setDescription(res.description);
      if (res.tags?.length) setTags(res.tags);
      if (res.chapters) setChapters(res.chapters);

      // Try to match suggested category to our list
      if (res.suggestedCategory && categories.length) {
        const match = categories.find(
          (c) => c.name.toLowerCase() === res.suggestedCategory.toLowerCase(),
        );
        if (match) setCategoryId(match.id);
      }

      showToast("AI metadata generated", "success");
    } catch {
      showToast("Failed to generate metadata", "error");
    } finally {
      setGenerating(false);
    }
  }, [draftId, categories, aiModel]);

  const handleAddTag = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const tag = tagInput.trim().replace(/^#/, "");
        if (tag && !tags.includes(tag) && tags.length < 30) {
          setTags([...tags, tag]);
          setTagInput("");
        }
      }
    },
    [tagInput, tags],
  );

  const handleRemoveTag = useCallback(
    (tag: string) => {
      setTags(tags.filter((t) => t !== tag));
    },
    [tags],
  );

  const handleSubmit = useCallback(() => {
    const finalDescription = chapters
      ? `${description}\n\n${chapters}`
      : description;

    onPublish({
      title: title.trim(),
      description: finalDescription,
      tags,
      categoryId,
      privacyStatus,
    });
  }, [title, description, tags, categoryId, privacyStatus, chapters, onPublish]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Youtube className="h-4 w-4 text-red-500" />
            <h3 className="text-sm font-semibold text-foreground">Publish to YouTube</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto p-4 space-y-4">
          {/* Re-publish warning */}
          {warning && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
              {warning}
            </div>
          )}

          {/* AI Generate Button + Model Selector */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerateAI}
              disabled={generating}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10 transition disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {generating ? "Generating…" : "Generate with AI"}
            </button>
            <InlineModelPicker value={aiModel} onChange={setAiModel} className="w-36" />
          </div>

          {/* Title */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Title <span className="text-muted-foreground/60">({title.length}/100)</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 100))}
              placeholder="Video title"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Description <span className="text-muted-foreground/60">({description.length}/5000)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 5000))}
              rows={4}
              placeholder="Tell viewers about your video"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>

          {/* Chapters */}
          {chapters && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Chapters <span className="text-muted-foreground/60">(auto-generated, appended to description)</span>
              </label>
              <textarea
                value={chapters}
                onChange={(e) => setChapters(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>
          )}

          {/* Tags */}
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Tag className="h-3 w-3" /> Tags <span className="text-muted-foreground/60">({tags.length}/30)</span>
            </label>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder="Type a tag, press Enter"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Category */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {/* Privacy */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Visibility
            </label>
            <div className="grid grid-cols-3 gap-2">
              {PRIVACY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPrivacyStatus(opt.value)}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-3 py-2 text-xs transition ${
                    privacyStatus === opt.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.icon}
                  <span className="font-medium">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            disabled={publishing}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={publishing || !title.trim()}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition disabled:opacity-50"
          >
            {publishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Youtube className="h-3.5 w-3.5" />
            )}
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}
