"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Scissors,
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  Loader2,
  Download,

} from "lucide-react";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { showToast } from "@/components/toast";

interface SuggestedCut {
  start: number;
  end: number;
  reason: string;
}

interface VideoTrimmerProps {
  assetId: string;
  /** URL to stream the video from (e.g. /api/queue/assets/:id/file) */
  videoUrl: string;
  /** Total duration in seconds (from gallery asset metadata) */
  duration: number;
  onTrimComplete?: (newAssetId: string) => void;
}

export function VideoTrimmer({ assetId, videoUrl, duration }: VideoTrimmerProps) {
  const { socket } = useSocket();
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(duration);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimJobId, setTrimJobId] = useState<string | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [suggestedCuts, setSuggestedCuts] = useState<SuggestedCut[]>([]);
  const [loopPreview, setLoopPreview] = useState(false);

  // Listen for Socket.IO events
  useEffect(() => {
    if (!socket) return;

    const onTrimComplete = (data: { jobId: string }) => {
      if (data.jobId === trimJobId) {
        setTrimming(false);
        showToast("Trim complete! New clip saved to Gallery.", "success");
      }
    };
    const onTrimFailed = (data: { jobId: string; error: string }) => {
      if (data.jobId === trimJobId) {
        setTrimming(false);
        showToast(`Trim failed: ${data.error}`, "error");
      }
    };

    if (!socket) return;
    socket.on("trim:complete", onTrimComplete);
    socket.on("trim:failed", onTrimFailed);
    return () => {
      socket.off("trim:complete", onTrimComplete);
      socket.off("trim:failed", onTrimFailed);
    };
  }, [socket, trimJobId]);

  // Video time tracking
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // Loop within selection if preview-looping
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
      showToast(`Trim failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
      setTrimming(false);
    }
  }, [assetId, startTime, endTime]);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setSuggestedCuts([]);
    try {
      const res = await fetchJson<{ jobId: string }>("/api/studio/analyze", {
        method: "POST",
        body: JSON.stringify({ assetId }),
      });

      // Poll for completion
      const poll = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const job = await fetchJson<{
            status: string;
            suggestedCuts?: SuggestedCut[];
          }>(`/api/studio/analyze/${res.jobId}`);

          if (job.status === "complete" && job.suggestedCuts) {
            setSuggestedCuts(job.suggestedCuts);
            showToast(`AI found ${job.suggestedCuts.length} suggested cuts`, "success");
            return;
          }
          if (job.status === "failed") {
            throw new Error("Analysis failed");
          }
        }
        throw new Error("Analysis timed out");
      };
      await poll();
    } catch (err) {
      showToast(`Analysis failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    } finally {
      setAnalyzing(false);
    }
  }, [assetId]);

  const applySuggestedCut = useCallback(
    (cut: SuggestedCut) => {
      // Set trim handles to keep content, removing the cut region
      // User can manually trim the cut region out
      setStartTime(cut.start);
      setEndTime(cut.end);
      if (videoRef.current) {
        videoRef.current.currentTime = cut.start;
      }
    },
    [],
  );

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
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
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

  const selectionWidthPct = ((endTime - startTime) / duration) * 100;
  const selectionLeftPct = (startTime / duration) * 100;
  const playheadPct = (currentTime / duration) * 100;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4" data-testid="video-trimmer">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scissors className="h-5 w-5 text-blue-400" />
          <h3 className="text-sm font-semibold text-zinc-200">Video Trimmer</h3>
        </div>
        <span className="text-xs text-zinc-500 font-mono">{fmt(duration)}</span>
      </div>

      {/* Video Preview */}
      <div className="rounded overflow-hidden bg-black aspect-video relative">
        <video
          ref={videoRef}
          src={buildMediaUrl(videoUrl)}
          className="w-full h-full object-contain"
          preload="metadata"
        />
        {/* Play overlay */}
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
      </div>

      {/* Timeline */}
      <div className="space-y-2">
        <div
          ref={timelineRef}
          className="relative h-10 rounded bg-zinc-800 cursor-pointer select-none"
          onMouseDown={(e) => handleTimelineDrag("playhead", e)}
        >
          {/* Selection region */}
          <div
            className="absolute top-0 bottom-0 bg-blue-600/20 border-x-2 border-blue-500"
            style={{ left: `${selectionLeftPct}%`, width: `${selectionWidthPct}%` }}
          />

          {/* Suggested cut markers */}
          {suggestedCuts.map((cut, i) => (
            <div
              key={i}
              className="absolute top-0 bottom-0 bg-red-500/20 border-x border-red-500/50 cursor-pointer hover:bg-red-500/30 transition"
              style={{
                left: `${(cut.start / duration) * 100}%`,
                width: `${((cut.end - cut.start) / duration) * 100}%`,
              }}
              title={cut.reason}
              onClick={() => applySuggestedCut(cut)}
            />
          ))}

          {/* Start handle */}
          <div
            className="absolute top-0 bottom-0 w-3 bg-blue-500 rounded-l cursor-ew-resize z-10 hover:bg-blue-400 transition"
            style={{ left: `calc(${selectionLeftPct}% - 6px)` }}
            onMouseDown={(e) => {
              e.stopPropagation();
              handleTimelineDrag("start", e);
            }}
            data-testid="start-handle"
          />

          {/* End handle */}
          <div
            className="absolute top-0 bottom-0 w-3 bg-blue-500 rounded-r cursor-ew-resize z-10 hover:bg-blue-400 transition"
            style={{ left: `calc(${selectionLeftPct + selectionWidthPct}% - 6px)` }}
            onMouseDown={(e) => {
              e.stopPropagation();
              handleTimelineDrag("end", e);
            }}
            data-testid="end-handle"
          />

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white z-20"
            style={{ left: `${playheadPct}%` }}
          />
        </div>

        {/* Time inputs */}
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500">In:</span>
            <input
              type="number"
              min={0}
              max={endTime - 0.1}
              step={0.1}
              value={Number(startTime.toFixed(1))}
              onChange={(e) => setStartTime(Math.max(0, Math.min(Number(e.target.value), endTime - 0.1)))}
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
              onChange={(e) => setEndTime(Math.max(startTime + 0.1, Math.min(Number(e.target.value), duration)))}
              className="w-20 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-zinc-200 font-mono text-xs"
              data-testid="end-time-input"
            />
          </div>
          <span className="text-zinc-600 ml-auto font-mono">
            Selection: {fmt(endTime - startTime)}
          </span>
        </div>
      </div>

      {/* Suggested cuts list */}
      {suggestedCuts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400 font-medium">AI Suggested Cuts:</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {suggestedCuts.map((cut, i) => (
              <button
                key={i}
                onClick={() => applySuggestedCut(cut)}
                className="w-full text-left flex items-center gap-2 rounded bg-zinc-800 hover:bg-zinc-750 px-2 py-1.5 text-xs transition"
              >
                <span className="font-mono text-red-400 shrink-0">
                  {fmt(cut.start)} – {fmt(cut.end)}
                </span>
                <span className="text-zinc-400 truncate">{cut.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handlePlaySelection}
          className="flex items-center gap-1.5 rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs text-zinc-300 transition"
          title="Play selected region in a loop"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Play Selection
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
      </div>
    </div>
  );
}
