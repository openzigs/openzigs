"use client";

import { useState, useRef, type ChangeEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Music,
  Search,
  Download,
  Play,
  Pause,
  Library,
  Globe,
  Tag,
  Check,
  Loader2,
  Plus,
  Upload,
  FolderOpen,
  Disc3,
} from "lucide-react";
import type { SelectedAsset } from "./types";

type GalleryAudioAsset = {
  id: string;
  type: "audio";
  filename: string;
  file_path: string;
  mime_type: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  prompt: string | null;
  source: string;
  tags: string[] | null;
  created_at: string;
};

interface SoundBrowserStepProps {
  selected: SelectedAsset | null;
  onSelect: (asset: SelectedAsset | null) => void;
}

type AssetResult = {
  id: string;
  name: string;
  source: "local" | "pixabay" | "jamendo" | "pexels";
  type: "music" | "sfx" | "image" | "video";
  filePath?: string;
  duration?: number;
  tags: string[];
  license: string;
  attribution?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
};

type SearchResult = {
  assets: AssetResult[];
  total: number;
  page: number;
  perPage: number;
};

export const SoundBrowserStep = ({ selected, onSelect }: SoundBrowserStepProps) => {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "local" | "pixabay" | "jamendo">("all");
  const [type, setType] = useState<"" | "music" | "sfx">("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [tab, setTab] = useState<"search" | "upload" | "gallery">("search");
  const [uploadPath, setUploadPath] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [uploadType, setUploadType] = useState<"music" | "sfx" | "voiceover">("music");
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const searchQuery = useQuery({
    queryKey: ["director-assets-search", query, source, type],
    queryFn: () =>
      fetchJson<SearchResult>("/api/admin/director/assets/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          source,
          type: type || undefined,
          perPage: 20,
        }),
      }),
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const galleryQuery = useQuery({
    queryKey: ["gallery-assets", "audio"],
    queryFn: () =>
      fetchJson<{ assets: GalleryAudioAsset[]; total: number }>(
        "/api/queue/assets?type=audio&limit=50",
      ),
    enabled: tab === "gallery",
    staleTime: 30_000,
  });

  function galleryFileUrl(filename: string): string {
    const base = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
    const token = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";
    const url = `${base}/api/queue/assets/file/${encodeURIComponent(filename)}`;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  const downloadMutation = useMutation({
    mutationFn: (asset: AssetResult) =>
      fetchJson<{ success: boolean; filePath: string; asset: { id: string; name: string; source: string; type: string; filePath: string } }>(
        "/api/admin/director/assets/download",
        {
          method: "POST",
          body: JSON.stringify({
            id: asset.id,
            name: asset.name,
            source: asset.source,
            previewUrl: asset.previewUrl,
            attribution: asset.attribution,
          }),
        },
      ),
    onSuccess: () => showToast("Asset downloaded to library", "success"),
    onError: () => showToast("Download failed", "error"),
  });

  const uploadMutation = useMutation({
    mutationFn: (params: { filePath: string; name?: string; type?: "music" | "sfx" | "voiceover" }) =>
      fetchJson<{ success: boolean; filePath: string; asset: { id: string; name: string; source: string; type: string; filePath: string } }>(
        "/api/admin/director/assets/upload",
        {
          method: "POST",
          body: JSON.stringify(params),
        },
      ),
    onSuccess: (data) => {
      showToast(`Uploaded: ${data.asset.name}`, "success");
      onSelect({
        id: data.asset.id,
        name: data.asset.name,
        source: "upload",
        type: (data.asset.type as SelectedAsset["type"]) || "music",
        filePath: data.filePath,
        license: "Local Upload",
      });
      setUploadPath("");
      setUploadName("");
    },
    onError: () => showToast("Upload failed", "error"),
  });

  const browserUploadMutation = useMutation({
    mutationFn: (file: File) =>
      fetchJson<{
        success: boolean;
        filePath: string;
        fileName: string;
        size: number;
        mimeType: string;
      }>("/api/admin/director/files/upload?kind=audio", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-type": file.type || "application/octet-stream",
        },
        body: file,
      }),
    onSuccess: (data) => {
      showToast("Audio file uploaded", "success");
      onSelect({
        id: `upload-${Date.now()}`,
        name: data.fileName,
        source: "upload",
        type: uploadType === "sfx" ? "sfx" : "music",
        filePath: data.filePath,
        license: "Local Upload",
      });
    },
    onError: () => showToast("File chooser upload failed", "error"),
  });

  const handleUpload = () => {
    if (!uploadPath.trim()) return;
    uploadMutation.mutate({
      filePath: uploadPath.trim(),
      name: uploadName.trim() || undefined,
      type: uploadType,
    });
  };

  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    browserUploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const togglePlay = (id: string, previewUrl?: string) => {
    if (!previewUrl) return;
    if (playing === id) {
      setPlaying(null);
      document.querySelectorAll("audio").forEach((a) => a.pause());
    } else {
      document.querySelectorAll("audio").forEach((a) => a.pause());
      setPlaying(id);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const sourceIcon = (src: string) => {
    switch (src) {
      case "local":
        return <Library className="h-3 w-3" />;
      default:
        return <Globe className="h-3 w-3" />;
    }
  };

  const selectAsset = async (asset: AssetResult) => {
    if (selected?.id === asset.id) {
      onSelect(null);
      return;
    }

    const isRemote = asset.source !== "local" && !asset.filePath;

    if (isRemote && asset.previewUrl) {
      // Remote asset without a local file — download it first so
      // the produce pipeline gets a real filePath, not an empty string.
      setDownloading(asset.id);
      try {
        const result = await downloadMutation.mutateAsync(asset);
        onSelect({
          id: asset.id,
          name: asset.name,
          source: asset.source,
          type: asset.type,
          filePath: result.filePath,
          duration: asset.duration,
          previewUrl: asset.previewUrl,
          license: asset.license,
          attribution: asset.attribution,
        });
        showToast("Track downloaded & selected", "success");
      } catch {
        showToast("Failed to download track", "error");
      } finally {
        setDownloading(null);
      }
    } else {
      onSelect({
        id: asset.id,
        name: asset.name,
        source: asset.source,
        type: asset.type,
        filePath: asset.filePath,
        duration: asset.duration,
        previewUrl: asset.previewUrl,
        license: asset.license,
        attribution: asset.attribution,
      });
    }
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground mb-1">
          Select Background Music
        </h2>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Search for royalty-free music and sound effects from your local library,
          Pixabay, or Jamendo — or upload a local file. This step is optional.
        </p>
      </div>

      {/* Selected Track */}
      {selected && (
        <div className="flex items-center gap-3 rounded-xl border-2 border-primary/50 bg-primary/5 px-4 py-3">
          <Check className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{selected.name}</p>
            <p className="text-xs text-muted-foreground">
              {selected.source} • {formatDuration(selected.duration)} • {selected.license}
            </p>
          </div>
          <button
            onClick={() => onSelect(null)}
            className="text-xs text-muted-foreground hover:text-destructive transition"
          >
            Remove
          </button>
        </div>
      )}

      {/* Tab Switcher */}
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        <button
          onClick={() => setTab("search")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
            tab === "search"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Search className="h-3.5 w-3.5" />
          Search
        </button>
        <button
          onClick={() => setTab("upload")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
            tab === "upload"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Upload className="h-3.5 w-3.5" />
          Upload
        </button>
        <button
          onClick={() => setTab("gallery")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
            tab === "gallery"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Disc3 className="h-3.5 w-3.5" />
          Gallery
        </button>
      </div>

      {/* Search Tab */}
      {tab === "search" && (
        <>

      {/* Search Form */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search music & sound effects..."
            className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-border bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
          className="rounded-xl border border-border bg-card text-sm text-foreground px-3 py-2"
        >
          <option value="all">All</option>
          <option value="local">Local</option>
          <option value="pixabay">Pixabay</option>
          <option value="jamendo">Jamendo</option>
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="rounded-xl border border-border bg-card text-sm text-foreground px-3 py-2"
        >
          <option value="">All</option>
          <option value="music">Music</option>
          <option value="sfx">SFX</option>
        </select>
      </div>

      {/* Results */}
      <div className="space-y-1.5 max-h-[360px] overflow-y-auto rounded-xl">
        {searchQuery.isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Searching…</span>
          </div>
        )}

        {searchQuery.data && searchQuery.data.assets.length === 0 && (
          <p className="text-muted-foreground text-sm py-8 text-center">No results found</p>
        )}

        {searchQuery.data?.assets.map((asset) => {
          const isSelected = selected?.id === asset.id;
          const isDownloading = downloading === asset.id;
          return (
            <div
              key={asset.id}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-colors cursor-pointer ${
                isSelected
                  ? "border-primary/50 bg-primary/5"
                  : isDownloading
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-transparent hover:bg-muted/50"
              }`}
              onClick={() => !isDownloading && selectAsset(asset)}
            >
              {/* Play/Pause */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay(asset.id, asset.previewUrl);
                }}
                disabled={!asset.previewUrl}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-primary/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {playing === asset.id ? (
                  <Pause className="h-3.5 w-3.5 text-foreground" />
                ) : (
                  <Play className="h-3.5 w-3.5 text-foreground ml-0.5" />
                )}
              </button>

              {/* Hidden audio */}
              {playing === asset.id && asset.previewUrl && (
                <audio
                  src={asset.previewUrl}
                  autoPlay
                  onEnded={() => setPlaying(null)}
                  className="hidden"
                />
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground truncate">{asset.name}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {sourceIcon(asset.source)}
                    {asset.source}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">{formatDuration(asset.duration)}</span>
                  <span className="text-xs text-muted-foreground/40">•</span>
                  <span className="text-xs text-muted-foreground">{asset.license}</span>
                  {asset.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
                    >
                      <Tag className="h-2.5 w-2.5" />
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Select indicator, downloading spinner, or Download button */}
              {isDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin text-amber-400 shrink-0" />
              ) : isSelected ? (
                <Check className="h-4 w-4 text-primary shrink-0" />
              ) : asset.source !== "local" && asset.previewUrl ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadMutation.mutate(asset);
                  }}
                  disabled={downloadMutation.isPending}
                  className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-30"
                  title="Download to local library"
                >
                  <Download className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    selectAsset(asset);
                  }}
                  className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition"
                  title="Select this track"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {!query && !selected && (
        <div className="text-center py-6">
          <Music className="h-10 w-10 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            Search for royalty-free music and sound effects
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Sources: Local Library • Pixabay • Jamendo
          </p>
        </div>
      )}
        </>
      )}

      {/* Gallery Tab */}
      {tab === "gallery" && (
        <div className="space-y-1.5 max-h-[420px] overflow-y-auto rounded-xl">
          {galleryQuery.isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading gallery…</span>
            </div>
          )}

          {galleryQuery.data && galleryQuery.data.assets.length === 0 && (
            <div className="text-center py-8">
              <Disc3 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No audio assets in gallery</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Generate or upload audio in the Gallery first
              </p>
            </div>
          )}

          {galleryQuery.data?.assets.map((asset) => {
            const isSelected = selected?.id === asset.id;
            const audioUrl = galleryFileUrl(asset.filename);
            return (
              <div
                key={asset.id}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-colors cursor-pointer ${
                  isSelected
                    ? "border-primary/50 bg-primary/5"
                    : "border-transparent hover:bg-muted/50"
                }`}
                onClick={() => {
                  if (selected?.id === asset.id) {
                    onSelect(null);
                  } else {
                    onSelect({
                      id: asset.id,
                      name: asset.filename,
                      source: "gallery",
                      type: "music",
                      filePath: asset.file_path,
                      duration: asset.duration_seconds ?? undefined,
                      previewUrl: audioUrl,
                      license: "Gallery",
                    });
                  }
                }}
              >
                {/* Play/Pause */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay(asset.id, audioUrl);
                  }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-primary/20 transition-colors"
                >
                  {playing === asset.id ? (
                    <Pause className="h-3.5 w-3.5 text-foreground" />
                  ) : (
                    <Play className="h-3.5 w-3.5 text-foreground ml-0.5" />
                  )}
                </button>

                {playing === asset.id && (
                  <audio
                    src={audioUrl}
                    autoPlay
                    onEnded={() => setPlaying(null)}
                    className="hidden"
                  />
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-foreground truncate block">{asset.filename}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {formatDuration(asset.duration_seconds ?? undefined)}
                    </span>
                    <span className="text-xs text-muted-foreground/40">•</span>
                    <span className="text-xs text-muted-foreground capitalize">{asset.source}</span>
                    {asset.tags?.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
                      >
                        <Tag className="h-2.5 w-2.5" />
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {isSelected ? (
                  <Check className="h-4 w-4 text-primary shrink-0" />
                ) : (
                  <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Upload Tab */}
      {tab === "upload" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
              Upload Local File
            </div>

            <div className="space-y-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={browserUploadMutation.isPending}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-background py-2.5 text-sm font-medium text-foreground hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {browserUploadMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="h-4 w-4" />
                )}
                Choose Audio File
              </button>
              <p className="text-[11px] text-muted-foreground/60 text-center">
                Select a local audio file directly from a file chooser
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.aac,.m4a,.ogg,.flac"
                onChange={handleFilePicked}
                className="hidden"
              />
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or paste a path
              <span className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">File Path</label>
              <input
                type="text"
                value={uploadPath}
                onChange={(e) => setUploadPath(e.target.value)}
                placeholder="/path/to/your/audio-file.mp3"
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-[11px] text-muted-foreground/60">
                Absolute path or ~/ path to a local audio file
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Name (optional)</label>
                <input
                  type="text"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder="Auto-detected from filename"
                  className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Type</label>
                <select
                  value={uploadType}
                  onChange={(e) => setUploadType(e.target.value as typeof uploadType)}
                  className="w-full rounded-xl border border-border bg-background text-sm text-foreground px-3 py-2.5"
                >
                  <option value="music">Music</option>
                  <option value="sfx">Sound Effect</option>
                  <option value="voiceover">Voiceover</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleUpload}
              disabled={!uploadPath.trim() || uploadMutation.isPending}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground py-2.5 text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploadMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Upload to Library
            </button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Files are copied into the managed asset library for use in productions.
          </p>
        </div>
      )}
    </div>
  );
};
