"use client";

import { useState, useEffect, useCallback } from "react";
import { Tag, X, Loader2 } from "lucide-react";
import { fetchJson } from "@/lib/api";

interface TagInfo {
  tag: string;
  count: number;
}

interface TagFilterProps {
  activeTags: string[];
  onTagsChange: (tags: string[]) => void;
}

export function TagFilter({ activeTags, onTagsChange }: TagFilterProps) {
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchJson<{ tags: TagInfo[] }>("/api/admin/director/gallery/tags");
      setAllTags(res.tags);
    } catch {
      // silently fail — tags may not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleTag = (tag: string) => {
    if (activeTags.includes(tag)) {
      onTagsChange(activeTags.filter((t) => t !== tag));
    } else {
      onTagsChange([...activeTags, tag]);
    }
  };

  const clearAll = () => onTagsChange([]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading tags…
      </div>
    );
  }

  if (allTags.length === 0) return null;

  const visibleTags = expanded ? allTags : allTags.slice(0, 10);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Tags</span>
        {activeTags.length > 0 && (
          <button onClick={clearAll} className="text-xs text-primary hover:underline">
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleTags.map((t) => (
          <button
            key={t.tag}
            onClick={() => toggleTag(t.tag)}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition ${
              activeTags.includes(t.tag)
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {t.tag}
            <span className="opacity-60">({t.count})</span>
            {activeTags.includes(t.tag) && <X className="h-2.5 w-2.5" />}
          </button>
        ))}
        {allTags.length > 10 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? "Show less" : `+${allTags.length - 10} more`}
          </button>
        )}
      </div>
    </div>
  );
}
