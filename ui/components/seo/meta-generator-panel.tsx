"use client";

import { useState } from "react";
import { SerpPreview } from "./serp-preview";

interface MetaVariant {
  text: string;
  charCount: number;
  pixelWidthEstimate: number;
}

interface MetaSuggestions {
  titles: MetaVariant[];
  descriptions: MetaVariant[];
  keyword: string;
  sourceUrl?: string;
}

/**
 * Meta Generator panel (#878).
 *
 * Uses the backend AI meta-generator tool to produce title and description
 * variants, displays them with SERP previews.
 */
export function MetaGeneratorPanel() {
  const [keyword, setKeyword] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<MetaSuggestions | null>(null);
  const [error, setError] = useState("");

  const generate = async () => {
    if (!keyword.trim()) return;
    setLoading(true);
    setError("");
    setSuggestions(null);
    try {
      // Call the backend tool endpoint via chat — or we use the admin API
      // For now, use the MCP tool directly via the chat endpoint with tool mode
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE}/api/admin/tools/seo-meta-generator/invoke`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.NEXT_PUBLIC_OPENZIGS_TOKEN
              ? {
                  Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN}`,
                }
              : {}),
          },
          body: JSON.stringify({
            keyword,
            url: url || undefined,
            content: content || undefined,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data = await res.json();
      // The tool returns { text: JSON.stringify(MetaSuggestions) }
      const parsed: MetaSuggestions = JSON.parse(
        data.text || data.result?.text || "{}",
      );
      setSuggestions(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block">
            Target Keyword <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="e.g. best SEO tools 2026"
            className="w-full rounded-md border border-input px-3 py-1.5 text-sm bg-background"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block">
            Page URL (optional)
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/page"
            className="w-full rounded-md border border-input px-3 py-1.5 text-sm bg-background"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block">
            Content Excerpt (optional)
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="Paste a content excerpt for better context…"
            className="w-full rounded-md border border-input px-3 py-2 text-sm bg-background resize-none"
          />
        </div>
        <button
          onClick={generate}
          disabled={loading || !keyword.trim()}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Generating with AI…" : "Generate Meta Tags"}
        </button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {suggestions && (
        <div className="space-y-6">
          {/* Title variants */}
          <div>
            <h4 className="text-sm font-semibold mb-2">
              Title Variants ({suggestions.titles.length})
            </h4>
            <div className="grid gap-2">
              {suggestions.titles.map((t, i) => (
                <div
                  key={i}
                  className="rounded-lg border bg-card p-3 flex items-start justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{t.text}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {t.charCount} chars · ~{t.pixelWidthEstimate}px
                      {t.charCount > 60 && (
                        <span className="ml-1 text-yellow-600">
                          ⚠ May be truncated
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(t.text)}
                    className="text-[10px] px-2 py-1 rounded border bg-background hover:bg-muted shrink-0"
                  >
                    Copy
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Description variants */}
          <div>
            <h4 className="text-sm font-semibold mb-2">
              Description Variants ({suggestions.descriptions.length})
            </h4>
            <div className="grid gap-2">
              {suggestions.descriptions.map((d, i) => (
                <div
                  key={i}
                  className="rounded-lg border bg-card p-3 flex items-start justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{d.text}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {d.charCount} chars · ~{d.pixelWidthEstimate}px
                      {d.charCount > 160 && (
                        <span className="ml-1 text-yellow-600">
                          ⚠ May be truncated
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(d.text)}
                    className="text-[10px] px-2 py-1 rounded border bg-background hover:bg-muted shrink-0"
                  >
                    Copy
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* SERP Preview for best combo */}
          {suggestions.titles.length > 0 &&
            suggestions.descriptions.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">
                  SERP Preview (Best Combo)
                </h4>
                <div className="rounded-lg border bg-card p-4">
                  <SerpPreview
                    title={suggestions.titles[0].text}
                    description={suggestions.descriptions[0].text}
                    url={suggestions.sourceUrl}
                    showTruncation
                  />
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
