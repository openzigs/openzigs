"use client";

import { useEffect, useState, useCallback } from "react";
import { useSocket } from "@/lib/socket-context";

export interface CrawlStats {
  jobId: string;
  siteUrl: string;
  pagesCompleted: number;
  totalPages: number;
  startedAt: string;
  status: "running" | "completed" | "failed";
}

export interface CrawlProgressEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  estimatedTotal: number;
  lastUrl: string;
  errorCount: number;
  elapsedMs: number;
}

export interface CrawlCompletedEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  errorCount: number;
  elapsedMs: number;
  status: "completed" | "failed";
}

export function useCrawlProgress() {
  const { socket } = useSocket();
  const [activeCrawls, setActiveCrawls] = useState<Map<string, CrawlStats>>(
    new Map(),
  );

  const handleStarted = useCallback(
    (event: { jobId: string; siteUrl: string; estimatedTotal?: number }) => {
      setActiveCrawls((prev) => {
        const next = new Map(prev);
        next.set(event.jobId, {
          jobId: event.jobId,
          siteUrl: event.siteUrl,
          pagesCompleted: 0,
          totalPages: event.estimatedTotal ?? 0,
          startedAt: new Date().toISOString(),
          status: "running",
        });
        return next;
      });
    },
    [],
  );

  const handleProgress = useCallback((event: CrawlProgressEvent) => {
    setActiveCrawls((prev) => {
      const next = new Map(prev);
      const existing = next.get(event.jobId);
      if (existing) {
        next.set(event.jobId, {
          ...existing,
          pagesCompleted: event.pagesScraped,
          totalPages: event.estimatedTotal || existing.totalPages,
        });
      }
      return next;
    });
  }, []);

  const handleCompleted = useCallback((event: CrawlCompletedEvent) => {
    setActiveCrawls((prev) => {
      const next = new Map(prev);
      const existing = next.get(event.jobId);
      if (existing) {
        next.set(event.jobId, {
          ...existing,
          pagesCompleted: event.pagesScraped,
          totalPages: event.pagesScraped,
          status: event.status === "failed" ? "failed" : "completed",
        });
      }
      // Auto-remove after 10 seconds
      setTimeout(() => {
        setActiveCrawls((p) => {
          const n = new Map(p);
          n.delete(event.jobId);
          return n;
        });
      }, 10_000);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on("crawl:started", handleStarted);
    socket.on("crawl:progress", handleProgress);
    socket.on("crawl:completed", handleCompleted);
    return () => {
      socket.off("crawl:started", handleStarted);
      socket.off("crawl:progress", handleProgress);
      socket.off("crawl:completed", handleCompleted);
    };
  }, [socket, handleStarted, handleProgress, handleCompleted]);

  return {
    activeCrawls: Array.from(activeCrawls.values()),
    hasCrawls: activeCrawls.size > 0,
  };
}
