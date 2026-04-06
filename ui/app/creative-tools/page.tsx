"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import {
  QrCode,
  MessageSquareText,
  Hash,
  Copy,
  Download,
  Loader2,
  Send,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────

interface CaptionResult {
  platform: string;
  caption: string;
  charCount: number;
  maxChars: number;
  withinLimit: boolean;
}

interface HashtagResult {
  platform: string;
  hashtags: Array<{ tag: string; category: string }>;
  count: number;
}

interface QrResult {
  success: boolean;
  format: string;
  outputPath: string;
  content: string;
  width?: number;
  sizeBytes?: number;
}

type TabKey = "qr" | "caption" | "hashtag";

const PLATFORMS = [
  "twitter",
  "instagram",
  "linkedin",
  "facebook",
  "pinterest",
  "youtube",
] as const;

const TONES = [
  "professional",
  "casual",
  "humorous",
  "inspirational",
  "educational",
  "promotional",
] as const;

// ── Page ──────────────────────────────────────────────────────

export default function CreativeToolsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("qr");

  // QR state
  const [qrContent, setQrContent] = useState("");
  const [qrFormat, setQrFormat] = useState<"png" | "svg">("png");
  const [qrWidth, setQrWidth] = useState(400);
  const [qrColorDark, setQrColorDark] = useState("#000000");
  const [qrColorLight, setQrColorLight] = useState("#ffffff");
  const [qrErrorCorrection, setQrErrorCorrection] = useState<"L" | "M" | "Q" | "H">("M");
  const [qrResult, setQrResult] = useState<QrResult | null>(null);

  // Caption state
  const [captionTopic, setCaptionTopic] = useState("");
  const [captionPlatform, setCaptionPlatform] = useState("instagram");
  const [captionTone, setCaptionTone] = useState("casual");
  const [captionCta, setCaptionCta] = useState(false);
  const [captionEmoji, setCaptionEmoji] = useState(true);
  const [captionContext, setCaptionContext] = useState("");
  const [captionResult, setCaptionResult] = useState<CaptionResult | null>(null);

  // Hashtag state
  const [hashtagTopic, setHashtagTopic] = useState("");
  const [hashtagPlatform, setHashtagPlatform] = useState("instagram");
  const [hashtagCount, setHashtagCount] = useState(10);
  const [hashtagNiche, setHashtagNiche] = useState("medium");
  const [hashtagTrending, setHashtagTrending] = useState(true);
  const [hashtagResult, setHashtagResult] = useState<HashtagResult | null>(null);

  // Mutations
  const qrMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson<QrResult>("/api/admin/creative/qr-code", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setQrResult(data);
      showToast("QR code generated and saved to gallery", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const captionMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson<CaptionResult>("/api/admin/creative/caption", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setCaptionResult(data);
      showToast("Caption generated", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const hashtagMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetchJson<HashtagResult>("/api/admin/creative/hashtags", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setHashtagResult(data);
      showToast("Hashtags generated", "success");
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const tabs: { key: TabKey; label: string; icon: typeof QrCode }[] = [
    { key: "qr", label: "QR Code", icon: QrCode },
    { key: "caption", label: "Caption", icon: MessageSquareText },
    { key: "hashtag", label: "Hashtags", icon: Hash },
  ];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <ToastContainer />

      <SectionCard title={<span>Creative Tools <span className="text-sm font-normal text-muted-foreground">— QR codes, captions, and hashtags</span></span>}>
        {/* Tab bar */}
        <div className="mb-6 flex gap-2 border-b border-border pb-3">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {/* ── QR Code Tab ─────────────────────────────────── */}
        {activeTab === "qr" && (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Content</label>
                <textarea
                  value={qrContent}
                  onChange={(e) => setQrContent(e.target.value)}
                  placeholder="https://example.com or any text..."
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Format</label>
                  <div className="flex gap-2">
                    {(["png", "svg"] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setQrFormat(f)}
                        className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold uppercase transition ${
                          qrFormat === f
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-muted text-muted-foreground"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Width: {qrWidth}px
                  </label>
                  <input
                    type="range"
                    min={100}
                    max={2000}
                    value={qrWidth}
                    onChange={(e) => setQrWidth(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Dark Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={qrColorDark}
                      onChange={(e) => setQrColorDark(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded border border-border"
                    />
                    <span className="text-xs text-muted-foreground">{qrColorDark}</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Light Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={qrColorLight}
                      onChange={(e) => setQrColorLight(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded border border-border"
                    />
                    <span className="text-xs text-muted-foreground">{qrColorLight}</span>
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Error Correction</label>
                <div className="flex gap-1.5">
                  {(["L", "M", "Q", "H"] as const).map((ec) => (
                    <button
                      key={ec}
                      onClick={() => setQrErrorCorrection(ec)}
                      className={`flex-1 rounded py-1 text-xs font-medium transition ${
                        qrErrorCorrection === ec
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {ec} ({ec === "L" ? "7%" : ec === "M" ? "15%" : ec === "Q" ? "25%" : "30%"})
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => {
                  if (!qrContent.trim()) {
                    showToast("Please enter content for the QR code", "error");
                    return;
                  }
                  qrMutation.mutate({
                    content: qrContent,
                    format: qrFormat,
                    width: qrWidth,
                    color_dark: qrColorDark,
                    color_light: qrColorLight,
                    error_correction: qrErrorCorrection,
                  });
                }}
                disabled={qrMutation.isPending}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {qrMutation.isPending ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Generating...
                  </span>
                ) : (
                  "Generate QR Code"
                )}
              </button>
            </div>
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-6">
              {qrResult ? (
                <div className="space-y-3 text-center">
                  <p className="text-xs text-muted-foreground">
                    {qrResult.format.toUpperCase()} &middot; {qrResult.sizeBytes ? `${(qrResult.sizeBytes / 1024).toFixed(1)} KB` : "Saved"}
                  </p>
                  <p className="text-xs font-medium text-foreground">Saved to Gallery</p>
                  <button
                    onClick={() => copyToClipboard(qrResult.outputPath)}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Copy className="h-3 w-3" /> Copy path
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">QR preview will appear here</p>
              )}
            </div>
          </div>
        )}

        {/* ── Caption Tab ─────────────────────────────────── */}
        {activeTab === "caption" && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">Topic</label>
                  <textarea
                    value={captionTopic}
                    onChange={(e) => setCaptionTopic(e.target.value)}
                    placeholder="Describe your content or product..."
                    rows={3}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Platform</label>
                  <div className="flex flex-wrap gap-1.5">
                    {PLATFORMS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setCaptionPlatform(p)}
                        className={`rounded-lg px-3 py-1 text-xs font-medium capitalize transition ${
                          captionPlatform === p
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Tone</label>
                  <div className="flex flex-wrap gap-1.5">
                    {TONES.map((t) => (
                      <button
                        key={t}
                        onClick={() => setCaptionTone(t)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition ${
                          captionTone === t
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={captionCta}
                      onChange={(e) => setCaptionCta(e.target.checked)}
                      className="rounded"
                    />
                    Call-to-action
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={captionEmoji}
                      onChange={(e) => setCaptionEmoji(e.target.checked)}
                      className="rounded"
                    />
                    Include emojis
                  </label>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Context <span className="text-muted-foreground/60">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={captionContext}
                    onChange={(e) => setCaptionContext(e.target.value)}
                    placeholder="Brand voice, campaign name, audience..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                  />
                </div>
                <button
                  onClick={() => {
                    if (!captionTopic.trim()) {
                      showToast("Please enter a topic", "error");
                      return;
                    }
                    captionMutation.mutate({
                      topic: captionTopic,
                      platform: captionPlatform,
                      tone: captionTone,
                      include_cta: captionCta,
                      include_emoji: captionEmoji,
                      context: captionContext || undefined,
                    });
                  }}
                  disabled={captionMutation.isPending}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {captionMutation.isPending ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Generating...
                    </span>
                  ) : (
                    "Generate Caption"
                  )}
                </button>
              </div>
              <div>
                {captionResult ? (
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium capitalize text-muted-foreground">
                        {captionResult.platform}
                      </span>
                      <span
                        className={`text-xs ${captionResult.withinLimit ? "text-green-500" : "text-red-500"}`}
                      >
                        {captionResult.charCount}/{captionResult.maxChars}
                      </span>
                    </div>
                    <p className="mb-3 whitespace-pre-wrap text-sm">{captionResult.caption}</p>
                    <button
                      onClick={() => copyToClipboard(captionResult.caption)}
                      className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/80"
                    >
                      <Copy className="h-3 w-3" /> Copy Caption
                    </button>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-6">
                    <p className="text-sm text-muted-foreground">Generated caption will appear here</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Hashtag Tab ─────────────────────────────────── */}
        {activeTab === "hashtag" && (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Topic</label>
                <input
                  type="text"
                  value={hashtagTopic}
                  onChange={(e) => setHashtagTopic(e.target.value)}
                  placeholder="e.g., sustainable fashion, AI photography..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Platform</label>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setHashtagPlatform(p)}
                      className={`rounded-lg px-3 py-1 text-xs font-medium capitalize transition ${
                        hashtagPlatform === p
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Count: {hashtagCount}
                </label>
                <input
                  type="range"
                  min={1}
                  max={30}
                  value={hashtagCount}
                  onChange={(e) => setHashtagCount(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Specificity</label>
                <div className="flex gap-2">
                  {(["broad", "medium", "niche"] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => setHashtagNiche(n)}
                      className={`flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition ${
                        hashtagNiche === n
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={hashtagTrending}
                  onChange={(e) => setHashtagTrending(e.target.checked)}
                  className="rounded"
                />
                Include trending hashtags
              </label>
              <button
                onClick={() => {
                  if (!hashtagTopic.trim()) {
                    showToast("Please enter a topic", "error");
                    return;
                  }
                  hashtagMutation.mutate({
                    topic: hashtagTopic,
                    platform: hashtagPlatform,
                    count: hashtagCount,
                    niche_level: hashtagNiche,
                    include_trending: hashtagTrending,
                  });
                }}
                disabled={hashtagMutation.isPending}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {hashtagMutation.isPending ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Generating...
                  </span>
                ) : (
                  "Generate Hashtags"
                )}
              </button>
            </div>
            <div>
              {hashtagResult ? (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium capitalize text-muted-foreground">
                      {hashtagResult.platform} &middot; {hashtagResult.count} tags
                    </span>
                    <button
                      onClick={() =>
                        copyToClipboard(hashtagResult.hashtags.map((h) => h.tag).join(" "))
                      }
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Copy className="h-3 w-3" /> Copy All
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {hashtagResult.hashtags.map((h, i) => (
                      <button
                        key={i}
                        onClick={() => copyToClipboard(h.tag)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition hover:bg-primary hover:text-primary-foreground ${
                          h.category === "broad"
                            ? "border-blue-500/30 bg-blue-500/10 text-blue-600"
                            : h.category === "niche"
                              ? "border-purple-500/30 bg-purple-500/10 text-purple-600"
                              : "border-border bg-muted text-muted-foreground"
                        }`}
                        title={`${h.category} — click to copy`}
                      >
                        {h.tag}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-6">
                  <p className="text-sm text-muted-foreground">Generated hashtags will appear here</p>
                </div>
              )}
            </div>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
