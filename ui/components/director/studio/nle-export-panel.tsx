"use client";

import { useState, useCallback } from "react";
import { FileDown, Loader2, Film, FileText } from "lucide-react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  NleTrackSelector,
  NleDownloadButton,
  type ExportTrack,
} from "./nle-track-selector";

interface NLEExportPanelProps {
  draftId: string;
  manifest: Record<string, unknown>;
  title?: string;
}

type ExportFormat = "fcpxml" | "edl";

const FORMAT_INFO: Record<
  ExportFormat,
  { label: string; description: string; icon: React.ReactNode }
> = {
  fcpxml: {
    label: "FCP XML",
    description: "For Premiere Pro, DaVinci Resolve, Final Cut Pro",
    icon: <Film className="h-4 w-4" />,
  },
  edl: {
    label: "EDL",
    description: "CMX3600 — Universal NLE compatibility",
    icon: <FileText className="h-4 w-4" />,
  },
};

export function NLEExportPanel({
  draftId: _draftId,
  manifest,
  title,
}: NLEExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>("fcpxml");
  const [loading, setLoading] = useState(false);
  const [tracks, setTracks] = useState<Set<ExportTrack>>(
    () => new Set<ExportTrack>(["video", "audio", "captions", "broll"]),
  );
  const [exportResult, setExportResult] = useState<{
    outputPath: string;
    clips: number;
    transitions: number;
  } | null>(null);

  const handleExport = useCallback(async () => {
    setLoading(true);
    setExportResult(null);
    try {
      const res = await fetchJson<{
        status: string;
        outputPath: string;
        clips: number;
        transitions: number;
      }>("/api/studio/pipeline/export", {
        method: "POST",
        body: JSON.stringify({
          manifest,
          format,
          title,
          tracks: Array.from(tracks),
        }),
      });

      setExportResult({
        outputPath: res.outputPath,
        clips: res.clips,
        transitions: res.transitions,
      });
      showToast(`Exported as ${format.toUpperCase()}`, "success");
    } catch (err) {
      showToast(
        `Export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [manifest, format, title, tracks]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FileDown className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">NLE Export</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => (
          <button
            key={f}
            onClick={() => setFormat(f)}
            className={`rounded-lg border p-2.5 text-left transition-colors ${
              format === f
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50"
            }`}
          >
            <div className="flex items-center gap-2">
              {FORMAT_INFO[f].icon}
              <span className="text-sm font-medium">
                {FORMAT_INFO[f].label}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {FORMAT_INFO[f].description}
            </p>
          </button>
        ))}
      </div>

      {/* Track selector (#837 wiring) */}
      <NleTrackSelector value={tracks} onChange={setTracks} />

      <button
        onClick={handleExport}
        disabled={loading || tracks.size === 0}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Exporting...
          </>
        ) : (
          <>
            <FileDown className="h-3.5 w-3.5" />
            Export {FORMAT_INFO[format].label}
          </>
        )}
      </button>

      {exportResult && (
        <div className="rounded-lg border border-border bg-green-500/5 p-2.5">
          <p className="text-sm font-medium text-green-600">Export Complete</p>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <p>{exportResult.clips} video clips</p>
            <p>{exportResult.transitions} transitions</p>
            <p className="truncate font-mono">{exportResult.outputPath}</p>
          </div>
          <div className="mt-2">
            <NleDownloadButton
              url={buildMediaUrl(exportResult.outputPath)}
              filename={`${title ?? "timeline"}.${format}`}
              label={`Download .${format}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
