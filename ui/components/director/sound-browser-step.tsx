"use client";

import { useState } from "react";
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
} from "lucide-react";
import type { SelectedAsset } from "./types";

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

  const downloadMutation = useMutation({
    mutationFn: (asset: AssetResult) =>
      fetchJson("/api/admin/director/assets/download", {
        method: "POST",
        body: JSON.stringify({
          id: asset.id,
          name: asset.name,
          source: asset.source,
          previewUrl: asset.previewUrl,
          attribution: asset.attribution,
        }),
      }),
    onSuccess: () => showToast("Asset downloaded to library", "success"),
    onError: () => showToast("Download failed", "error"),
  });

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

  const selectAsset = (asset: AssetResult) => {
    if (selected?.id === asset.id) {
      onSelect(null);
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
          Pixabay, or Jamendo. This step is optional — skip if you don&apos;t want music.
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
          return (
            <div
              key={asset.id}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-colors cursor-pointer ${
                isSelected
                  ? "border-primary/50 bg-primary/5"
                  : "border-transparent hover:bg-muted/50"
              }`}
              onClick={() => selectAsset(asset)}
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

              {/* Select indicator or Download */}
              {isSelected ? (
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
    </div>
  );
};
