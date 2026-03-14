"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  X, Send, Clock, Loader2, FileText, Image as ImageIcon,
  Link2, Type, FolderOpen, ChevronRight, Trash2, ArrowUp,
  Paperclip, Film, Music,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

type OutboxPlatform = "twitter" | "pinterest" | "linkedin" | "facebook" | "youtube" | "reddit" | "instagram";
type SourceTab = "text" | "file" | "gallery" | "url";

interface OutboxAttachment {
  filePath: string;
  filename: string;
  assetType?: string;
}

interface BrowseItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface GalleryAssetOption {
  id: string;
  filename: string;
  type: string;
  prompt?: string;
}

export interface AddToOutboxModalProps {
  open: boolean;
  onClose: () => void;
  /** Pre-fill for gallery source */
  initialAssetId?: string;
  initialAssetFilename?: string;
  initialAssetType?: string;
  /** Pre-fill the instructions textarea */
  defaultContext?: string;
  /** Start on a specific tab */
  initialTab?: SourceTab;
}

const PLATFORMS: { value: OutboxPlatform; label: string }[] = [
  { value: "twitter", label: "𝕏 / Twitter" },
  { value: "pinterest", label: "Pinterest" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "facebook", label: "Facebook" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "instagram", label: "Instagram" },
];

const SOURCE_TABS: { key: SourceTab; label: string; icon: React.ElementType }[] = [
  { key: "text", label: "Text", icon: Type },
  { key: "file", label: "Files", icon: Paperclip },
  { key: "gallery", label: "Gallery", icon: ImageIcon },
  { key: "url", label: "URL", icon: Link2 },
];

function guessAssetType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  return "document";
}

function assetTypeIcon(type: string) {
  if (type === "image") return <ImageIcon className="h-3.5 w-3.5" />;
  if (type === "video") return <Film className="h-3.5 w-3.5" />;
  if (type === "audio") return <Music className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}

// ── Component ───────────────────────────────────────────────

export function AddToOutboxModal({
  open,
  onClose,
  initialAssetId,
  initialAssetFilename,
  initialAssetType,
  defaultContext = "",
  initialTab,
}: AddToOutboxModalProps) {
  const queryClient = useQueryClient();

  // Determine initial tab from props
  const startTab = initialTab ?? (initialAssetId ? "gallery" : "text");

  const [activeTab, setActiveTab] = useState<SourceTab>(startTab);
  const [platform, setPlatform] = useState<OutboxPlatform>("twitter");
  const [scheduledTime, setScheduledTime] = useState(() => {
    const d = new Date(Date.now() + 30 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [agentContext, setAgentContext] = useState(defaultContext);
  const [title, setTitle] = useState("");

  // Text tab
  const [contentBody, setContentBody] = useState("");

  // File tab
  const [attachments, setAttachments] = useState<OutboxAttachment[]>([]);
  const [browseDir, setBrowseDir] = useState<string | null>(null);

  // Gallery tab
  const [selectedAssetId, setSelectedAssetId] = useState(initialAssetId ?? "");
  const [selectedAssetFilename, setSelectedAssetFilename] = useState(initialAssetFilename ?? "");
  const [selectedAssetType, setSelectedAssetType] = useState(initialAssetType ?? "image");
  const [gallerySearch, setGallerySearch] = useState("");

  // URL tab
  const [assetUrl, setAssetUrl] = useState("");

  // File browser query
  const browseQuery = useQuery<{ dir: string; parent: string; items: BrowseItem[] }>({
    queryKey: ["outbox-browse", browseDir],
    queryFn: () => {
      const params = browseDir ? `?dir=${encodeURIComponent(browseDir)}` : "";
      return fetchJson(`/api/admin/outbox/browse${params}`);
    },
    enabled: activeTab === "file",
  });

  // Gallery assets query
  const galleryQuery = useQuery<{ assets: GalleryAssetOption[] }>({
    queryKey: ["gallery-assets-picker", gallerySearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "30" });
      if (gallerySearch) params.set("q", gallerySearch);
      return fetchJson(`/api/queue/assets?${params.toString()}`);
    },
    enabled: activeTab === "gallery",
  });

  const addAttachment = useCallback((item: BrowseItem) => {
    if (attachments.some((a) => a.filePath === item.path)) return;
    setAttachments((prev) => [
      ...prev,
      { filePath: item.path, filename: item.name, assetType: guessAssetType(item.name) },
    ]);
  }, [attachments]);

  const removeAttachment = useCallback((filePath: string) => {
    setAttachments((prev) => prev.filter((a) => a.filePath !== filePath));
  }, []);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      fetchJson("/api/admin/outbox", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      const label = title || "Content";
      showToast(`Queued "${label}" for ${platform}`, "success");
      onClose();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentContext.trim()) return;

    const payload: Record<string, unknown> = {
      platform,
      scheduled_time: new Date(scheduledTime).toISOString(),
      agent_context: agentContext.trim(),
      title: title.trim() || null,
    };

    if (activeTab === "text") {
      payload.content_body = contentBody;
      payload.asset_type = "text";
    } else if (activeTab === "file") {
      payload.attachments = attachments;
      payload.asset_type = attachments.length > 0 ? attachments[0].assetType : "document";
    } else if (activeTab === "gallery") {
      payload.asset_id = selectedAssetId;
      payload.asset_type = selectedAssetType === "scene" ? "image" : selectedAssetType;
    } else if (activeTab === "url") {
      payload.asset_url = assetUrl;
      payload.asset_type = "text";
    }

    mutation.mutate(payload);
  };

  // Reset browseDir when opening file tab
  useEffect(() => {
    if (activeTab === "file" && browseDir === null) {
      setBrowseDir(undefined as unknown as string | null);
    }
  }, [activeTab, browseDir]);

  if (!open) return null;

  const canSubmit =
    agentContext.trim().length > 0 &&
    (activeTab === "text"
      ? contentBody.trim().length > 0
      : activeTab === "file"
        ? attachments.length > 0
        : activeTab === "gallery"
          ? selectedAssetId.length > 0
          : activeTab === "url"
            ? assetUrl.trim().length > 0
            : false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative mx-4 flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl" style={{ maxHeight: "90vh" }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">Add to Publishing Queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Select content source, platform, and schedule</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Source Tabs */}
        <div className="flex border-b border-border px-6">
          {SOURCE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-card-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {/* Title (all tabs) */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-card-foreground">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional label for this queue item"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {/* ─── Text Tab ──────────────────────────────── */}
            {activeTab === "text" && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-card-foreground">Content</label>
                <textarea
                  value={contentBody}
                  onChange={(e) => setContentBody(e.target.value)}
                  placeholder="Write or paste your post content (markdown supported)..."
                  rows={6}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground font-mono placeholder:text-muted-foreground"
                />
              </div>
            )}

            {/* ─── File Tab ──────────────────────────────── */}
            {activeTab === "file" && (
              <div className="space-y-3">
                {/* Selected attachments */}
                {attachments.length > 0 && (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                      Selected Files ({attachments.length})
                    </label>
                    <div className="space-y-1.5">
                      {attachments.map((a) => (
                        <div key={a.filePath} className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                          {assetTypeIcon(a.assetType ?? "document")}
                          <span className="flex-1 truncate text-card-foreground">{a.filename}</span>
                          <span className="truncate text-xs text-muted-foreground">{a.filePath}</span>
                          <button type="button" onClick={() => removeAttachment(a.filePath)} className="text-muted-foreground hover:text-red-400">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* File browser */}
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">Browse Files</label>
                  {browseQuery.data && (
                    <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" />
                      <span className="truncate">{browseQuery.data.dir}</span>
                      {browseQuery.data.parent !== browseQuery.data.dir && (
                        <button
                          type="button"
                          onClick={() => setBrowseDir(browseQuery.data!.parent)}
                          className="ml-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-muted"
                        >
                          <ArrowUp className="h-3 w-3" />
                          Up
                        </button>
                      )}
                    </div>
                  )}
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
                    {browseQuery.isLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : browseQuery.data?.items.length === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">Empty directory</p>
                    ) : (
                      browseQuery.data?.items.map((item) => {
                        const isSelected = attachments.some((a) => a.filePath === item.path);
                        return (
                          <button
                            type="button"
                            key={item.path}
                            onClick={() => item.isDirectory ? setBrowseDir(item.path) : addAttachment(item)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 ${
                              isSelected ? "bg-primary/10 text-primary" : "text-card-foreground"
                            }`}
                          >
                            {item.isDirectory ? (
                              <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                            ) : (
                              assetTypeIcon(guessAssetType(item.name))
                            )}
                            <span className="flex-1 truncate">{item.name}</span>
                            {item.isDirectory && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                            {!item.isDirectory && isSelected && (
                              <span className="text-xs text-primary">Added</span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ─── Gallery Tab ───────────────────────────── */}
            {activeTab === "gallery" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">Search Gallery</label>
                  <input
                    type="text"
                    value={gallerySearch}
                    onChange={(e) => setGallerySearch(e.target.value)}
                    placeholder="Search by filename, prompt, or tags..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                </div>

                {selectedAssetId && (
                  <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                    {assetTypeIcon(selectedAssetType)}
                    <span className="flex-1 truncate text-card-foreground">{selectedAssetFilename}</span>
                    <button
                      type="button"
                      onClick={() => { setSelectedAssetId(""); setSelectedAssetFilename(""); }}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background">
                  {galleryQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (galleryQuery.data?.assets ?? []).length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">No gallery assets found</p>
                  ) : (
                    galleryQuery.data?.assets.map((asset) => (
                      <button
                        type="button"
                        key={asset.id}
                        onClick={() => {
                          setSelectedAssetId(asset.id);
                          setSelectedAssetFilename(asset.filename);
                          setSelectedAssetType(asset.type);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 ${
                          selectedAssetId === asset.id ? "bg-primary/10 text-primary" : "text-card-foreground"
                        }`}
                      >
                        {assetTypeIcon(asset.type)}
                        <span className="flex-1 truncate">{asset.filename}</span>
                        <span className="text-xs text-muted-foreground">{asset.type}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ─── URL Tab ───────────────────────────────── */}
            {activeTab === "url" && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-card-foreground">External URL</label>
                <input
                  type="url"
                  value={assetUrl}
                  onChange={(e) => setAssetUrl(e.target.value)}
                  placeholder="https://example.com/content"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The AI agent will fetch and process content from this URL when publishing.
                </p>
              </div>
            )}

            {/* ─── Common Fields ──────────────────────────── */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-card-foreground">Platform</label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as OutboxPlatform)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {PLATFORMS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                  <Clock className="mr-1 inline h-3.5 w-3.5" />
                  Scheduled Time
                </label>
                <input
                  type="datetime-local"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                Publishing Instructions
              </label>
              <textarea
                value={agentContext}
                onChange={(e) => setAgentContext(e.target.value)}
                placeholder="Describe how the AI agent should publish this content (e.g., caption, hashtags, target audience)..."
                rows={3}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The AI agent will use these instructions to craft and publish the post autonomously.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !canSubmit}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Queue for Publishing
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
