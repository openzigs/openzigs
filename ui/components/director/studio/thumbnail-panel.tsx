"use client";

import { useState, useCallback } from "react";
import { ImageIcon, Loader2, RefreshCw, Download, Sparkles, Wand2, ArrowLeft } from "lucide-react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { showToast } from "@/components/toast";

type ClickbaitOverlay = "none" | "arrows" | "circles" | "emoji" | "badge";
type Step = "pick-frame" | "customize" | "final";

interface ThumbnailResult {
  thumbnailUrl: string;
  suggestedText: string[];
  selectedFrame: {
    timestamp: number;
    rationale: string;
  };
  mode: string;
  rawFrameUrl?: string;
}

const OVERLAY_OPTIONS: { value: ClickbaitOverlay; label: string; icon: string }[] = [
  { value: "none", label: "None", icon: "—" },
  { value: "arrows", label: "Arrows", icon: "➤" },
  { value: "circles", label: "Circles", icon: "⭕" },
  { value: "emoji", label: "Emoji", icon: "🔥" },
  { value: "badge", label: "Badge", icon: "🏷" },
];

interface ThumbnailPanelProps {
  draftId: string;
}

export function ThumbnailPanel({ draftId }: ThumbnailPanelProps) {
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ThumbnailResult | null>(null);
  const [open, setOpen] = useState(false);
  const [textOverride, setTextOverride] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [overlay, setOverlay] = useState<ClickbaitOverlay>("none");
  const [step, setStep] = useState<Step>("pick-frame");
  const [rawFrameUrl, setRawFrameUrl] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");

  // Step 1: Pick the most clickable frame (fast, no enhancement)
  const handlePickFrame = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetchJson<ThumbnailResult>(
        `/api/admin/director/drafts/${draftId}/thumbnail`,
        { method: "POST", body: JSON.stringify({ mode: "frame-select" }) },
      );
      setRawFrameUrl(res.rawFrameUrl ?? res.thumbnailUrl);
      setTextOverride(res.suggestedText);
      setRationale(res.selectedFrame.rationale);
      setResult(res);
      setStep("customize");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to pick frame", "error");
    } finally {
      setGenerating(false);
    }
  }, [draftId]);

  // Step 2 actions: enhance frame, generate new, or use as-is
  const handleEnhanceFrame = useCallback(async () => {
    if (!prompt.trim()) {
      showToast("Enter a prompt describing how to modify the image", "error");
      return;
    }
    setGenerating(true);
    try {
      const body: Record<string, unknown> = {
        mode: "flux-enhance",
        prompt: prompt.trim(),
        clickbaitOverlay: overlay,
        baseFrameUrl: rawFrameUrl,
      };
      if (editing && textOverride.length > 0) body.textOverride = textOverride;
      const res = await fetchJson<ThumbnailResult>(
        `/api/admin/director/drafts/${draftId}/thumbnail`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult(res);
      setTextOverride(res.suggestedText);
      setStep("final");
      showToast("Thumbnail enhanced!", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setGenerating(false);
    }
  }, [draftId, prompt, overlay, rawFrameUrl, editing, textOverride]);

  const handleGenerateNew = useCallback(async () => {
    setGenerating(true);
    try {
      const body: Record<string, unknown> = {
        mode: "flux-generate",
        clickbaitOverlay: overlay,
      };
      if (prompt.trim()) body.prompt = prompt.trim();
      if (editing && textOverride.length > 0) body.textOverride = textOverride;
      const res = await fetchJson<ThumbnailResult>(
        `/api/admin/director/drafts/${draftId}/thumbnail`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult(res);
      setTextOverride(res.suggestedText);
      setStep("final");
      showToast("New thumbnail generated!", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Generation failed", "error");
    } finally {
      setGenerating(false);
    }
  }, [draftId, prompt, overlay, editing, textOverride]);

  const handleUseAsIs = useCallback(async () => {
    setGenerating(true);
    try {
      const body: Record<string, unknown> = {
        mode: "frame-select",
        clickbaitOverlay: overlay,
        baseFrameUrl: rawFrameUrl,
      };
      if (editing && textOverride.length > 0) body.textOverride = textOverride;
      const res = await fetchJson<ThumbnailResult>(
        `/api/admin/director/drafts/${draftId}/thumbnail`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult(res);
      setStep("final");
      showToast("Thumbnail created!", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setGenerating(false);
    }
  }, [draftId, overlay, rawFrameUrl, editing, textOverride]);

  const handleStartOver = useCallback(() => {
    setStep("pick-frame");
    setResult(null);
    setRawFrameUrl(null);
    setPrompt("");
    setOverlay("none");
    setEditing(false);
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition"
        title="AI Thumbnail"
      >
        <ImageIcon className="h-3.5 w-3.5" />
        Thumbnail
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              {step !== "pick-frame" && (
                <button
                  onClick={() => step === "final" ? setStep("customize") : handleStartOver()}
                  className="text-muted-foreground hover:text-foreground transition"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
              )}
              <span className="text-xs font-medium text-foreground">
                {step === "pick-frame" ? "AI Thumbnail" : step === "customize" ? "Customize Thumbnail" : "Thumbnail Ready"}
              </span>
            </div>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              {step === "pick-frame" ? "1/3" : step === "customize" ? "2/3" : "3/3"}
            </span>
          </div>

          <div className="p-3 space-y-3">

            {/* ── Step 1: Pick best frame ── */}
            {step === "pick-frame" && (
              <div className="text-center space-y-2">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                  <ImageIcon className="h-7 w-7 text-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  AI will analyze your scenes and pick the most clickable frame as a starting point.
                </p>
                <button
                  onClick={handlePickFrame}
                  disabled={generating}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {generating ? "Analyzing scenes…" : "Find Best Frame"}
                </button>
              </div>
            )}

            {/* ── Step 2: Customize — show frame, prompt, actions ── */}
            {step === "customize" && rawFrameUrl && (
              <>
                {/* Show the selected raw frame */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground">Most Clickable Frame</p>
                  <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted">
                    <img
                      src={buildMediaUrl(rawFrameUrl)}
                      alt="Selected frame"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground italic">{rationale}</p>
                </div>

                {/* Prompt for modification */}
                <div>
                  <p className="mb-1 text-[10px] font-medium text-muted-foreground">
                    Modify with Flux <span className="text-[9px] font-normal">(optional)</span>
                  </p>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. &quot;add a woman in a bikini next to the car&quot;, &quot;make it more dramatic with fire&quot;, &quot;add neon lights&quot;…"
                    rows={2}
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                {/* Overlay + text edits */}
                <div>
                  <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Clickbait Overlay</p>
                  <div className="flex gap-1">
                    {OVERLAY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setOverlay(opt.value)}
                        title={opt.label}
                        className={`flex flex-1 flex-col items-center rounded-md border px-1 py-1 text-center transition ${
                          overlay === opt.value
                            ? "border-primary bg-primary/10"
                            : "border-border bg-background hover:bg-muted"
                        }`}
                      >
                        <span className="text-sm">{opt.icon}</span>
                        <span className="text-[8px] text-muted-foreground">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Suggested text lines */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-muted-foreground">Overlay Text</span>
                    <button
                      onClick={() => setEditing(!editing)}
                      className="text-[10px] text-primary hover:underline"
                    >
                      {editing ? "Done" : "Edit"}
                    </button>
                  </div>
                  {editing ? (
                    <div className="space-y-1">
                      {textOverride.map((line, i) => (
                        <input
                          key={i}
                          type="text"
                          value={line}
                          onChange={(e) => {
                            const updated = [...textOverride];
                            updated[i] = e.target.value;
                            setTextOverride(updated);
                          }}
                          className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                          maxLength={30}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {textOverride.map((t, i) => (
                        <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="space-y-1.5">
                  {prompt.trim() && (
                    <button
                      onClick={handleEnhanceFrame}
                      disabled={generating}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
                    >
                      {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                      {generating ? "Editing…" : "Edit Frame with Kontext"}
                    </button>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleUseAsIs}
                      disabled={generating}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
                    >
                      {generating && !prompt.trim() ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImageIcon className="h-3 w-3" />}
                      Use As-Is
                    </button>
                    <button
                      onClick={handleGenerateNew}
                      disabled={generating}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted transition disabled:opacity-50"
                    >
                      {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      New Image
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* ── Step 3: Final result ── */}
            {step === "final" && result && (
              <div className="space-y-2">
                <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted">
                  <img
                    src={buildMediaUrl(result.thumbnailUrl)}
                    alt="Generated thumbnail"
                    className="h-full w-full object-cover"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground italic">
                  {result.selectedFrame.rationale}
                </p>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setStep("customize")}
                    disabled={generating}
                    className="flex flex-1 items-center justify-center gap-1 rounded bg-muted px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted/80 transition disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Tweak
                  </button>
                  <a
                    href={buildMediaUrl(result.thumbnailUrl)}
                    download
                    className="flex flex-1 items-center justify-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition"
                  >
                    <Download className="h-3 w-3" />
                    Download
                  </a>
                </div>
                <button
                  onClick={handleStartOver}
                  className="w-full text-center text-[10px] text-muted-foreground hover:text-foreground transition"
                >
                  Start over with a different frame
                </button>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
