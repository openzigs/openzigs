"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";
import {
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Upload,
  Check,
  ChevronDown,
  Sparkles,
  Wand2,
} from "lucide-react";

// ── Types ──

interface PinterestBoard {
  id: string;
  name: string;
  description: string;
  pin_count: number;
  privacy: string;
}

interface GalleryAsset {
  id: string;
  filename: string;
  type: string;
  prompt?: string;
  file_path?: string;
}

interface ContentIdea {
  id: number;
  topic: string;
  suggested_title: string;
  suggested_description: string;
  target_keywords: string;
  difficulty: string;
  estimated_volume: string;
}

interface CreatePinModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea?: ContentIdea | null;
  onPinCreated?: (pinId: string, ideaId?: number) => void;
}

type ImageSource = "gallery" | "url" | "generate";

// ── Component ──

export function CreatePinModal({ open, onOpenChange, idea, onPinCreated }: CreatePinModalProps) {
  // Form state
  const [boardId, setBoardId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [altText, setAltText] = useState("");
  const [imageSource, setImageSource] = useState<ImageSource>("gallery");
  const [imageUrl, setImageUrl] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(null);
  const [gallerySearch, setGallerySearch] = useState("");
  const [boardDropdownOpen, setBoardDropdownOpen] = useState(false);

  // AI enhance state
  const [aiModel, setAiModel] = useState("");

  // Image generation state
  const [genPrompt, setGenPrompt] = useState("");
  const [genModel, setGenModel] = useState<"flux-schnell" | "flux-dev">("flux-schnell");
  const [generatedImagePath, setGeneratedImagePath] = useState<string | null>(null);
  const [generatedImageId, setGeneratedImageId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Pre-fill from idea
  useEffect(() => {
    if (idea && open) {
      setTitle(idea.suggested_title.slice(0, 100));
      let desc = idea.suggested_description;
      try {
        const kw = JSON.parse(idea.target_keywords) as string[];
        if (kw.length > 0) {
          desc += "\n\n" + kw.map((k) => `#${k.replace(/\s+/g, "")}`).join(" ");
        }
      } catch { /* ignore */ }
      setDescription(desc.slice(0, 800));
      // Pre-fill gen prompt from title
      setGenPrompt(`Pinterest pin image: ${idea.suggested_title}`);
    }
  }, [idea, open]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setBoardId("");
      setTitle("");
      setDescription("");
      setLink("");
      setAltText("");
      setImageUrl("");
      setSelectedAssetId(null);
      setSelectedAssetPath(null);
      setGallerySearch("");
      setImageSource("gallery");
      setGenPrompt("");
      setGeneratedImagePath(null);
      setGeneratedImageId(null);
    }
  }, [open]);

  // Fetch boards
  const boardsQuery = useQuery<{ boards: PinterestBoard[] }>({
    queryKey: ["pinterest-boards"],
    queryFn: () => fetchJson("/api/pinterest/boards"),
    enabled: open,
    staleTime: 60_000,
  });

  // Fetch gallery assets (images only)
  const galleryQuery = useQuery<{ assets: GalleryAsset[] }>({
    queryKey: ["pinterest-gallery-assets", gallerySearch],
    queryFn: () => {
      const params = new URLSearchParams({ type: "image", limit: "50" });
      if (gallerySearch.trim()) params.set("q", gallerySearch.trim());
      return fetchJson(`/api/queue/assets?${params.toString()}`);
    },
    enabled: open && imageSource === "gallery",
    staleTime: 30_000,
  });

  // AI Enhance mutation
  const enhanceMutation = useMutation({
    mutationFn: (body: { text: string; platforms: string[]; model?: string }) =>
      fetchJson<{ previews: Record<string, { text: string }> }>("/api/admin/outbox/enhance-text", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      const preview = data.previews?.pinterest;
      if (preview?.text) {
        // Split AI response — first line is title, rest is description
        const lines = preview.text.split("\n").filter((l) => l.trim());
        if (lines.length > 0) {
          // If the AI returned text that looks like "Title: ...\nDescription: ..."
          const hasTitle = title.trim();
          if (!hasTitle && lines.length > 1) {
            setTitle(lines[0].replace(/^(title:\s*)/i, "").slice(0, 100));
            setDescription(lines.slice(1).join("\n").replace(/^(description:\s*)/i, "").slice(0, 800));
          } else {
            // Just enhance the description
            setDescription(preview.text.slice(0, 800));
          }
        }
        showToast("Content enhanced by AI", "success");
      } else {
        showToast("AI returned no Pinterest preview", "error");
      }
    },
    onError: (err: Error) => showToast(`AI enhance failed: ${err.message}`, "error"),
  });

  // Image generation mutation
  const generateImageMutation = useMutation({
    mutationFn: async (payload: { prompt: string; model: string }) => {
      // Submit job
      const job = await fetchJson<{ id: string }>("/api/queue/jobs", {
        method: "POST",
        body: JSON.stringify({
          type: "txt2img",
          payload: {
            prompt: payload.prompt,
            width: 1000,
            height: 1500, // Pinterest 2:3 ratio
            steps: payload.model === "flux-schnell" ? 4 : 25,
            guidance_scale: 3.5,
          },
          model: payload.model,
        }),
      });

      // Poll for completion
      const jobId = job.id;
      let attempts = 0;
      const maxAttempts = 60;
      while (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
        const status = await fetchJson<{ status: string; result?: { file_path?: string; filename?: string }; asset_id?: string }>(`/api/queue/jobs/${jobId}`);
        if (status.status === "completed") {
          return { file_path: status.result?.file_path ?? null, asset_id: status.asset_id ?? null };
        }
        if (status.status === "failed") {
          throw new Error("Image generation failed");
        }
      }
      throw new Error("Image generation timed out");
    },
    onSuccess: (data) => {
      setGeneratedImagePath(data.file_path);
      setGeneratedImageId(data.asset_id);
      queryClient.invalidateQueries({ queryKey: ["pinterest-gallery-assets"] });
      showToast("Image generated!", "success");
    },
    onError: (err: Error) => showToast(`Image generation failed: ${err.message}`, "error"),
  });

  // Create pin mutation
  const createPinMutation = useMutation({
    mutationFn: (payload: Record<string, string>) =>
      fetchJson<{ ok: boolean; pin_id: string; url: string }>("/api/pinterest/create-pin", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      showToast(`Pin created! ${data.url}`, "success");
      onPinCreated?.(data.pin_id, idea?.id);
      onOpenChange(false);
    },
    onError: (err) => {
      showToast(`Failed to create pin: ${err instanceof Error ? err.message : String(err)}`, "error");
    },
  });

  const boards = boardsQuery.data?.boards ?? [];
  const assets = galleryQuery.data?.assets ?? [];
  const selectedBoard = boards.find((b) => b.id === boardId);

  const hasImage =
    imageSource === "url"
      ? !!imageUrl.trim()
      : imageSource === "generate"
        ? !!generatedImagePath
        : !!selectedAssetPath;

  const canSubmit =
    boardId &&
    title.trim() &&
    description.trim() &&
    hasImage &&
    !createPinMutation.isPending;

  const handleEnhance = () => {
    const text = [title.trim(), description.trim()].filter(Boolean).join("\n\n") || "Pinterest pin content";
    enhanceMutation.mutate({
      text,
      platforms: ["pinterest"],
      model: aiModel || undefined,
    });
  };

  const handleGenerateImage = () => {
    if (!genPrompt.trim()) {
      showToast("Enter a prompt for image generation", "error");
      return;
    }
    setGeneratedImagePath(null);
    setGeneratedImageId(null);
    generateImageMutation.mutate({ prompt: genPrompt.trim(), model: genModel });
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const payload: Record<string, string> = {
      board_id: boardId,
      title: title.trim(),
      description: description.trim(),
    };
    if (link.trim()) payload.link = link.trim();
    if (altText.trim()) payload.alt_text = altText.trim();
    if (imageSource === "url") {
      payload.image_url = imageUrl.trim();
    } else if (imageSource === "generate" && generatedImagePath) {
      payload.image_path = generatedImagePath;
    } else if (selectedAssetPath) {
      payload.image_path = selectedAssetPath;
    }
    createPinMutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Pinterest Pin</DialogTitle>
          <DialogDescription>
            {idea ? `Creating pin from idea: "${idea.suggested_title}"` : "Create a new pin on Pinterest"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Board selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Board *</label>
            {boardsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading boards...
              </div>
            ) : boardsQuery.isError ? (
              <p className="text-xs text-red-500">Failed to load boards. Check Pinterest connection.</p>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBoardDropdownOpen(!boardDropdownOpen)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm hover:border-primary/50 transition"
                >
                  <span className={selectedBoard ? "text-foreground" : "text-muted-foreground"}>
                    {selectedBoard ? `${selectedBoard.name} (${selectedBoard.pin_count} pins)` : "Select a board..."}
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
                {boardDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card shadow-lg max-h-48 overflow-y-auto">
                    {boards.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => { setBoardId(b.id); setBoardDropdownOpen(false); }}
                        className={`flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                          b.id === boardId ? "bg-primary/10 text-primary" : ""
                        }`}
                      >
                        <span>{b.name}</span>
                        <span className="text-xs text-muted-foreground">{b.pin_count} pins</span>
                      </button>
                    ))}
                    {boards.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">No boards found</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Title * ({title.length}/100)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 100))}
              placeholder="Pin title..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Description * ({description.length}/800)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 800))}
              placeholder="Pin description with keywords and hashtags..."
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition resize-none"
            />
          </div>

          {/* AI Enhance */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-card-foreground flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                AI Enhance
              </span>
              <InlineModelPicker value={aiModel} onChange={setAiModel} className="w-48" />
            </div>
            <p className="text-xs text-muted-foreground">
              Optimize your title and description for Pinterest SEO with AI-generated keywords and hashtags.
            </p>
            <button
              type="button"
              onClick={handleEnhance}
              disabled={(!title.trim() && !description.trim()) || enhanceMutation.isPending}
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

          {/* Image source tabs */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Image *</label>
            <div className="flex gap-1 rounded-lg bg-muted/50 p-1 mb-3">
              <button
                type="button"
                onClick={() => setImageSource("gallery")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  imageSource === "gallery" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ImageIcon className="h-3.5 w-3.5" /> Gallery
              </button>
              <button
                type="button"
                onClick={() => setImageSource("url")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  imageSource === "url" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <LinkIcon className="h-3.5 w-3.5" /> Image URL
              </button>
              <button
                type="button"
                onClick={() => setImageSource("generate")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  imageSource === "generate" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Wand2 className="h-3.5 w-3.5" /> AI Generate
              </button>
            </div>

            {imageSource === "gallery" && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={gallerySearch}
                  onChange={(e) => setGallerySearch(e.target.value)}
                  placeholder="Search gallery images..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:border-primary focus:outline-none transition"
                />
                {galleryQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading images...
                  </div>
                ) : assets.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    No images found. Generate images in the Gallery first.
                  </p>
                ) : (
                  <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto rounded-lg border border-border p-2">
                    {assets.map((asset) => (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => {
                          setSelectedAssetId(asset.id);
                          setSelectedAssetPath(asset.file_path ?? null);
                        }}
                        className={`relative aspect-square rounded-lg overflow-hidden border-2 transition ${
                          selectedAssetId === asset.id
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-transparent hover:border-primary/30"
                        }`}
                      >
                        <img
                          src={buildMediaUrl(`/api/queue/assets/${asset.id}/file`)}
                          alt={asset.filename}
                          className="h-full w-full object-cover"
                        />
                        {selectedAssetId === asset.id && (
                          <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                            <Check className="h-5 w-5 text-primary" />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {selectedAssetId && (
                  <p className="text-xs text-muted-foreground">
                    Selected: {assets.find((a) => a.id === selectedAssetId)?.filename}
                  </p>
                )}
              </div>
            )}

            {imageSource === "url" && (
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/image.jpg"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition"
              />
            )}

            {imageSource === "generate" && (
              <div className="space-y-3">
                <textarea
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  placeholder="Describe the Pinterest pin image you want to generate..."
                  rows={2}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition resize-none"
                />
                <div className="flex items-center gap-3">
                  <select
                    value={genModel}
                    onChange={(e) => setGenModel(e.target.value as "flux-schnell" | "flux-dev")}
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:border-primary focus:outline-none"
                  >
                    <option value="flux-schnell">Flux Schnell (fast)</option>
                    <option value="flux-dev">Flux Dev (quality)</option>
                  </select>
                  <span className="text-[10px] text-muted-foreground">1000x1500 (2:3 Pinterest)</span>
                  <button
                    type="button"
                    onClick={handleGenerateImage}
                    disabled={!genPrompt.trim() || generateImageMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {generateImageMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                    {generateImageMutation.isPending ? "Generating..." : "Generate"}
                  </button>
                </div>
                {generatedImageId && (
                  <div className="rounded-lg border border-primary/30 p-2">
                    <img
                      src={buildMediaUrl(`/api/queue/assets/${generatedImageId}/file`)}
                      alt="Generated pin image"
                      className="max-h-48 rounded-md object-contain mx-auto"
                    />
                    <p className="text-xs text-muted-foreground text-center mt-1">Generated image ready</p>
                  </div>
                )}
                {generateImageMutation.isPending && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <Loader2 className="h-3 w-3 animate-spin" /> Generating image (this may take 30-60 seconds)...
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Link */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Destination Link (optional)</label>
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://your-site.com/article"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition"
            />
          </div>

          {/* Alt text */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Alt Text (optional, for SEO + accessibility)</label>
            <input
              type="text"
              value={altText}
              onChange={(e) => setAltText(e.target.value.slice(0, 500))}
              placeholder="Describe the image for accessibility..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none transition"
            />
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createPinMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> Create Pin
                </>
              )}
            </button>
          </div>

          {createPinMutation.isError && (
            <p className="text-xs text-red-500 mt-2">
              {createPinMutation.error instanceof Error ? createPinMutation.error.message : "Pin creation failed"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
