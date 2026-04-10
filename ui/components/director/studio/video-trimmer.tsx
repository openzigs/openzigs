"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Scissors,
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  Loader2,
  Download,
  SplitSquareHorizontal,
  Check,
  X,
  Trash2,
  Edit3,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { showToast } from "@/components/toast";
import { InlineModelPicker } from "@/components/model-picker-select";

interface SuggestedCut {
  start: number;
  end: number;
  reason: string;
  enabled: boolean;
}

/** A clip segment created by blade splits */
interface ClipSegment {
  id: string;
  name: string;
  start: number;
  end: number;
}

interface VideoTrimmerProps {
  assetId: string;
  videoUrl: string;
  duration: number;
  onTrimComplete?: (newAssetId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type TrimmerMode = "trim" | "blade";

export function VideoTrimmer({
  assetId,
  videoUrl,
  duration,
  onTrimComplete,
  onDirtyChange,
}: VideoTrimmerProps) {
  const { socket } = useSocket();
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // ── Trim Mode State ──
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(duration);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimJobId, setTrimJobId] = useState<string | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [loopPreview, setLoopPreview] = useState(false);

  // ── Mode ──
  const [mode, setMode] = useState<TrimmerMode>("trim");

  // ── Blade Tool State ──
  const [splitPoints, setSplitPoints] = useState<number[]>([]);
  const [segments, setSegments] = useState<ClipSegment[]>([]);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segmentNameInput, setSegmentNameInput] = useState("");

  // ── AI Auto-Cut State ──
  const [analyzing, setAnalyzing] = useState(false);
  const [suggestedCuts, setSuggestedCuts] = useState<SuggestedCut[]>([]);
  const [cutsExpanded, setCutsExpanded] = useState(true);
  const [analyzeModel, setAnalyzeModel] = useState("");

  // Rebuild segments whenever split points change
  useEffect(() => {
    const points = [0, ...splitPoints.sort((a, b) => a - b), duration];
    const newSegments: ClipSegment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const existing = segments.find(
        (s) =>
          Math.abs(s.start - points[i]) < 0.05 &&
          Math.abs(s.end - points[i + 1]) < 0.05,
      );
      newSegments.push({
        id: existing?.id ?? `seg-${Date.now()}-${i}`,
        name: existing?.name ?? `Clip ${i + 1}`,
        start: points[i],
        end: points[i + 1],
      });
    }
    setSegments(newSegments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitPoints, duration]);

  // Notify parent when user has unsaved work (blade splits, AI cuts, or modified trim range)
  useEffect(() => {
    const dirty =
      splitPoints.length > 0 ||
      suggestedCuts.length > 0 ||
      startTime > 0.1 ||
      endTime < duration - 0.1;
    onDirtyChange?.(dirty);
  }, [splitPoints, suggestedCuts, startTime, endTime, duration, onDirtyChange]);

  // Listen for Socket.IO events
  useEffect(() => {
    if (!socket) return;
    const handleTrimComplete = (data: { jobId: string; assetId?: string }) => {
      if (data.jobId === trimJobId) {
        setTrimming(false);
        showToast("Trim complete! New clip saved to Gallery.", "success");
        if (data.assetId) onTrimComplete?.(data.assetId);
      }
    };
    const onTrimFailed = (data: { jobId: string; error: string }) => {
      if (data.jobId === trimJobId) {
        setTrimming(false);
        showToast(`Trim failed: ${data.error}`, "error");
      }
    };
    socket.on("trim:complete", handleTrimComplete);
    socket.on("trim:failed", onTrimFailed);
    return () => {
      socket.off("trim:complete", handleTrimComplete);
      socket.off("trim:failed", onTrimFailed);
    };
  }, [socket, trimJobId, onTrimComplete]);

  // Video time tracking
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (loopPreview && video.currentTime >= endTime) {
        video.currentTime = startTime;
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [loopPreview, startTime, endTime]);

  const handlePlaySelection = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startTime;
    setLoopPreview(true);
    video.play().catch(() => {});
  }, [startTime]);

  const handleTogglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setLoopPreview(false);
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  // ── Trim (single cut export) ──
  const handleTrim = useCallback(async () => {
    if (startTime >= endTime) {
      showToast("Start time must be before end time", "error");
      return;
    }
    setTrimming(true);
    try {
      const res = await fetchJson<{ jobId: string }>("/api/studio/trim", {
        method: "POST",
        body: JSON.stringify({ assetId, startTime, endTime }),
      });
      setTrimJobId(res.jobId);
      showToast("Trim job submitted", "info");
    } catch (err) {
      showToast(
        `Trim failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
      setTrimming(false);
    }
  }, [assetId, startTime, endTime]);

  // ── Blade Split ──
  const handleBladeSplit = useCallback(() => {
    const t = currentTime;
    if (t <= 0.1 || t >= duration - 0.1) return;
    // Don't add duplicate split near existing
    if (splitPoints.some((p) => Math.abs(p - t) < 0.2)) return;
    setSplitPoints((prev) => [...prev, t]);
  }, [currentTime, duration, splitPoints]);

  // ── Keyboard Shortcuts ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key.toLowerCase()) {
        case " ":
          e.preventDefault();
          handleTogglePlay();
          break;
        case "i":
          e.preventDefault();
          setStartTime(currentTime);
          break;
        case "o":
          e.preventDefault();
          setEndTime(currentTime);
          break;
        case "b":
          if (mode === "blade") {
            e.preventDefault();
            handleBladeSplit();
          }
          break;
        case "escape":
          if (mode === "blade") {
            e.preventDefault();
            setMode("trim");
          }
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTime, mode, startTime, endTime, handleTogglePlay, handleBladeSplit]);

  const removeSplitPoint = useCallback((point: number) => {
    setSplitPoints((prev) => prev.filter((p) => Math.abs(p - point) > 0.05));
  }, []);

  // ── Export All Segments ──
  const handleExportAllSegments = useCallback(async () => {
    if (segments.length < 2) {
      showToast("Add split points first using the blade tool", "error");
      return;
    }
    setTrimming(true);
    let successCount = 0;
    try {
      for (const seg of segments) {
        const res = await fetchJson<{ jobId: string }>("/api/studio/trim", {
          method: "POST",
          body: JSON.stringify({
            assetId,
            startTime: seg.start,
            endTime: seg.end,
          }),
        });
        if (res.jobId) successCount++;
      }
      showToast(`${successCount} clip(s) queued for export`, "success");
    } catch (err) {
      showToast(
        `Export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setTrimming(false);
    }
  }, [assetId, segments]);

  const renameSegment = useCallback((segId: string, newName: string) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === segId ? { ...s, name: newName } : s)),
    );
    setEditingSegmentId(null);
  }, []);

  // ── AI Analysis ──
  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setSuggestedCuts([]);
    try {
      const res = await fetchJson<{ jobId: string }>("/api/studio/analyze", {
        method: "POST",
        body: JSON.stringify({ assetId, model: analyzeModel || undefined }),
      });
      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const job = await fetchJson<{
          status: string;
          suggestedCuts?: Array<{ start: number; end: number; reason: string }>;
        }>(`/api/studio/analyze/${res.jobId}`);

        if (job.status === "complete" && job.suggestedCuts) {
          setSuggestedCuts(
            job.suggestedCuts.map((c) => ({ ...c, enabled: true })),
          );
          showToast(
            `AI found ${job.suggestedCuts.length} regions to remove`,
            "success",
          );
          return;
        }
        if (job.status === "failed") throw new Error("Analysis failed");
      }
      throw new Error("Analysis timed out");
    } catch (err) {
      showToast(
        `Analysis failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setAnalyzing(false);
    }
  }, [assetId, analyzeModel]);

  // ── Apply All AI Cuts (export clean video without bad regions) ──
  const enabledCuts = useMemo(
    () => suggestedCuts.filter((c) => c.enabled),
    [suggestedCuts],
  );

  const handleApplyAllCuts = useCallback(async () => {
    if (enabledCuts.length === 0) {
      showToast("No cuts enabled — toggle cuts on to remove them", "error");
      return;
    }
    // Build keep-regions by inverting the removal regions
    const sorted = [...enabledCuts].sort((a, b) => a.start - b.start);
    const keepRegions: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const cut of sorted) {
      if (cut.start > cursor) {
        keepRegions.push({ start: cursor, end: cut.start });
      }
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < duration) {
      keepRegions.push({ start: cursor, end: duration });
    }

    if (keepRegions.length === 0) {
      showToast("Nothing would remain after removing all regions", "error");
      return;
    }

    setTrimming(true);
    let successCount = 0;
    try {
      for (const region of keepRegions) {
        const res = await fetchJson<{ jobId: string }>("/api/studio/trim", {
          method: "POST",
          body: JSON.stringify({
            assetId,
            startTime: region.start,
            endTime: region.end,
          }),
        });
        if (res.jobId) successCount++;
      }
      showToast(
        `${successCount} clean segment(s) queued for export`,
        "success",
      );
    } catch (err) {
      showToast(
        `Export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setTrimming(false);
    }
  }, [assetId, enabledCuts, duration]);

  const toggleCut = useCallback((index: number) => {
    setSuggestedCuts((prev) =>
      prev.map((c, i) => (i === index ? { ...c, enabled: !c.enabled } : c)),
    );
  }, []);

  // Format seconds as MM:SS.s
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return `${m}:${sec.padStart(4, "0")}`;
  };

  // Timeline handle drag
  const handleTimelineDrag = useCallback(
    (handle: "start" | "end" | "playhead", _e: React.MouseEvent) => {
      const timeline = timelineRef.current;
      if (!timeline) return;

      const rect = timeline.getBoundingClientRect();
      const updatePos = (clientX: number) => {
        const ratio = Math.max(
          0,
          Math.min(1, (clientX - rect.left) / rect.width),
        );
        const time = ratio * duration;
        if (handle === "start") {
          setStartTime(Math.min(time, endTime - 0.1));
        } else if (handle === "end") {
          setEndTime(Math.max(time, startTime + 0.1));
        } else {
          if (videoRef.current) videoRef.current.currentTime = time;
        }
      };

      const onMove = (ev: MouseEvent) => updatePos(ev.clientX);
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [duration, startTime, endTime],
  );

  // Timeline click handler for blade mode
  const handleTimelineClick = useCallback(
    (e: React.MouseEvent) => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      const rect = timeline.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      const time = ratio * duration;

      if (mode === "blade") {
        if (
          time > 0.1 &&
          time < duration - 0.1 &&
          !splitPoints.some((p) => Math.abs(p - time) < 0.2)
        ) {
          setSplitPoints((prev) => [...prev, time]);
        }
      } else {
        if (videoRef.current) videoRef.current.currentTime = time;
      }
    },
    [mode, duration, splitPoints],
  );

  const selectionWidthPct = ((endTime - startTime) / duration) * 100;
  const selectionLeftPct = (startTime / duration) * 100;
  const playheadPct = (currentTime / duration) * 100;

  return (
    <div
      className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3"
      data-testid="video-trimmer"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scissors className="h-5 w-5 text-blue-400" />
          <h3 className="text-sm font-semibold text-zinc-200">Video Trimmer</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode Toggle */}
          <div className="flex rounded bg-zinc-800 p-0.5">
            <button
              onClick={() => setMode("trim")}
              className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                mode === "trim"
                  ? "bg-blue-600 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Trim mode: Set In/Out points (I/O)"
            >
              Trim
            </button>
            <button
              onClick={() => setMode("blade")}
              className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                mode === "blade"
                  ? "bg-orange-600 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Blade mode: Split into clips (B to split)"
            >
              Blade
            </button>
          </div>
          <span className="text-xs text-zinc-500 font-mono">
            {fmt(duration)}
          </span>
        </div>
      </div>

      {/* Hotkey Hints */}
      <div className="flex flex-wrap gap-2 text-[9px] text-zinc-600">
        <span>
          <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
            Space
          </kbd>{" "}
          Play/Pause
        </span>
        <span>
          <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">I</kbd>{" "}
          Set In
        </span>
        <span>
          <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">O</kbd>{" "}
          Set Out
        </span>
        {mode === "blade" && (
          <span>
            <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
              B
            </kbd>{" "}
            Split at playhead
          </span>
        )}
      </div>

      {/* Video Preview */}
      <div className="rounded overflow-hidden bg-black aspect-video relative">
        <video
          ref={videoRef}
          src={buildMediaUrl(videoUrl)}
          className="w-full h-full object-contain"
          preload="metadata"
        />
        <button
          onClick={handleTogglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition opacity-0 hover:opacity-100"
        >
          {isPlaying ? (
            <Pause className="h-12 w-12 text-white/80" />
          ) : (
            <Play className="h-12 w-12 text-white/80" />
          )}
        </button>
        {/* Blade mode cursor indicator */}
        {mode === "blade" && (
          <div className="absolute top-2 right-2 rounded bg-orange-600/80 px-2 py-1 text-[10px] text-white font-medium">
            <SplitSquareHorizontal className="inline h-3 w-3 mr-1" />
            BLADE
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="space-y-1.5">
        <div
          ref={timelineRef}
          className={`relative h-10 rounded cursor-pointer select-none ${
            mode === "blade"
              ? "bg-zinc-800 ring-1 ring-orange-600/30"
              : "bg-zinc-800"
          }`}
          onMouseDown={
            mode === "trim"
              ? (e) => handleTimelineDrag("playhead", e)
              : undefined
          }
          onClick={mode === "blade" ? handleTimelineClick : undefined}
        >
          {/* Trim mode: Selection region */}
          {mode === "trim" && (
            <>
              <div
                className="absolute top-0 bottom-0 bg-blue-600/20 border-x-2 border-blue-500"
                style={{
                  left: `${selectionLeftPct}%`,
                  width: `${selectionWidthPct}%`,
                }}
              />
              <div
                className="absolute top-0 bottom-0 w-3 bg-blue-500 rounded-l cursor-ew-resize z-10 hover:bg-blue-400 transition"
                style={{ left: `calc(${selectionLeftPct}% - 6px)` }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleTimelineDrag("start", e);
                }}
                data-testid="start-handle"
              />
              <div
                className="absolute top-0 bottom-0 w-3 bg-blue-500 rounded-r cursor-ew-resize z-10 hover:bg-blue-400 transition"
                style={{
                  left: `calc(${selectionLeftPct + selectionWidthPct}% - 6px)`,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleTimelineDrag("end", e);
                }}
                data-testid="end-handle"
              />
            </>
          )}

          {/* Blade mode: Split point markers */}
          {mode === "blade" &&
            splitPoints.map((point, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-0.5 bg-orange-500 z-10 group"
                style={{ left: `${(point / duration) * 100}%` }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSplitPoint(point);
                  }}
                  className="absolute -top-1 -left-2 h-4 w-4 rounded-full bg-orange-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}

          {/* AI suggested cut regions (always visible when present) */}
          {suggestedCuts.map((cut, i) => (
            <div
              key={`cut-${i}`}
              className={`absolute top-0 bottom-0 cursor-pointer transition ${
                cut.enabled
                  ? "bg-red-500/25 border-x border-red-500/50 hover:bg-red-500/35"
                  : "bg-zinc-600/15 border-x border-zinc-600/30 hover:bg-zinc-600/25"
              }`}
              style={{
                left: `${(cut.start / duration) * 100}%`,
                width: `${((cut.end - cut.start) / duration) * 100}%`,
              }}
              title={`${cut.enabled ? "Remove" : "Keep"}: ${cut.reason}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCut(i);
              }}
            />
          ))}

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white z-20"
            style={{ left: `${playheadPct}%` }}
          />
        </div>

        {/* Time inputs (trim mode) */}
        {mode === "trim" && (
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">In:</span>
              <input
                type="number"
                min={0}
                max={endTime - 0.1}
                step={0.1}
                value={Number(startTime.toFixed(1))}
                onChange={(e) =>
                  setStartTime(
                    Math.max(
                      0,
                      Math.min(Number(e.target.value), endTime - 0.1),
                    ),
                  )
                }
                className="w-20 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-zinc-200 font-mono text-xs"
                data-testid="start-time-input"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Out:</span>
              <input
                type="number"
                min={startTime + 0.1}
                max={duration}
                step={0.1}
                value={Number(endTime.toFixed(1))}
                onChange={(e) =>
                  setEndTime(
                    Math.max(
                      startTime + 0.1,
                      Math.min(Number(e.target.value), duration),
                    ),
                  )
                }
                className="w-20 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-zinc-200 font-mono text-xs"
                data-testid="end-time-input"
              />
            </div>
            <span className="text-zinc-600 ml-auto font-mono">
              Selection: {fmt(endTime - startTime)}
            </span>
          </div>
        )}

        {/* Playhead time (blade mode) */}
        {mode === "blade" && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 font-mono">
              Playhead: {fmt(currentTime)}
            </span>
            <span className="text-zinc-600">
              {splitPoints.length} split(s) → {segments.length} clips
            </span>
          </div>
        )}
      </div>

      {/* Blade Mode: Segment List */}
      {mode === "blade" && segments.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-400 font-medium">Clip Segments:</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {segments.map((seg) => (
              <div
                key={seg.id}
                className="flex items-center gap-2 rounded bg-zinc-800 px-2 py-1.5 text-xs"
              >
                <span className="font-mono text-orange-400 shrink-0">
                  {fmt(seg.start)} – {fmt(seg.end)}
                </span>
                {editingSegmentId === seg.id ? (
                  <input
                    type="text"
                    value={segmentNameInput}
                    onChange={(e) => setSegmentNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        renameSegment(seg.id, segmentNameInput);
                      if (e.key === "Escape") setEditingSegmentId(null);
                    }}
                    onBlur={() => renameSegment(seg.id, segmentNameInput)}
                    className="flex-1 rounded bg-zinc-700 border border-zinc-600 px-1.5 py-0.5 text-zinc-200 text-xs"
                    autoFocus
                  />
                ) : (
                  <span className="flex-1 text-zinc-300 truncate">
                    {seg.name}
                  </span>
                )}
                <button
                  onClick={() => {
                    setEditingSegmentId(seg.id);
                    setSegmentNameInput(seg.name);
                  }}
                  className="text-zinc-500 hover:text-zinc-300 transition"
                  title="Rename clip"
                >
                  <Edit3 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Suggested Cuts */}
      {suggestedCuts.length > 0 && (
        <div className="space-y-1.5">
          <button
            onClick={() => setCutsExpanded(!cutsExpanded)}
            className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium hover:text-zinc-200 transition"
          >
            {cutsExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            AI Regions to Remove ({enabledCuts.length}/{suggestedCuts.length}{" "}
            enabled)
          </button>
          {cutsExpanded && (
            <div className="max-h-36 overflow-y-auto space-y-1">
              {suggestedCuts.map((cut, i) => (
                <button
                  key={i}
                  onClick={() => toggleCut(i)}
                  className={`w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-xs transition ${
                    cut.enabled
                      ? "bg-red-950/50 border border-red-800/50"
                      : "bg-zinc-800 border border-zinc-700 opacity-60"
                  }`}
                >
                  <span
                    className={`shrink-0 ${cut.enabled ? "text-red-400" : "text-zinc-500"}`}
                  >
                    {cut.enabled ? (
                      <Trash2 className="h-3 w-3" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                  </span>
                  <span className="font-mono text-zinc-400 shrink-0">
                    {fmt(cut.start)} – {fmt(cut.end)}
                  </span>
                  <span className="text-zinc-500 truncate">{cut.reason}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handlePlaySelection}
          className="flex items-center gap-1.5 rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs text-zinc-300 transition"
          title="Play selected region in a loop"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Loop
        </button>

        <button
          onClick={handleAnalyze}
          disabled={analyzing}
          className="flex items-center gap-1.5 rounded bg-purple-600/20 hover:bg-purple-600/30 border border-purple-600/50 px-3 py-2 text-xs text-purple-300 transition disabled:opacity-50"
          data-testid="analyze-button"
        >
          {analyzing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {analyzing ? "Analyzing…" : "Ask AI"}
        </button>

        <InlineModelPicker
          value={analyzeModel}
          onChange={setAnalyzeModel}
          className="max-w-[160px]"
        />

        {/* AI Apply All */}
        {enabledCuts.length > 0 && (
          <button
            onClick={handleApplyAllCuts}
            disabled={trimming}
            className="flex items-center gap-1.5 rounded bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 px-3 py-2 text-xs text-red-300 transition disabled:opacity-50"
          >
            {trimming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Apply All ({enabledCuts.length})
          </button>
        )}

        {/* Mode-specific export buttons */}
        {mode === "trim" && (
          <button
            onClick={handleTrim}
            disabled={trimming || startTime >= endTime}
            className="flex-1 flex items-center justify-center gap-1.5 rounded bg-blue-600 hover:bg-blue-700 px-3 py-2 text-xs text-white font-medium transition disabled:opacity-50"
            data-testid="trim-button"
          >
            {trimming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {trimming ? "Trimming…" : "Export Cut"}
          </button>
        )}

        {mode === "blade" && segments.length > 1 && (
          <button
            onClick={handleExportAllSegments}
            disabled={trimming}
            className="flex-1 flex items-center justify-center gap-1.5 rounded bg-orange-600 hover:bg-orange-700 px-3 py-2 text-xs text-white font-medium transition disabled:opacity-50"
          >
            {trimming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SplitSquareHorizontal className="h-3.5 w-3.5" />
            )}
            {trimming ? "Exporting…" : `Export ${segments.length} Clips`}
          </button>
        )}
      </div>
    </div>
  );
}
