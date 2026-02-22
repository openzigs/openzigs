"use client";

import { useState } from "react";
import { Globe, Loader2, ExternalLink, Clapperboard } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { useRouter } from "next/navigation";

interface BlogToVideoResponse {
  draftId: string;
  manifest: {
    projectTitle: string;
    timeline: unknown[];
  };
  blog: {
    title: string;
    description: string;
    wordCount: number;
    imageCount: number;
    resolvedUrl: string;
  };
  storyboard: {
    title: string;
    styleAnchor: string;
    sceneCount: number;
    analysis: { tone: string; audience: string; coreThemes: string[] };
  };
  processingTimeMs: number;
}

type TemplateId = "Minimalist" | "ContentCreator" | "Corporate" | "TechDemo";
type ImageProvider = "auto" | "local" | "cloud";

export const BlogToVideoPanel = () => {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [template, setTemplate] = useState<TemplateId>("Minimalist");
  const [styleHint, setStyleHint] = useState("");
  const [imageProvider, setImageProvider] = useState<ImageProvider>("auto");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BlogToVideoResponse | null>(null);

  const isValidUrl = (() => {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  })();

  const handleConvert = async () => {
    if (!isValidUrl) return;

    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetchJson<BlogToVideoResponse>("/api/admin/director/blog-to-video", {
        method: "POST",
        body: JSON.stringify({
          url,
          template,
          styleHint: styleHint || undefined,
          imageProvider,
        }),
      });
      setResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Globe className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold text-foreground">Blog to YouTube</h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Paste a blog post URL and convert it into a narrated video with AI-generated
          visuals, voiceover, and transitions — saved as a draft for editing in Studio.
        </p>
      </div>

      {/* URL Input */}
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <label htmlFor="blog-url" className="block text-sm font-medium text-foreground mb-1.5">
            Blog Post URL
          </label>
          <input
            id="blog-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/blog/my-article"
            className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            disabled={isProcessing}
          />
          {url && !isValidUrl && (
            <p className="mt-1 text-xs text-destructive">Enter a valid http or https URL</p>
          )}
        </div>

        {/* Options Row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="blog-template" className="block text-xs font-medium text-muted-foreground mb-1">
              Template
            </label>
            <select
              id="blog-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value as TemplateId)}
              disabled={isProcessing}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="Minimalist">Minimalist</option>
              <option value="ContentCreator">Content Creator</option>
              <option value="Corporate">Corporate</option>
              <option value="TechDemo">Tech Demo</option>
            </select>
          </div>

          <div>
            <label htmlFor="blog-style" className="block text-xs font-medium text-muted-foreground mb-1">
              Style Hint (optional)
            </label>
            <input
              id="blog-style"
              type="text"
              value={styleHint}
              onChange={(e) => setStyleHint(e.target.value)}
              placeholder="e.g. corporate, playful"
              disabled={isProcessing}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="blog-img-provider" className="block text-xs font-medium text-muted-foreground mb-1">
              Image Provider
            </label>
            <select
              id="blog-img-provider"
              value={imageProvider}
              onChange={(e) => setImageProvider(e.target.value as ImageProvider)}
              disabled={isProcessing}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="auto">Auto (failover)</option>
              <option value="local">Local Sidecar</option>
              <option value="cloud">Cloud (Vertex AI)</option>
            </select>
          </div>
        </div>

        {/* Convert Button */}
        <button
          onClick={handleConvert}
          disabled={!isValidUrl || isProcessing}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Converting… this may take several minutes
            </>
          ) : (
            <>
              <Clapperboard className="h-4 w-4" />
              Convert to Video Draft
            </>
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">{result.storyboard.title}</h3>
              <span className="text-xs text-muted-foreground">
                {(result.processingTimeMs / 1000).toFixed(1)}s
              </span>
            </div>

            {/* Blog metadata */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Source:</span>{" "}
                <a
                  href={result.blog.resolvedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {result.blog.title.slice(0, 40)}{result.blog.title.length > 40 ? "…" : ""}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div>
                <span className="text-muted-foreground">Words:</span>{" "}
                <span className="text-foreground">{result.blog.wordCount.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Scenes:</span>{" "}
                <span className="text-foreground">{result.storyboard.sceneCount}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Tone:</span>{" "}
                <span className="text-foreground capitalize">{result.storyboard.analysis.tone}</span>
              </div>
            </div>

            {/* Themes */}
            {result.storyboard.analysis.coreThemes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {result.storyboard.analysis.coreThemes.map((theme) => (
                  <span
                    key={theme}
                    className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                  >
                    {theme}
                  </span>
                ))}
              </div>
            )}

            {/* Open in Studio */}
            <button
              onClick={() => router.push(`/director/studio/${result.draftId}`)}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-primary bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Clapperboard className="h-4 w-4" />
              Open in Studio
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
