"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  X,
  Clock,
  Loader2,
  FileText,
  Image as ImageIcon,
  Link2,
  Type,
  FolderOpen,
  ChevronRight,
  Trash2,
  ArrowUp,
  Paperclip,
  Film,
  Music,
  Sparkles,
  Pencil,
  Download,
  Check,
  LayoutTemplate,
  Palette,
} from "lucide-react";
import { InlineModelPicker } from "@/components/model-picker-select";

// ── Types ───────────────────────────────────────────────────

type OutboxPlatform =
  | "twitter"
  | "pinterest"
  | "linkedin"
  | "youtube"
  | "reddit"
  | "instagram"
  | "facebook";
type SourceTab = "text" | "file" | "gallery" | "url" | "template";
type ImageSource = "extract" | "generate" | "none";

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
  file_path?: string;
}

interface PlatformPreview {
  text: string;
  publishingInstructions?: string;
}

interface GeneratePreviewResponse {
  previews: Record<string, PlatformPreview>;
  imagePrompt?: string;
  extractedImages?: string[];
  generatedImages?: string[];
  imageGenError?: string;
}

interface ConnectedPlatform {
  platform: string;
  connected: boolean;
}

interface SavedImage {
  url: string;
  assetId: string;
  filePath: string;
  filename: string;
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

const ALL_PLATFORMS: { value: OutboxPlatform; label: string }[] = [
  { value: "twitter", label: "𝕏 / Twitter" },
  { value: "pinterest", label: "Pinterest" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
];

/** Platforms not available in URL tab (video-only platforms). */
const URL_TAB_EXCLUDED_PLATFORMS = new Set<OutboxPlatform>(["youtube"]);

const SOURCE_TABS: {
  key: SourceTab;
  label: string;
  icon: React.ElementType;
}[] = [
  { key: "text", label: "Text", icon: Type },
  { key: "file", label: "Files", icon: Paperclip },
  { key: "gallery", label: "Gallery", icon: ImageIcon },
  { key: "url", label: "URL", icon: Link2 },
  { key: "template", label: "Templates", icon: LayoutTemplate },
];

function guessAssetType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext))
    return "image";
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
  const [platforms, setPlatforms] = useState<OutboxPlatform[]>(["twitter"]);
  const [scheduledTime, setScheduledTime] = useState(() => {
    const d = new Date(Date.now() + 30 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [agentContext, setAgentContext] = useState(defaultContext);
  const [title, setTitle] = useState("");

  // Text tab
  const [contentBody, setContentBody] = useState("");
  const [textPreviews, setTextPreviews] = useState<
    Record<string, PlatformPreview>
  >({});

  // File tab
  const [attachments, setAttachments] = useState<OutboxAttachment[]>([]);
  const [browseDir, setBrowseDir] = useState<string | null>(null);

  // Gallery tab
  const [selectedAssetId, setSelectedAssetId] = useState(initialAssetId ?? "");
  const [selectedAssetFilename, setSelectedAssetFilename] = useState(
    initialAssetFilename ?? "",
  );
  const [selectedAssetType, setSelectedAssetType] = useState(
    initialAssetType ?? "image",
  );
  const [gallerySearch, setGallerySearch] = useState("");

  // URL tab
  const [assetUrl, setAssetUrl] = useState("");

  // Template tab
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});

  // Brand kit
  const [selectedBrandKitId, setSelectedBrandKitId] = useState<string | null>(
    null,
  );

  // AI Generate state
  const [modelOverride, setModelOverride] = useState("");
  const [imageSource, setImageSource] = useState<ImageSource>("extract");
  const [previews, setPreviews] = useState<Record<
    string,
    PlatformPreview
  > | null>(null);
  const [editingPlatform, setEditingPlatform] = useState<string | null>(null);
  const [imagePrompt, setImagePrompt] = useState<string | null>(null);
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [savedImages, setSavedImages] = useState<SavedImage[]>([]);
  const [savingImages, setSavingImages] = useState(false);

  // Content enhance state (gallery/file tabs)
  const [contentPreviews, setContentPreviews] = useState<Record<
    string,
    PlatformPreview
  > | null>(null);

  // Connected platforms query
  const connectedQuery = useQuery<{ platforms: ConnectedPlatform[] }>({
    queryKey: ["outbox-connected-platforms"],
    queryFn: () => fetchJson("/api/admin/outbox/connected-platforms"),
    staleTime: 60_000,
  });

  const connectedSet = new Set(
    (connectedQuery.data?.platforms ?? [])
      .filter((p) => p.connected)
      .map((p) => p.platform),
  );

  // Filter platforms: only show connected ones; exclude YouTube from URL tab
  const visiblePlatforms = ALL_PLATFORMS.filter((p) => {
    // If query hasn't loaded yet, show all as fallback
    if (!connectedQuery.data) return true;
    if (!connectedSet.has(p.value)) return false;
    if (activeTab === "url" && URL_TAB_EXCLUDED_PLATFORMS.has(p.value))
      return false;
    return true;
  });

  const togglePlatform = useCallback((p: OutboxPlatform) => {
    setPlatforms((prev) =>
      prev.includes(p)
        ? prev.length > 1
          ? prev.filter((x) => x !== p)
          : prev
        : [...prev, p],
    );
    // Clear AI previews when platforms change so stale content doesn't persist
    setPreviews(null);
    setImagePrompt(null);
  }, []);

  // When connected platforms data loads, update selection to only include connected ones
  useEffect(() => {
    if (!connectedQuery.data) return;
    const connected = connectedQuery.data.platforms
      .filter((p) => p.connected)
      .map((p) => p.platform as OutboxPlatform);
    if (connected.length === 0) return;

    setPlatforms((prev) => {
      const valid = prev.filter((p) => connected.includes(p));
      return valid.length > 0 ? valid : [connected[0]];
    });
  }, [connectedQuery.data]);

  // File browser query
  const browseQuery = useQuery<{
    dir: string;
    parent: string;
    items: BrowseItem[];
  }>({
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

  // Templates query for template tab
  interface PostTemplate {
    id: string;
    name: string;
    platform: string;
    content_template: string;
    platform_defaults?: Record<string, unknown>;
    brand_kit_id?: string;
  }
  const templatesQuery = useQuery<PostTemplate[]>({
    queryKey: ["post-templates"],
    queryFn: () =>
      fetchJson<{ templates: PostTemplate[] }>("/api/admin/templates").then(
        (data) => data.templates,
      ),
    enabled: activeTab === "template",
  });

  const applyTemplateMutation = useMutation({
    mutationFn: (body: {
      templateId: string;
      variables: Record<string, string>;
    }) =>
      fetchJson(`/api/admin/templates/${body.templateId}/apply`, {
        method: "POST",
        body: JSON.stringify({ variables: body.variables }),
      }) as Promise<{
        content: string;
        platform_defaults?: Record<string, unknown>;
      }>,
  });

  // Extract {{variable}} placeholders from a template
  const extractTemplateVars = (template: string): string[] => {
    const matches = template.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  };

  const selectedTemplate = templatesQuery.data?.find(
    (t) => t.id === selectedTemplateId,
  );
  const templatePlaceholders = selectedTemplate
    ? extractTemplateVars(selectedTemplate.content_template)
    : [];

  // Brand kits query
  interface BrandKitOption {
    id: string;
    name: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
  }
  const brandKitsQuery = useQuery<{ brandKits: BrandKitOption[] }>({
    queryKey: ["brand-kits"],
    queryFn: () => fetchJson("/api/admin/director/brand-kits"),
  });

  const addAttachment = useCallback(
    (item: BrowseItem) => {
      if (attachments.some((a) => a.filePath === item.path)) return;
      setAttachments((prev) => [
        ...prev,
        {
          filePath: item.path,
          filename: item.name,
          assetType: guessAssetType(item.name),
        },
      ]);
    },
    [attachments],
  );

  const removeAttachment = useCallback((filePath: string) => {
    setAttachments((prev) => prev.filter((a) => a.filePath !== filePath));
  }, []);

  const mutation = useMutation({
    mutationFn: (payloads: Record<string, unknown>[]) =>
      Promise.all(
        payloads.map((p) =>
          fetchJson("/api/admin/outbox", {
            method: "POST",
            body: JSON.stringify(p),
          }),
        ),
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      const label = title || "Content";
      const platformNames = variables.map((p) => p.platform).join(", ");
      showToast(`Queued "${label}" for ${platformNames}`, "success");
      onClose();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const publishNowMutation = useMutation({
    mutationFn: async (payloads: Record<string, unknown>[]) => {
      // Create items with scheduled_time = now, then immediately publish each
      const created = await Promise.all(
        payloads.map((p) =>
          fetchJson<{ id: string }>("/api/admin/outbox", {
            method: "POST",
            body: JSON.stringify({
              ...p,
              scheduled_time: new Date().toISOString(),
            }),
          }),
        ),
      );
      await Promise.all(
        created.map((item) =>
          fetchJson(`/api/admin/outbox/${item.id}/publish`, { method: "POST" }),
        ),
      );
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outbox-items"] });
      queryClient.invalidateQueries({ queryKey: ["outbox-stats"] });
      const label = title || "Content";
      const platformNames = platforms.join(", ");
      showToast(`Publishing "${label}" now to ${platformNames}`, "success");
      onClose();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const generateMutation = useMutation({
    mutationFn: (body: {
      url: string;
      platforms: string[];
      model?: string;
      imageSource?: string;
    }) =>
      fetchJson<GeneratePreviewResponse>("/api/admin/outbox/generate-preview", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setPreviews(data.previews ?? {});
      if (data.imagePrompt) setImagePrompt(data.imagePrompt);

      // Merge generated images (from local/network image-gen) + extracted images
      const allImages = [
        ...(data.generatedImages ?? []),
        ...(data.extractedImages ?? []),
      ];
      if (allImages.length > 0) {
        setExtractedImages(allImages);
        // Auto-select generated images; leave extracted unselected
        setSelectedImages(new Set(data.generatedImages ?? []));
      }
      if (data.imageGenError) {
        showToast(
          `Image gen failed: ${data.imageGenError} — prompt kept for manual use`,
          "error",
        );
      }

      // Auto-fill publishing instructions from the first platform's generated instructions
      const firstPlatPreview =
        platforms.length > 0 ? data.previews?.[platforms[0]] : null;
      if (firstPlatPreview?.publishingInstructions && !agentContext.trim()) {
        // Combine all platform instructions into one
        const allInstructions = platforms
          .map((p) => data.previews?.[p]?.publishingInstructions)
          .filter(Boolean)
          .map((inst, i) => `[${platforms[i]}] ${inst}`)
          .join("\n");
        setAgentContext(allInstructions);
      }
      showToast("AI content generated — review below", "success");
    },
    onError: (err: Error) =>
      showToast(`AI generation failed: ${err.message}`, "error"),
  });

  const handleGenerate = () => {
    if (!assetUrl.trim() || platforms.length === 0) return;
    setPreviews(null);
    setImagePrompt(null);
    setExtractedImages([]);
    setSelectedImages(new Set());
    setSavedImages([]);
    generateMutation.mutate({
      url: assetUrl.trim(),
      platforms,
      model: modelOverride || undefined,
      imageSource,
    });
  };

  // ── Text AI Enhance ──────────────────────────────────
  const enhanceMutation = useMutation({
    mutationFn: (body: { text: string; platforms: string[]; model?: string }) =>
      fetchJson<{ previews: Record<string, PlatformPreview> }>(
        "/api/admin/outbox/enhance-text",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (data) => {
      // If single platform, apply directly to content; otherwise show previews
      const platKeys = Object.keys(data.previews ?? {});
      if (platKeys.length === 1 && data.previews[platKeys[0]]?.text) {
        setContentBody(data.previews[platKeys[0]].text);
      } else if (platKeys.length > 0) {
        // For multi-platform, use the first platform's text as content
        // and show a combined view
        const firstText = data.previews[platKeys[0]]?.text;
        if (firstText) setContentBody(firstText);
      }
      setTextPreviews(data.previews ?? {});
      showToast("Text enhanced by AI — review and edit as needed", "success");
    },
    onError: (err: Error) =>
      showToast(`AI enhancement failed: ${err.message}`, "error"),
  });

  const handleEnhanceText = () => {
    if (!contentBody.trim() || platforms.length === 0) return;
    setTextPreviews({});
    enhanceMutation.mutate({
      text: contentBody.trim(),
      platforms,
      model: modelOverride || undefined,
    });
  };

  // ── Content AI Enhance (Gallery / File tabs) ──────
  const enhanceContentMutation = useMutation({
    mutationFn: (body: {
      platforms: string[];
      model?: string;
      assetFilename?: string;
      assetType?: string;
      assetPrompt?: string;
      attachments?: { filename: string; assetType?: string }[];
      context?: string;
    }) =>
      fetchJson<{ previews: Record<string, PlatformPreview> }>(
        "/api/admin/outbox/enhance-content",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (data) => {
      setContentPreviews(data.previews ?? {});
      // Auto-fill publishing instructions from the AI-generated ones
      const allInstructions = platforms
        .map((p) => data.previews?.[p]?.publishingInstructions)
        .filter(Boolean)
        .map((inst, i) => `[${platforms[i]}] ${inst}`)
        .join("\n");
      if (allInstructions && !agentContext.trim()) {
        setAgentContext(allInstructions);
      }
      showToast("AI publishing content generated — review below", "success");
    },
    onError: (err: Error) =>
      showToast(`AI enhancement failed: ${err.message}`, "error"),
  });

  const handleEnhanceContent = () => {
    if (platforms.length === 0) return;
    setContentPreviews(null);
    if (activeTab === "gallery" && selectedAssetId) {
      const asset = galleryQuery.data?.assets?.find(
        (a) => a.id === selectedAssetId,
      );
      enhanceContentMutation.mutate({
        platforms,
        model: modelOverride || undefined,
        assetFilename: selectedAssetFilename,
        assetType: selectedAssetType,
        assetPrompt: asset?.prompt ?? undefined,
        context: agentContext.trim() || undefined,
      });
    } else if (activeTab === "file" && attachments.length > 0) {
      enhanceContentMutation.mutate({
        platforms,
        model: modelOverride || undefined,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          assetType: a.assetType,
        })),
        context: agentContext.trim() || undefined,
      });
    }
  };

  const handleSaveImages = async () => {
    if (selectedImages.size === 0) return;
    setSavingImages(true);
    try {
      const result = await fetchJson<{ saved: SavedImage[] }>(
        "/api/admin/outbox/save-images",
        {
          method: "POST",
          body: JSON.stringify({
            images: [...selectedImages].map((url) => ({ url })),
          }),
        },
      );
      setSavedImages(result.saved);
      // Add saved images as attachments
      for (const img of result.saved) {
        if (!attachments.some((a) => a.filePath === img.filePath)) {
          setAttachments((prev) => [
            ...prev,
            {
              filePath: img.filePath,
              filename: img.filename,
              assetType: "image",
            },
          ]);
        }
      }
      showToast(`${result.saved.length} image(s) saved to gallery`, "success");
    } catch (err) {
      showToast(
        `Failed to save images: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setSavingImages(false);
    }
  };

  const toggleImageSelection = (url: string) => {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const buildPayloads = (): Record<string, unknown>[] => {
    // Auto-generate publishing instructions when user provides content directly
    const effectiveContext =
      agentContext.trim() ||
      (activeTab === "text" && contentBody.trim()
        ? `Publish the following content exactly as-is to each platform. Do not modify the text.`
        : "");

    return platforms.map((plat) => {
      const payload: Record<string, unknown> = {
        platform: plat,
        scheduled_time: new Date(scheduledTime).toISOString(),
        agent_context: effectiveContext,
        title: title.trim() || null,
        ...(selectedBrandKitId ? { brand_kit_id: selectedBrandKitId } : {}),
      };

      if (activeTab === "text") {
        // Use platform-specific enhanced text if available, otherwise fall back to main content
        const platText = textPreviews[plat]?.text;
        payload.content_body = platText || contentBody;
        payload.asset_type = "text";
      } else if (activeTab === "file") {
        payload.attachments = attachments;
        payload.asset_type =
          attachments.length > 0 ? attachments[0].assetType : "document";
        const platPreview = contentPreviews?.[plat];
        if (platPreview?.text) payload.content_body = platPreview.text;
      } else if (activeTab === "gallery") {
        payload.asset_id = selectedAssetId;
        payload.asset_type =
          selectedAssetType === "scene" ? "image" : selectedAssetType;
        const platPreview = contentPreviews?.[plat];
        if (platPreview?.text) payload.content_body = platPreview.text;
      } else if (activeTab === "url") {
        payload.asset_url = assetUrl;
        payload.asset_type = savedImages.length > 0 ? "image" : "text";
        const previewText = previews?.[plat]?.text;
        if (previewText) {
          payload.content_body = previewText;
        }
        if (savedImages.length > 0) {
          payload.attachments = savedImages.map((img) => ({
            filePath: img.filePath,
            filename: img.filename,
            assetType: "image",
          }));
        }
      } else if (activeTab === "template") {
        payload.template_id = selectedTemplateId;
        payload.asset_type = "text";
        if (selectedTemplate?.brand_kit_id) {
          payload.brand_kit_id = selectedTemplate.brand_kit_id;
        }
        // If template was applied, use the resolved content
        if (applyTemplateMutation.data?.content) {
          payload.content_body = applyTemplateMutation.data.content;
        }
      }

      return payload;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(buildPayloads());
  };

  const handlePublishNow = () => {
    if (!canSubmit) return;
    publishNowMutation.mutate(buildPayloads());
  };

  // Reset browseDir when opening file tab
  useEffect(() => {
    if (activeTab === "file" && browseDir === null) {
      setBrowseDir(undefined as unknown as string | null);
    }
  }, [activeTab, browseDir]);

  if (!open) return null;

  const hasEffectiveContext =
    agentContext.trim().length > 0 ||
    (activeTab === "text" && contentBody.trim().length > 0);

  const canSubmit =
    hasEffectiveContext &&
    platforms.length > 0 &&
    (activeTab === "text"
      ? contentBody.trim().length > 0
      : activeTab === "file"
        ? attachments.length > 0
        : activeTab === "gallery"
          ? selectedAssetId.length > 0
          : activeTab === "url"
            ? assetUrl.trim().length > 0
            : activeTab === "template"
              ? selectedTemplateId !== null
              : false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="relative mx-4 flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl"
        style={{ maxHeight: "90vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">
              Add to Publishing Queue
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Select content source, platform, and schedule
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
          >
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
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-card-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {/* Title (all tabs) */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional label for this queue item"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {/* ─── Platforms (select before content) ───── */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                Platforms
              </label>
              {connectedQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading connected
                  platforms...
                </div>
              ) : visiblePlatforms.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No connected platforms. Configure API keys in Admin &gt;
                  Integrations.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {visiblePlatforms.map((p) => {
                    const selected = platforms.includes(p.value);
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => togglePlatform(p.value)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ─── Brand Kit (optional) ──────────────────── */}
            {(brandKitsQuery.data?.brandKits ?? []).length > 0 && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                  <Palette className="mr-1 inline h-3.5 w-3.5" />
                  Brand Kit{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {brandKitsQuery.data!.brandKits.map((kit) => {
                    const selected = selectedBrandKitId === kit.id;
                    return (
                      <button
                        key={kit.id}
                        type="button"
                        onClick={() =>
                          setSelectedBrandKitId(selected ? null : kit.id)
                        }
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        <span
                          className="inline-block h-3 w-3 rounded-full border border-border/50"
                          style={{ backgroundColor: kit.primaryColor }}
                        />
                        <span
                          className="inline-block h-3 w-3 rounded-full border border-border/50"
                          style={{ backgroundColor: kit.secondaryColor }}
                        />
                        {kit.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─── Text Tab ──────────────────────────────── */}
            {activeTab === "text" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                    Content
                  </label>
                  <textarea
                    value={contentBody}
                    onChange={(e) => setContentBody(e.target.value)}
                    placeholder="Write or paste your post content (markdown supported)..."
                    rows={6}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground font-mono placeholder:text-muted-foreground"
                  />
                </div>

                {/* AI Enhance controls */}
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-card-foreground flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      AI Enhance
                    </span>
                    <InlineModelPicker
                      value={modelOverride}
                      onChange={setModelOverride}
                      className="w-48"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Enhance your text for engagement — the AI will optimize for
                    each platform, add hashtags, and use proper mention syntax
                    (@, #, u/, etc.).
                  </p>
                  <button
                    type="button"
                    onClick={handleEnhanceText}
                    disabled={
                      !contentBody.trim() ||
                      platforms.length === 0 ||
                      enhanceMutation.isPending
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {enhanceMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {enhanceMutation.isPending ? "Enhancing..." : "AI Enhance"}
                  </button>
                </div>

                {/* Per-platform previews when multiple platforms selected */}
                {Object.keys(textPreviews).length > 1 && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-card-foreground">
                      Platform Variants
                    </label>
                    <p className="text-xs text-muted-foreground">
                      The main content above was set to the first
                      platform&apos;s version. Click any variant to use it
                      instead.
                    </p>
                    {platforms.map((plat) => {
                      const preview = textPreviews[plat];
                      if (!preview) return null;
                      return (
                        <div
                          key={plat}
                          className="rounded-lg border border-border bg-background p-3"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold uppercase text-muted-foreground">
                              {plat}
                            </span>
                            <button
                              type="button"
                              onClick={() => setContentBody(preview.text)}
                              className="text-xs text-primary hover:underline flex items-center gap-1"
                            >
                              <Check className="h-3 w-3" />
                              Use This
                            </button>
                          </div>
                          <p className="text-sm text-foreground whitespace-pre-wrap">
                            {preview.text}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                        <div
                          key={a.filePath}
                          className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
                        >
                          {assetTypeIcon(a.assetType ?? "document")}
                          <span className="flex-1 truncate text-card-foreground">
                            {a.filename}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {a.filePath}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(a.filePath)}
                            className="text-muted-foreground hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* File browser */}
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                    Browse Files
                  </label>
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
                      <p className="py-4 text-center text-xs text-muted-foreground">
                        Empty directory
                      </p>
                    ) : (
                      browseQuery.data?.items.map((item) => {
                        const isSelected = attachments.some(
                          (a) => a.filePath === item.path,
                        );
                        return (
                          <button
                            type="button"
                            key={item.path}
                            onClick={() =>
                              item.isDirectory
                                ? setBrowseDir(item.path)
                                : addAttachment(item)
                            }
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 ${
                              isSelected
                                ? "bg-primary/10 text-primary"
                                : "text-card-foreground"
                            }`}
                          >
                            {item.isDirectory ? (
                              <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                            ) : (
                              assetTypeIcon(guessAssetType(item.name))
                            )}
                            <span className="flex-1 truncate">{item.name}</span>
                            {item.isDirectory && (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            {!item.isDirectory && isSelected && (
                              <span className="text-xs text-primary">
                                Added
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* AI Enhance for Files */}
                {attachments.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-card-foreground flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                        AI Enhance
                      </span>
                      <InlineModelPicker
                        value={modelOverride}
                        onChange={setModelOverride}
                        className="w-48"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Generate platform-optimized captions and publishing
                      instructions for the selected files.
                    </p>
                    <button
                      type="button"
                      onClick={handleEnhanceContent}
                      disabled={
                        attachments.length === 0 ||
                        platforms.length === 0 ||
                        enhanceContentMutation.isPending
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {enhanceContentMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {enhanceContentMutation.isPending
                        ? "Enhancing..."
                        : "AI Enhance"}
                    </button>
                  </div>
                )}

                {/* Platform content previews for files */}
                {contentPreviews && Object.keys(contentPreviews).length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-card-foreground">
                      Generated Content
                    </label>
                    {platforms.map((plat) => {
                      const preview = contentPreviews[plat];
                      if (!preview) return null;
                      return (
                        <div
                          key={plat}
                          className="rounded-lg border border-border bg-background p-3"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold uppercase text-muted-foreground">
                              {plat}
                            </span>
                          </div>
                          <p className="text-sm text-foreground whitespace-pre-wrap">
                            {preview.text}
                          </p>
                          {preview.publishingInstructions && (
                            <p className="mt-1.5 text-xs text-muted-foreground italic">
                              {preview.publishingInstructions}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ─── Gallery Tab ───────────────────────────── */}
            {activeTab === "gallery" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                    Search Gallery
                  </label>
                  <input
                    type="text"
                    value={gallerySearch}
                    onChange={(e) => setGallerySearch(e.target.value)}
                    placeholder="Search by filename, prompt, or tags..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                </div>

                {selectedAssetId && (
                  <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                    {(selectedAssetType === "image" ||
                      selectedAssetType === "scene") && (
                      <img
                        src={buildMediaUrl(
                          `/api/queue/assets/${selectedAssetId}/file`,
                        )}
                        alt={selectedAssetFilename}
                        className="h-12 w-12 rounded-md object-cover flex-shrink-0"
                      />
                    )}
                    {selectedAssetType === "video" && (
                      <div className="relative h-12 w-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                        <Film className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    {selectedAssetType !== "image" &&
                      selectedAssetType !== "scene" &&
                      selectedAssetType !== "video" &&
                      assetTypeIcon(selectedAssetType)}
                    <span className="flex-1 truncate text-card-foreground">
                      {selectedAssetFilename}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAssetId("");
                        setSelectedAssetFilename("");
                        setContentPreviews(null);
                      }}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background">
                  {galleryQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (galleryQuery.data?.assets ?? []).length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      No gallery assets found
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-0">
                      {galleryQuery.data?.assets.map((asset) => {
                        const isImage =
                          asset.type === "image" || asset.type === "scene";
                        const isVideo = asset.type === "video";
                        return (
                          <button
                            type="button"
                            key={asset.id}
                            onClick={() => {
                              setSelectedAssetId(asset.id);
                              setSelectedAssetFilename(asset.filename);
                              setSelectedAssetType(asset.type);
                              setContentPreviews(null);
                            }}
                            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                              selectedAssetId === asset.id
                                ? "bg-primary/10 text-primary"
                                : "text-card-foreground"
                            }`}
                          >
                            {isImage ? (
                              <img
                                src={buildMediaUrl(
                                  `/api/queue/assets/${asset.id}/file`,
                                )}
                                alt={asset.filename}
                                className="h-10 w-10 rounded-md object-cover flex-shrink-0 border border-border"
                              />
                            ) : isVideo ? (
                              <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                                <Film className="h-4 w-4 text-muted-foreground" />
                              </div>
                            ) : (
                              <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                                {assetTypeIcon(asset.type)}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <span className="block truncate text-sm">
                                {asset.filename}
                              </span>
                              {asset.prompt && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {asset.prompt}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground flex-shrink-0">
                              {asset.type}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* AI Enhance for Gallery */}
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-card-foreground flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      AI Enhance
                    </span>
                    <InlineModelPicker
                      value={modelOverride}
                      onChange={setModelOverride}
                      className="w-48"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Generate platform-optimized captions, descriptions, and
                    publishing instructions for this asset.
                    {platforms.includes("pinterest" as OutboxPlatform) &&
                      " Pinterest pins will include SEO-optimized keywords."}
                  </p>
                  <button
                    type="button"
                    onClick={handleEnhanceContent}
                    disabled={
                      !selectedAssetId ||
                      platforms.length === 0 ||
                      enhanceContentMutation.isPending
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {enhanceContentMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {enhanceContentMutation.isPending
                      ? "Enhancing..."
                      : "AI Enhance"}
                  </button>
                </div>

                {/* Platform content previews */}
                {contentPreviews && Object.keys(contentPreviews).length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-card-foreground">
                      Generated Content
                    </label>
                    {platforms.map((plat) => {
                      const preview = contentPreviews[plat];
                      if (!preview) return null;
                      return (
                        <div
                          key={plat}
                          className="rounded-lg border border-border bg-background p-3"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold uppercase text-muted-foreground">
                              {plat}
                            </span>
                          </div>
                          <p className="text-sm text-foreground whitespace-pre-wrap">
                            {preview.text}
                          </p>
                          {preview.publishingInstructions && (
                            <p className="mt-1.5 text-xs text-muted-foreground italic">
                              {preview.publishingInstructions}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ─── URL Tab ───────────────────────────────── */}
            {activeTab === "url" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                    External URL
                  </label>
                  <input
                    type="url"
                    value={assetUrl}
                    onChange={(e) => setAssetUrl(e.target.value)}
                    placeholder="https://example.com/content"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                </div>

                {/* AI Generate controls */}
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-card-foreground flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      AI Content Generation
                    </span>
                    <InlineModelPicker
                      value={modelOverride}
                      onChange={setModelOverride}
                      className="w-48"
                    />
                  </div>
                  <div className="flex items-center gap-4 flex-wrap">
                    <label className="text-sm text-card-foreground font-medium">
                      Images:
                    </label>
                    {(["extract", "generate", "none"] as const).map((opt) => (
                      <label
                        key={opt}
                        className="flex items-center gap-1.5 text-sm text-card-foreground cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="imageSource"
                          value={opt}
                          checked={imageSource === opt}
                          onChange={() => setImageSource(opt)}
                          className="accent-primary"
                        />
                        {opt === "extract"
                          ? "Pull from site"
                          : opt === "generate"
                            ? "Generate"
                            : "None"}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={
                      !assetUrl.trim() ||
                      platforms.length === 0 ||
                      generateMutation.isPending
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {generateMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {generateMutation.isPending
                      ? "Generating..."
                      : "AI Generate"}
                  </button>
                </div>

                {/* Loading hint for image generation */}
                {generateMutation.isPending && imageSource === "generate" && (
                  <p className="text-[11px] text-muted-foreground">
                    Generating post text and image — this may take a moment
                    while the image is rendered…
                  </p>
                )}

                {/* Preview cards per platform */}
                {previews && Object.keys(previews).length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-card-foreground">
                      Preview & Edit
                    </label>
                    {platforms.map((plat) => {
                      const preview = previews[plat];
                      if (!preview) return null;
                      const isEditing = editingPlatform === plat;
                      return (
                        <div
                          key={plat}
                          className="rounded-lg border border-border bg-background p-3"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold uppercase text-muted-foreground">
                              {plat}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setEditingPlatform(isEditing ? null : plat)
                              }
                              className="text-xs text-primary hover:underline flex items-center gap-1"
                            >
                              <Pencil className="h-3 w-3" />
                              {isEditing ? "Done" : "Edit"}
                            </button>
                          </div>
                          {isEditing ? (
                            <textarea
                              value={preview.text}
                              onChange={(e) =>
                                setPreviews((prev) => ({
                                  ...prev!,
                                  [plat]: { ...preview, text: e.target.value },
                                }))
                              }
                              rows={3}
                              className="w-full resize-none rounded border border-border bg-muted/30 px-2 py-1.5 text-sm text-foreground font-mono"
                            />
                          ) : (
                            <p className="text-sm text-foreground whitespace-pre-wrap">
                              {preview.text}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {/* Extracted images */}
                    {extractedImages.length > 0 && (
                      <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold uppercase text-muted-foreground">
                            Images from Site ({extractedImages.length})
                          </span>
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                if (
                                  selectedImages.size === extractedImages.length
                                ) {
                                  setSelectedImages(new Set());
                                } else {
                                  setSelectedImages(new Set(extractedImages));
                                }
                              }}
                              className="text-[10px] text-muted-foreground hover:text-card-foreground"
                            >
                              {selectedImages.size === extractedImages.length
                                ? "Deselect All"
                                : "Select All"}
                            </button>
                            {savedImages.length === 0 && (
                              <button
                                type="button"
                                onClick={handleSaveImages}
                                disabled={
                                  selectedImages.size === 0 || savingImages
                                }
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                              >
                                {savingImages ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Download className="h-3 w-3" />
                                )}
                                {savingImages
                                  ? "Saving..."
                                  : `Save ${selectedImages.size} to Gallery`}
                              </button>
                            )}
                            {savedImages.length > 0 && (
                              <span className="inline-flex items-center gap-1 text-xs text-green-400">
                                <Check className="h-3 w-3" /> Saved to gallery
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
                          {extractedImages.map((imgUrl) => {
                            const isSaved = savedImages.some(
                              (s) => s.url === imgUrl,
                            );
                            const isSelected = selectedImages.has(imgUrl);
                            return (
                              <button
                                type="button"
                                key={imgUrl}
                                onClick={() =>
                                  !isSaved && toggleImageSelection(imgUrl)
                                }
                                className={`relative h-20 w-20 rounded-lg border-2 overflow-hidden transition-all ${
                                  isSaved
                                    ? "border-green-500 opacity-90"
                                    : isSelected
                                      ? "border-primary ring-2 ring-primary/30"
                                      : "border-border opacity-60 hover:opacity-100"
                                }`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={buildMediaUrl(imgUrl)}
                                  alt=""
                                  className="h-full w-full object-cover"
                                />
                                {isSaved && (
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                                    <Check className="h-4 w-4 text-green-400" />
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Click images to select/deselect, then save to gallery.
                          They will be attached to the post.
                        </p>
                      </div>
                    )}

                    {imagePrompt && extractedImages.length === 0 && (
                      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                        <span className="text-xs font-semibold uppercase text-muted-foreground">
                          Image Prompt
                        </span>
                        <p className="mt-1 text-sm text-foreground">
                          {imagePrompt}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Image generation is unavailable — you can use this
                          prompt manually.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  {previews
                    ? "Review the generated content above, edit if needed, then queue for publishing."
                    : "Paste a URL and click AI Generate, or the AI agent will fetch and process content when publishing."}
                </p>
              </div>
            )}

            {/* ─── Template Tab ──────────────────────────── */}
            {activeTab === "template" && (
              <div className="space-y-3">
                {/* Template picker — collapses after selection */}
                {!selectedTemplateId ? (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                      Select Template
                    </label>
                    <div className="max-h-52 overflow-y-auto rounded-lg border border-border bg-background">
                      {templatesQuery.isLoading ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : (templatesQuery.data ?? []).length === 0 ? (
                        <p className="py-4 text-center text-xs text-muted-foreground">
                          No templates yet.{" "}
                          <a href="/templates" target="_blank" className="text-primary underline">
                            Create one
                          </a>
                        </p>
                      ) : (
                        (selectedBrandKitId
                          ? templatesQuery.data!.filter(
                              (t) => !t.brand_kit_id || t.brand_kit_id === selectedBrandKitId,
                            )
                          : templatesQuery.data!
                        ).map((tpl) => (
                          <button
                            type="button"
                            key={tpl.id}
                            onClick={() => {
                              setSelectedTemplateId(tpl.id);
                              const vars: Record<string, string> = {};
                              for (const v of extractTemplateVars(tpl.content_template)) {
                                vars[v] = templateVars[v] ?? "";
                              }
                              setTemplateVars(vars);
                              applyTemplateMutation.reset();
                            }}
                            className="flex w-full items-start gap-3 border-b border-border/50 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/60"
                          >
                            <LayoutTemplate className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-card-foreground">
                                  {tpl.name}
                                </span>
                                <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground">
                                  {tpl.platform}
                                </span>
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {tpl.content_template}
                              </p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  /* Selected template — show full editing experience */
                  <div className="space-y-3">
                    {/* Selected template header */}
                    <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <LayoutTemplate className="h-4 w-4 text-primary" />
                        <span className="text-sm font-medium text-primary">
                          {selectedTemplate?.name}
                        </span>
                        <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs capitalize text-primary">
                          {selectedTemplate?.platform}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTemplateId(null);
                          setTemplateVars({});
                          applyTemplateMutation.reset();
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Change
                      </button>
                    </div>

                    {/* Variable inputs + live preview */}
                    {templatePlaceholders.length > 0 ? (
                      <>
                        <div className="space-y-2">
                          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Fill in Variables
                          </label>
                          {templatePlaceholders.map((varName) => (
                            <div key={varName} className="flex items-center gap-2">
                              <span className="w-28 shrink-0 rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                                {`{{${varName}}}`}
                              </span>
                              <input
                                type="text"
                                value={templateVars[varName] ?? ""}
                                onChange={(e) =>
                                  setTemplateVars((prev) => ({
                                    ...prev,
                                    [varName]: e.target.value,
                                  }))
                                }
                                placeholder={varName}
                                className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                              />
                            </div>
                          ))}
                        </div>

                        {/* Live preview — renders as vars are filled */}
                        <div className="rounded-lg border border-border bg-muted/30 p-3">
                          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Preview
                          </p>
                          <p className="whitespace-pre-wrap text-sm text-foreground">
                            {selectedTemplate?.content_template.replace(
                              /\{\{(\w+)\}\}/g,
                              (_, key) =>
                                templateVars[key]
                                  ? `\u200b${templateVars[key]}\u200b`
                                  : `{{${key}}}`,
                            )}
                          </p>
                        </div>
                      </>
                    ) : (
                      /* No variables — show content directly */
                      <div className="rounded-lg border border-border bg-muted/30 p-3">
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Content
                        </p>
                        <p className="whitespace-pre-wrap text-sm text-foreground">
                          {selectedTemplate?.content_template}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ─── Common Fields ──────────────────────────── */}
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

            <div>
              <label className="mb-1.5 block text-sm font-medium text-card-foreground">
                Publishing Instructions
                {previews && agentContext.trim() && (
                  <span className="ml-2 text-xs font-normal text-primary">
                    (AI-generated \u2014 review & edit)
                  </span>
                )}
              </label>
              <textarea
                value={agentContext}
                onChange={(e) => setAgentContext(e.target.value)}
                placeholder="Describe how the AI agent should publish this content (e.g., caption, hashtags, target audience)..."
                rows={4}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {previews
                  ? "AI-generated instructions above. Edit or confirm before queuing."
                  : "The AI agent will use these instructions to craft and publish the post autonomously."}
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
              type="button"
              onClick={handlePublishNow}
              disabled={
                publishNowMutation.isPending || mutation.isPending || !canSubmit
              }
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {publishNowMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
              Publish Now
            </button>
            <button
              type="submit"
              disabled={
                mutation.isPending || publishNowMutation.isPending || !canSubmit
              }
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
              Queue
              {platforms.length > 1 ? ` (${platforms.length} platforms)` : ""}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
