"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Music, Search, Download, Play, Pause, Library, Globe, Tag } from "lucide-react";

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
};

export const SoundBrowserPanel = () => {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "local" | "pixabay" | "jamendo">("all");
  const [type, setType] = useState<"" | "music" | "sfx">("");
  const [playing, setPlaying] = useState<string | null>(null);

  const searchQuery = useQuery({
    queryKey: ["sound-search", query, source, type],
    queryFn: () =>
      fetchJson<AssetResult[]>("/api/admin/director/assets/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          source,
          type: type || undefined,
          maxResults: 20,
        }),
      }),
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const downloadMutation = useMutation({
    mutationFn: (asset: AssetResult) =>
      fetchJson("/api/admin/director/assets/download", {
        method: "POST",
        body: JSON.stringify({ previewUrl: asset.previewUrl, name: asset.name, attribution: asset.attribution }),
      }),
    onSuccess: () => showToast("Asset downloaded to library", "success"),
    onError: () => showToast("Download failed", "error"),
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
  };

  const togglePlay = (id: string, previewUrl?: string) => {
    if (!previewUrl) return;
    if (playing === id) {
      setPlaying(null);
      // Stop any playing audio
      document.querySelectorAll("audio").forEach((a) => a.pause());
    } else {
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
      case "local": return <Library className="w-3 h-3" />;
      case "pixabay":
      case "jamendo":
      case "pexels": return <Globe className="w-3 h-3" />;
      default: return <Music className="w-3 h-3" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Music className="w-5 h-5 text-purple-400" />
        <h2 className="text-lg font-semibold text-zinc-100">Sound Browser</h2>
        <span className="text-xs text-zinc-500 ml-auto">Director Mode</span>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search music & sound effects..."
            className="w-full pl-10 pr-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500"
          />
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
          className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-300 px-2"
        >
          <option value="all">All Sources</option>
          <option value="local">Local Library</option>
          <option value="pixabay">Pixabay</option>
          <option value="jamendo">Jamendo</option>
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-300 px-2"
        >
          <option value="">All Types</option>
          <option value="music">Music</option>
          <option value="sfx">SFX</option>
        </select>
      </form>

      {/* Results */}
      <div className="space-y-1">
        {searchQuery.isLoading && (
          <p className="text-zinc-500 text-sm py-4 text-center">Searching...</p>
        )}

        {searchQuery.data && searchQuery.data.length === 0 && (
          <p className="text-zinc-500 text-sm py-4 text-center">No results found</p>
        )}

        {searchQuery.data?.map((asset) => (
          <div
            key={asset.id}
            className="flex items-center gap-3 px-3 py-2 bg-zinc-800/50 rounded-md hover:bg-zinc-700/50 transition-colors"
          >
            {/* Play/Pause */}
            <button
              onClick={() => togglePlay(asset.id, asset.previewUrl)}
              disabled={!asset.previewUrl}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-zinc-700 hover:bg-purple-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {playing === asset.id ? (
                <Pause className="w-3.5 h-3.5 text-white" />
              ) : (
                <Play className="w-3.5 h-3.5 text-white ml-0.5" />
              )}
            </button>

            {/* Hidden audio element */}
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
                <span className="text-sm text-zinc-100 truncate">{asset.name}</span>
                <span className="flex items-center gap-1 text-xs text-zinc-500">
                  {sourceIcon(asset.source)}
                  {asset.source}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-zinc-500">{formatDuration(asset.duration)}</span>
                <span className="text-xs text-zinc-600">•</span>
                <span className="text-xs text-zinc-500">{asset.license}</span>
                {asset.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-0.5 text-xs text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">
                    <Tag className="w-2.5 h-2.5" />
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {/* Download button (for remote assets) */}
            {asset.source !== "local" && asset.previewUrl && (
              <button
                onClick={() => downloadMutation.mutate(asset)}
                disabled={downloadMutation.isPending}
                className="p-2 rounded-md hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30"
                title="Download to local library"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Empty state */}
      {!query && (
        <div className="text-center py-8">
          <Music className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
          <p className="text-zinc-500 text-sm">Search for royalty-free music and sound effects</p>
          <p className="text-zinc-600 text-xs mt-1">
            Sources: Local Library • Pixabay • Jamendo
          </p>
        </div>
      )}
    </div>
  );
};
