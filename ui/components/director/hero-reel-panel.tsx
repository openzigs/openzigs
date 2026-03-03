"use client";

import { useState, useCallback, useRef, type ChangeEvent } from "react";
import { Sparkles, Loader2, Play, CheckCircle2, XCircle, ImagePlus, X, FileText, Upload, Wifi, WifiOff, Music, Library, Globe, Pause, Check } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

type HeroReelJobResponse = { produceJobId: string };
type HeroReelJobStatus = {
  status: "running" | "complete" | "failed";
  elapsedMs?: number;
  error?: string;
  manifest?: Record<string, unknown>;
};

type SidecarHealth = {
  ok: boolean;
  status?: string;
  model?: string | null;
  available_models?: string[];
  model_loaded?: boolean;
  error?: string;
};

type ImageModel = "flux-schnell" | "flux-dev";

type UserImage = {
  id: string;
  file: File;
  previewUrl: string;
  description: string;
  uploadedPath?: string;
};

type InspirationResult = {
  text: string;
  images: Array<{ path: string; description: string; url?: string }>;
};

type MusicTrack = { name: string; filePath: string; duration?: number; source?: string };

type GalleryAudioAsset = {
  id: string;
  filename: string;
  file_path: string;
  duration_seconds: number | null;
  prompt: string | null;
  source: string;
};

type SearchHit = {
  id: string;
  name: string;
  source: string;
  filePath?: string;
  duration?: number;
  previewUrl?: string;
  license: string;
  attribution?: string;
};

export const HeroReelPanel = () => {
  const [overview, setOverview] = useState("");
  const [enhancingOverview, setEnhancingOverview] = useState(false);
  const [produceJobId, setProduceJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "generating" | "complete" | "failed">("idle");
  const [imageModel, setImageModel] = useState<ImageModel>("flux-schnell");
  const [userImages, setUserImages] = useState<UserImage[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [inspirationFile, setInspirationFile] = useState<string | null>(null);
  const [inspirationResult, setInspirationResult] = useState<InspirationResult | null>(null);
  const [processingInspiration, setProcessingInspiration] = useState(false);
  const [musicTrack, setMusicTrack] = useState<MusicTrack | null>(null);
  const [musicTab, setMusicTab] = useState<"upload" | "gallery" | "search">("upload");
  const [musicSearchText, setMusicSearchText] = useState("");
  const [musicPlaying, setMusicPlaying] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const inspirationInputRef = useRef<HTMLInputElement>(null);
  const musicFileInputRef = useRef<HTMLInputElement>(null);

  // Check sidecar health to discover available models
  const sidecarHealthQuery = useQuery({
    queryKey: ["image-gen-health"],
    queryFn: () => fetchJson<SidecarHealth>("/api/admin/image-gen/health"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const sidecarUp = sidecarHealthQuery.data?.ok === true;
  const availableModels = sidecarHealthQuery.data?.available_models ?? [];
  const hasKontext = availableModels.includes("flux-kontext");
  const generationModels = availableModels.filter((m) => m !== "flux-kontext");

  const handleEnhanceOverview = useCallback(async () => {
    if (!overview.trim()) return;
    setEnhancingOverview(true);
    try {
      const result = await fetchJson<{ enhanced_overview: string }>(
        "/api/admin/director/enhance-overview",
        {
          method: "POST",
          body: JSON.stringify({ overview }),
        },
      );
      setOverview(result.enhanced_overview);
    } catch (err) {
      console.error("Overview enhancement failed:", err);
    } finally {
      setEnhancingOverview(false);
    }
  }, [overview]);

  const handleAddImages = useCallback(async (files: FileList) => {
    const newImages: UserImage[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => ({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        previewUrl: URL.createObjectURL(f),
        description: f.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
      }));
    if (newImages.length === 0) return;
    setUserImages((prev) => [...prev, ...newImages]);
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setUserImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const handleImageDescriptionChange = useCallback((id: string, description: string) => {
    setUserImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, description } : img)),
    );
  }, []);

  const uploadUserImages = useCallback(async (): Promise<Array<{ path: string; description: string }>> => {
    const uploaded: Array<{ path: string; description: string }> = [];
    for (const img of userImages) {
      if (img.uploadedPath) {
        uploaded.push({ path: img.uploadedPath, description: img.description });
        continue;
      }
      const buf = await img.file.arrayBuffer();
      const result = await fetchJson<{ filePath: string }>("/api/admin/director/files/upload-asset?kind=image", {
        method: "POST",
        headers: {
          "Content-Type": img.file.type,
          "x-file-name": encodeURIComponent(img.file.name),
        },
        body: buf,
      });
      img.uploadedPath = result.filePath;
      uploaded.push({ path: result.filePath, description: img.description });
    }
    return uploaded;
  }, [userImages]);

  const handleInspirationFile = useCallback(async (file: File) => {
    setProcessingInspiration(true);
    setInspirationFile(file.name);
    try {
      // Upload the file first
      const buf = await file.arrayBuffer();
      const uploadResult = await fetchJson<{ filePath: string }>("/api/admin/director/files/upload?kind=script", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: buf,
      });

      // Process it for inspiration
      const result = await fetchJson<InspirationResult>(
        "/api/admin/director/hero-reel/process-inspiration",
        {
          method: "POST",
          body: JSON.stringify({ filePath: uploadResult.filePath }),
        },
      );

      setInspirationResult(result);

      // Auto-add extracted images
      if (result.images.length > 0) {
        const newImages: UserImage[] = result.images.map((img, i) => ({
          id: `insp-${Date.now()}-${i}`,
          file: new File([], img.path.split("/").pop() ?? "image"),
          previewUrl: img.url ?? "",
          description: img.description,
          uploadedPath: img.path,
        }));
        setUserImages((prev) => [...prev, ...newImages]);
        showToast(`Extracted ${result.images.length} image(s) from ${file.name}`, "success");
      }

      if (result.text) {
        showToast(`Processed ${file.name} — content ready for inspiration`, "success");
      }
    } catch (err) {
      showToast(`Failed to process ${file.name}: ${(err as Error).message}`, "error");
      setInspirationFile(null);
      setInspirationResult(null);
    } finally {
      setProcessingInspiration(false);
    }
  }, []);

  // Music: upload a file directly from the browser
  const musicUploadMutation = useMutation({
    mutationFn: (file: File) =>
      fetchJson<{ success: boolean; filePath: string; fileName: string }>(
        "/api/admin/director/files/upload?kind=audio",
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
          body: file,
        },
      ),
    onSuccess: (data, file) => {
      setMusicTrack({ name: data.fileName || file.name, filePath: data.filePath, source: "upload" });
      showToast("Music track uploaded", "success");
    },
    onError: () => showToast("Music upload failed", "error"),
  });

  // Music: download a remote search result to the library then select it
  const musicDownloadMutation = useMutation({
    mutationFn: (hit: SearchHit) =>
      fetchJson<{ success: boolean; filePath: string; asset: { id: string; name: string; type: string; filePath: string } }>(
        "/api/admin/director/assets/download",
        {
          method: "POST",
          body: JSON.stringify({
            id: hit.id,
            name: hit.name,
            source: hit.source,
            previewUrl: hit.previewUrl,
            attribution: hit.attribution,
          }),
        },
      ),
    onSuccess: (data, hit) => {
      setMusicTrack({ name: hit.name, filePath: data.filePath, duration: hit.duration, source: hit.source });
      showToast("Track downloaded & selected", "success");
    },
    onError: () => showToast("Failed to download track", "error"),
  });

  // Music: search query
  const musicSearchResults = useQuery({
    queryKey: ["hero-reel-music-search", musicSearchText],
    queryFn: () =>
      fetchJson<{ assets: SearchHit[]; total: number }>(
        "/api/admin/director/assets/search",
        { method: "POST", body: JSON.stringify({ query: musicSearchText, source: "all", type: "music", perPage: 12 }) },
      ),
    enabled: musicSearchText.length > 1 && musicTab === "search",
    staleTime: 30_000,
  });

  // Music: gallery
  const musicGalleryQuery = useQuery({
    queryKey: ["hero-reel-music-gallery"],
    queryFn: () =>
      fetchJson<{ assets: GalleryAudioAsset[]; total: number }>("/api/queue/assets?type=audio&limit=50"),
    enabled: musicTab === "gallery",
    staleTime: 30_000,
  });

  const toggleMusicPlay = (id: string, url: string) => {
    if (musicPlaying === id) {
      setMusicPlaying(null);
      document.querySelectorAll("audio").forEach((a) => a.pause());
    } else {
      document.querySelectorAll("audio").forEach((a) => a.pause());
      const audio = new Audio(url);
      audio.play().catch(() => {});
      setMusicPlaying(id);
      audio.onended = () => setMusicPlaying(null);
    }
  };

  const formatDur = (s?: number | null) => {
    if (!s) return "";
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  function galleryFileUrl(filename: string): string {
    const base = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
    const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
    const url = `${base}/api/queue/assets/file/${encodeURIComponent(filename)}`;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  // Poll for job status
  const jobStatusQuery = useQuery({
    queryKey: ["hero-reel-job", produceJobId],
    queryFn: () =>
      fetchJson<HeroReelJobStatus>(`/api/admin/director/produce/${produceJobId}`),
    enabled: !!produceJobId && phase === "generating",
    refetchInterval: 2000,
  });

  // Transition on completion
  if (jobStatusQuery.data?.status === "complete" && phase === "generating") {
    setPhase("complete");
    showToast("Hero Reel storyboard generated!", "success");
  }
  if (jobStatusQuery.data?.status === "failed" && phase === "generating") {
    setPhase("failed");
    showToast(`Hero Reel failed: ${jobStatusQuery.data.error ?? "Unknown error"}`, "error");
  }

  const generateMutation = useMutation({
    mutationFn: async () => {
      setUploadingImages(true);
      let heroReelImages: Array<{ path: string; description: string }> | undefined;
      try {
        if (userImages.length > 0) {
          heroReelImages = await uploadUserImages();
        }
      } finally {
        setUploadingImages(false);
      }

      return fetchJson<HeroReelJobResponse>("/api/admin/director/produce", {
        method: "POST",
        body: JSON.stringify({
          mode: "hero-reel",
          heroReelOverview: overview || "Create an energetic highlight reel",
          defaultClipDuration: 2,
          skipTTS: true,
          imageProvider: "local",
          imageModel,
          heroReelImages,
          inspirationContext: inspirationResult?.text || undefined,
          musicTrackPath: musicTrack?.filePath || undefined,
        }),
      });
    },
    onSuccess: (data) => {
      setProduceJobId(data.produceJobId);
      setPhase("generating");
    },
    onError: (err) => {
      setPhase("failed");
      showToast(`Generation failed: ${(err as Error).message}`, "error");
    },
  });

  const handleGenerate = useCallback(() => {
    setPhase("generating");
    generateMutation.mutate();
  }, [generateMutation]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="h-5 w-5 text-amber-400" />
          <h2 className="text-xl font-semibold text-foreground">Hero Reel</h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Generate a fast-paced, music-driven montage with automated captions.
          No source document needed — just describe the vibe and let the AI direct.
        </p>
      </div>

      {/* Presentation Overview & Tone */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            1. Presentation Overview &amp; Tone{" "}
            <span className="text-muted-foreground/50">(optional)</span>
          </label>
          <button
            onClick={handleEnhanceOverview}
            disabled={enhancingOverview || !overview.trim() || phase === "generating"}
            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50 transition"
          >
            {enhancingOverview ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Sparkles className="h-2.5 w-2.5" />
            )}
            AI Enhance
          </button>
        </div>
        <textarea
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          placeholder="e.g., create a fast-paced montage showcasing platform highlights. Tone: energetic and modern. Focus: dark-themed engineering presentations."
          rows={4}
          disabled={phase === "generating"}
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
        />
        <p className="text-[11px] text-muted-foreground/60">
          Describe the overall feel, focus areas, and tone. The AI will autonomously
          generate 5-10 highlight scenes with captions and video-optimized prompts.
        </p>
      </div>

      {/* User-Provided Images */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            2. Your Images{" "}
            <span className="text-muted-foreground/50">(optional)</span>
          </label>
          <button
            onClick={() => imageInputRef.current?.click()}
            disabled={phase === "generating"}
            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50 transition"
          >
            <ImagePlus className="h-2.5 w-2.5" />
            Add Images
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleAddImages(e.target.files);
                e.target.value = "";
              }
            }}
          />
        </div>

        {userImages.length > 0 ? (
          <div className="space-y-2">
            {userImages.map((img) => (
              <div
                key={img.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-2"
              >
                {img.previewUrl ? (
                  <img
                    src={img.previewUrl}
                    alt={img.description}
                    className="h-16 w-16 flex-shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-md bg-muted">
                    <ImagePlus className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    value={img.description}
                    onChange={(e) => handleImageDescriptionChange(img.id, e.target.value)}
                    placeholder="Describe this image for the reel…"
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="mt-1 truncate text-[10px] text-muted-foreground/50">
                    {img.file.name}
                  </p>
                </div>
                <button
                  onClick={() => handleRemoveImage(img.id)}
                  className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div
            onClick={() => imageInputRef.current?.click()}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card/50 px-4 py-6 text-xs text-muted-foreground hover:border-primary/30 hover:bg-card transition"
          >
            <ImagePlus className="h-4 w-4" />
            <span>Drop images here or click to browse — AI will fill any gaps</span>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/60">
          Provide your own images and the AI will use them first, enhancing each with Kontext
          for a cinematic look. It will generate AI images only for missing scenes.
        </p>
      </div>

      {/* Inspiration File */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          3. Inspiration File{" "}
          <span className="text-muted-foreground/50">(optional)</span>
        </label>

        {inspirationFile ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
            <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{inspirationFile}</p>
              {processingInspiration && (
                <p className="text-[10px] text-muted-foreground">Processing…</p>
              )}
              {inspirationResult && (
                <p className="text-[10px] text-muted-foreground">
                  {inspirationResult.text ? `${inspirationResult.text.length.toLocaleString()} chars extracted` : "No text"}
                  {inspirationResult.images.length > 0 && ` · ${inspirationResult.images.length} image(s) found`}
                </p>
              )}
            </div>
            {processingInspiration ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <button
                onClick={() => {
                  setInspirationFile(null);
                  setInspirationResult(null);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          <div
            onClick={() => inspirationInputRef.current?.click()}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card/50 px-4 py-6 text-xs text-muted-foreground hover:border-primary/30 hover:bg-card transition"
          >
            <Upload className="h-4 w-4" />
            <span>Upload a markdown, PDF, image, or document as inspiration</span>
          </div>
        )}
        <input
          ref={inspirationInputRef}
          type="file"
          accept=".md,.markdown,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              handleInspirationFile(file);
              e.target.value = "";
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground/60">
          Upload a reference document and the AI will extract content, images, and themes
          to inspire the hero reel. Images from markdown files are auto-extracted and enhanced.
        </p>
      </div>

      {/* Background Music */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            4. Background Music{" "}
            <span className="text-muted-foreground/50">(optional)</span>
          </label>
          {musicTrack && (
            <button
              onClick={() => setMusicTrack(null)}
              className="text-[10px] text-muted-foreground hover:text-destructive transition"
            >
              Clear
            </button>
          )}
        </div>

        {musicTrack ? (
          <div className="flex items-center gap-2 rounded-xl border-2 border-primary/50 bg-primary/5 px-4 py-3">
            <Check className="h-4 w-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{musicTrack.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {musicTrack.source ?? "local"}{musicTrack.duration ? ` · ${formatDur(musicTrack.duration)}` : ""}
              </p>
            </div>
            <button onClick={() => setMusicTrack(null)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-border">
              {(["upload", "gallery", "search"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setMusicTab(t)}
                  className={`flex-1 px-3 py-2 text-xs font-medium capitalize transition ${
                    musicTab === t
                      ? "border-b-2 border-primary text-primary bg-primary/5"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "upload" && <Upload className="inline h-3 w-3 mr-1" />}
                  {t === "gallery" && <Library className="inline h-3 w-3 mr-1" />}
                  {t === "search" && <Globe className="inline h-3 w-3 mr-1" />}
                  {t}
                </button>
              ))}
            </div>

            {/* Upload tab */}
            {musicTab === "upload" && (
              <div className="p-3 space-y-2">
                <button
                  onClick={() => musicFileInputRef.current?.click()}
                  disabled={musicUploadMutation.isPending || phase === "generating"}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-card/50 px-4 py-5 text-xs text-muted-foreground hover:border-primary/30 hover:bg-card transition disabled:opacity-50"
                >
                  {musicUploadMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Music className="h-4 w-4" />
                  )}
                  {musicUploadMutation.isPending ? "Uploading…" : "Upload an audio file (mp3, wav, m4a, ogg)"}
                </button>
                <input
                  ref={musicFileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
                  className="hidden"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const file = e.target.files?.[0];
                    if (file) musicUploadMutation.mutate(file);
                    e.target.value = "";
                  }}
                />
              </div>
            )}

            {/* Gallery tab */}
            {musicTab === "gallery" && (
              <div className="p-3">
                {musicGalleryQuery.isLoading && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!musicGalleryQuery.isLoading && (musicGalleryQuery.data?.assets ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No audio files in gallery yet.</p>
                )}
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {(musicGalleryQuery.data?.assets ?? []).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setMusicTrack({ name: a.filename, filePath: a.file_path, duration: a.duration_seconds ?? undefined, source: a.source })}
                      className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted transition"
                    >
                      <button
                        onClickCapture={(ev) => {
                          ev.stopPropagation();
                          toggleMusicPlay(a.id, galleryFileUrl(a.filename));
                        }}
                        className="rounded-full p-1 border border-border text-muted-foreground hover:text-foreground shrink-0"
                      >
                        {musicPlaying === a.id ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{a.filename}</p>
                        {a.duration_seconds && (
                          <p className="text-[10px] text-muted-foreground">{formatDur(a.duration_seconds)}</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Search tab */}
            {musicTab === "search" && (
              <div className="p-3 space-y-2">
                <input
                  value={musicSearchText}
                  onChange={(e) => setMusicSearchText(e.target.value)}
                  placeholder="Search Pixabay, Jamendo, local library…"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {musicSearchResults.isLoading && (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {(musicSearchResults.data?.assets ?? []).map((hit) => (
                    <div key={hit.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
                      {hit.previewUrl && (
                        <button
                          onClick={() => toggleMusicPlay(hit.id, hit.previewUrl!)}
                          className="rounded-full p-1 border border-border text-muted-foreground hover:text-foreground shrink-0"
                        >
                          {musicPlaying === hit.id ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{hit.name}</p>
                        <p className="text-[10px] text-muted-foreground">{hit.source}{hit.duration ? ` · ${formatDur(hit.duration)}` : ""}</p>
                      </div>
                      <button
                        onClick={() => {
                          if (hit.filePath) {
                            setMusicTrack({ name: hit.name, filePath: hit.filePath, duration: hit.duration, source: hit.source });
                          } else {
                            musicDownloadMutation.mutate(hit);
                          }
                        }}
                        disabled={musicDownloadMutation.isPending}
                        className="shrink-0 rounded px-2 py-1 text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 transition"
                      >
                        {musicDownloadMutation.isPending && musicDownloadMutation.variables?.id === hit.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : "Select"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/60">
          Add a soundtrack to your hero reel — upload your own track or search royalty-free music.
        </p>
      </div>

      {/* Image Model Selection */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            5. Image Model
          </label>
          <div className="flex items-center gap-1.5">
            {sidecarHealthQuery.isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : sidecarUp ? (
              <Wifi className="h-3 w-3 text-emerald-400" />
            ) : (
              <WifiOff className="h-3 w-3 text-red-400" />
            )}
            <span className="text-[10px] text-muted-foreground">
              {sidecarUp ? "Sidecar online" : "Sidecar offline"}
            </span>
          </div>
        </div>

        <select
          value={imageModel}
          onChange={(e) => setImageModel(e.target.value as ImageModel)}
          disabled={phase === "generating"}
          className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
        >
          <option value="flux-schnell">Flux Schnell (fast, 4 steps)</option>
          <option value="flux-dev">Flux Dev (high quality, 25 steps)</option>
        </select>

        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted-foreground/60">
            Model used for AI-generated scenes.
            {hasKontext && " Kontext is always used to enhance your uploaded images."}
          </p>
          {sidecarUp && generationModels.length > 0 && (
            <p className="text-[10px] text-muted-foreground/40">
              Available: {generationModels.join(", ")}
              {hasKontext && " · flux-kontext (editing)"}
            </p>
          )}
          {!sidecarUp && !sidecarHealthQuery.isLoading && (
            <p className="text-[10px] text-red-400/70">
              Image generation sidecar is not reachable. Start it or check Admin → Image Gen settings.
            </p>
          )}
        </div>
      </div>

      {/* Pipeline info */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-400 font-medium mb-1">What happens next</p>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li>&bull; The AI generates a montage storyboard of 5-10 fast-paced highlight scenes</li>
          <li>&bull; Your images are used first{hasKontext ? " and enhanced with Kontext for a cinematic look" : ""}</li>
          <li>&bull; Remaining scenes get AI-generated images via {imageModel === "flux-dev" ? "Flux Dev" : "Flux Schnell"}</li>
          <li>&bull; Automated captions are generated for each scene</li>
          <li>&bull; Background music and crossfade transitions are applied</li>
          <li>&bull; No narrator script or TTS — the reel is purely visual</li>
        </ul>
      </div>

      {/* Generate / Status */}
      <div className="flex flex-col items-center gap-3">
        {phase === "idle" && (
          <button
            onClick={handleGenerate}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-8 py-3 text-sm font-semibold text-white shadow-lg hover:from-amber-600 hover:to-orange-600 transition-all"
          >
            <Play className="h-4 w-4" />
            Generate Hero Reel
          </button>
        )}

        {phase === "generating" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            {uploadingImages ? "Uploading images…" : "Generating Hero Reel storyboard…"}
          </div>
        )}

        {phase === "complete" && (
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Hero Reel storyboard generated successfully!
          </div>
        )}

        {phase === "failed" && (
          <div className="space-y-2 text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-red-400">
              <XCircle className="h-4 w-4" />
              Generation failed
            </div>
            <button
              onClick={() => {
                setPhase("idle");
                setProduceJobId(null);
              }}
              className="text-xs text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
