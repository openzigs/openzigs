"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSocket } from "@/lib/socket-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Microscope,
  Loader2,
  AlertCircle,
  Image as ImageIcon,
  Video,
  BellRing,
} from "lucide-react";

export type ResearchParams = {
  topic: string;
  slant: string;
  articleCount: number;
  youtubeCount: number;
  generateImages: boolean;
  generateVideo: boolean;
  notifyTelegram: boolean;
};

type ResearchGenerateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called immediately after the research request is emitted, before the dialog closes. */
  onSubmitted?: () => void;
};

function buildResearchPrompt(params: ResearchParams): string {
  const parts: string[] = [
    `Research and write a comprehensive document about: "${params.topic}".`,
  ];
  if (params.slant) {
    parts.push(`Angle/slant: ${params.slant}.`);
  }
  parts.push(
    `Use ${params.articleCount} web articles and ${params.youtubeCount} YouTube videos as sources (sort YouTube by viewCount for authority).`,
  );
  if (params.generateImages) {
    parts.push("Generate original supporting images using Flux for key sections.");
  }
  if (params.generateVideo) {
    parts.push("Generate a short summary video for the document.");
  }
  if (params.notifyTelegram) {
    parts.push("When the document is saved, send a Telegram notification confirming the title and file path.");
  }
  parts.push(
    "Include inline citations [1], [2], etc. and a bibliography at the end. Save the final document to the Workbench files directory.",
  );
  return parts.join(" ");
}

export const ResearchGenerateDialog = ({
  open,
  onOpenChange,
  onSubmitted,
}: ResearchGenerateDialogProps) => {
  const { socket, connected } = useSocket();
  const [topic, setTopic] = useState("");
  const [slant, setSlant] = useState("");
  const [articleCount, setArticleCount] = useState(5);
  const [youtubeCount, setYoutubeCount] = useState(3);
  const [generateImages, setGenerateImages] = useState(false);
  const [generateVideo, setGenerateVideo] = useState(false);
  const [notifyTelegram, setNotifyTelegram] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = topic.trim().length > 0 && articleCount >= 1 && articleCount <= 20 && youtubeCount >= 0 && youtubeCount <= 20;

  const handleSubmit = useCallback(() => {
    if (!isValid || !socket || !connected) return;

    setError(null);
    setSubmitting(true);

    const prompt = buildResearchPrompt({
      topic: topic.trim(),
      slant: slant.trim(),
      articleCount,
      youtubeCount,
      generateImages,
      generateVideo,
      notifyTelegram,
    });

    try {
      socket.emit("chat:message", {
        content: `[Using Research Synthesizer skill] ${prompt}`,
      });
      onSubmitted?.();
      setSubmitting(false);
      onOpenChange(false);
      // Reset form
      setTopic("");
      setSlant("");
      setArticleCount(5);
      setYoutubeCount(3);
      setGenerateImages(false);
      setGenerateVideo(false);
      setNotifyTelegram(false);
    } catch {
      setError("Failed to send research request. Check connection.");
      setSubmitting(false);
    }
  }, [isValid, socket, connected, topic, slant, articleCount, youtubeCount, generateImages, generateVideo, notifyTelegram, onOpenChange, onSubmitted]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setError(null);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Microscope className="h-5 w-5" />
            Research &amp; Generate
          </DialogTitle>
          <DialogDescription>
            Enter a topic and parameters. The Research Synthesizer will
            autonomously search the web and YouTube, synthesize a document with
            citations, and save it to the Workbench.
          </DialogDescription>
        </DialogHeader>

        {/* Form */}
        <div className="space-y-4">
          {/* Topic */}
          <div>
            <label htmlFor="rg-topic" className="mb-1 block text-xs font-medium text-foreground">
              Topic <span className="text-destructive">*</span>
            </label>
            <input
              id="rg-topic"
              type="text"
              maxLength={200}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Best AI Coding Assistants 2026"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Slant / Angle */}
          <div>
            <label htmlFor="rg-slant" className="mb-1 block text-xs font-medium text-foreground">
              Slant / Angle <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="rg-slant"
              type="text"
              maxLength={200}
              value={slant}
              onChange={(e) => setSlant(e.target.value)}
              placeholder="e.g. developer productivity, cost comparison"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Counts */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="rg-articles" className="mb-1 block text-xs font-medium text-foreground">
                Web Articles (1–20)
              </label>
              <input
                id="rg-articles"
                type="number"
                min={1}
                max={20}
                value={articleCount}
                onChange={(e) => setArticleCount(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label htmlFor="rg-youtube" className="mb-1 block text-xs font-medium text-foreground">
                YouTube Videos (0–20)
              </label>
              <input
                id="rg-youtube"
                type="number"
                min={0}
                max={20}
                value={youtubeCount}
                onChange={(e) => setYoutubeCount(Math.min(20, Math.max(0, Number(e.target.value) || 0)))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={generateImages}
                onChange={(e) => setGenerateImages(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary/50"
              />
              <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
              Generate Images
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={generateVideo}
                onChange={(e) => setGenerateVideo(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary/50"
              />
              <Video className="h-3.5 w-3.5 text-muted-foreground" />
              Generate Video
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={notifyTelegram}
                onChange={(e) => setNotifyTelegram(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary/50"
              />
              <BellRing className="h-3.5 w-3.5 text-muted-foreground" />
              Notify via Telegram
            </label>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <button
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || submitting || !connected}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              isValid && !submitting && connected
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Microscope className="h-3.5 w-3.5" />
                Generate
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
