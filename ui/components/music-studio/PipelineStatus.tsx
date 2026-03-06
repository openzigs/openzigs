"use client";

import { useState, useEffect, useCallback } from "react";
import { useSocket } from "@/lib/socket-context";
import { Loader2, CheckCircle, XCircle, AlertCircle } from "lucide-react";

interface PipelineStage {
  key: string;
  label: string;
}

const PIPELINE_STAGES: PipelineStage[] = [
  { key: "stem_separation", label: "Stem Separation" },
  { key: "voice_conversion", label: "Voice Conversion" },
  { key: "mixdown", label: "Final Mixdown" },
];

interface PipelineStatusProps {
  /** Job ID to track */
  jobId: string | null;
  /** Called when pipeline completes */
  onComplete?: (result: { resultUrl?: string; galleryAssetId?: string }) => void;
  /** Called on failure */
  onError?: (error: string) => void;
}

export function PipelineStatus({ jobId, onComplete, onError }: PipelineStatusProps) {
  const { socket } = useSocket();
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "processing" | "complete" | "failed">("idle");

  const getStageStatus = useCallback((stageKey: string) => {
    if (!stage) return "pending";
    const currentIdx = PIPELINE_STAGES.findIndex((s) => s.key === stage);
    const stageIdx = PIPELINE_STAGES.findIndex((s) => s.key === stageKey);
    if (stage === "complete" || stage === "failed") {
      return stage === "complete" ? "done" : stageIdx <= currentIdx ? "done" : "pending";
    }
    if (stageIdx < currentIdx) return "done";
    if (stageIdx === currentIdx) return "active";
    return "pending";
  }, [stage]);

  useEffect(() => {
    if (!socket || !jobId) return;

    const onProgress = (data: { jobId: string; stage?: string; progress?: number; message?: string }) => {
      if (data.jobId !== jobId) return;
      if (data.stage) setStage(data.stage);
      if (data.progress != null) setProgress(data.progress);
      if (data.message) setMessage(data.message);
      setStatus("processing");
    };

    const onJobComplete = (data: { jobId: string; resultUrl?: string; galleryAssetId?: string }) => {
      if (data.jobId !== jobId) return;
      setStatus("complete");
      setStage("complete");
      setProgress(100);
      setMessage("Pipeline complete");
      onComplete?.(data);
    };

    const onJobFailed = (data: { jobId: string; error?: string }) => {
      if (data.jobId !== jobId) return;
      setStatus("failed");
      setMessage(data.error ?? "Pipeline failed");
      onError?.(data.error ?? "Unknown error");
    };

    socket.on("queue:job:progress", onProgress);
    socket.on("queue:job:complete", onJobComplete);
    socket.on("queue:job:failed", onJobFailed);

    return () => {
      socket.off("queue:job:progress", onProgress);
      socket.off("queue:job:complete", onJobComplete);
      socket.off("queue:job:failed", onJobFailed);
    };
  }, [socket, jobId, onComplete, onError]);

  // Reset when jobId changes
  useEffect(() => {
    if (jobId) {
      setStatus("processing");
      setStage(null);
      setProgress(0);
      setMessage("Queued...");
    } else {
      setStatus("idle");
    }
  }, [jobId]);

  if (status === "idle") return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-300">Pipeline Progress</h3>

      {/* Stage indicators */}
      <div className="mb-4 flex items-center gap-2">
        {PIPELINE_STAGES.map((s, i) => {
          const stageStatus = getStageStatus(s.key);
          return (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && (
                <div className={`h-px w-6 ${stageStatus === "done" ? "bg-emerald-500" : "bg-zinc-700"}`} />
              )}
              <div className="flex items-center gap-1.5">
                {stageStatus === "done" ? (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                ) : stageStatus === "active" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                ) : (
                  <div className="h-4 w-4 rounded-full border border-zinc-600" />
                )}
                <span className={`text-xs ${stageStatus === "active" ? "text-indigo-400" : stageStatus === "done" ? "text-emerald-400" : "text-zinc-500"}`}>
                  {s.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full transition-all duration-300 ${status === "failed" ? "bg-red-500" : status === "complete" ? "bg-emerald-500" : "bg-indigo-500"}`}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>

      {/* Status message */}
      <div className="flex items-center gap-2">
        {status === "failed" ? (
          <XCircle className="h-3.5 w-3.5 text-red-400" />
        ) : status === "complete" ? (
          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-zinc-500" />
        )}
        <span className={`text-xs ${status === "failed" ? "text-red-400" : status === "complete" ? "text-emerald-400" : "text-zinc-500"}`}>
          {message}
        </span>
      </div>
    </div>
  );
}
