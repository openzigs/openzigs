"use client";

import { useEffect, useState, useCallback } from "react";
import { useSocket } from "@/lib/socket-context";

export interface CrawlPageError {
  url: string;
  statusCode?: number;
  message?: string;
}

export interface CrawlStats {
  jobId: string;
  siteUrl: string;
  pagesCompleted: number;
  totalPages: number;
  startedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Most recent URL processed by the crawler. */
  lastUrl: string;
  /** Total error count for the crawl. */
  errorCount: number;
  /** Recent errors, capped client-side at 50. */
  errors: CrawlPageError[];
  /** Server clientId scope (#841). */
  clientId?: string;
}

export interface CrawlStartedEvent {
  jobId: string;
  siteUrl: string;
  estimatedTotal?: number;
  startedAt?: string;
  clientId?: string;
}

export interface CrawlProgressEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  estimatedTotal: number;
  lastUrl: string;
  errorCount: number;
  elapsedMs: number;
  clientId?: string;
  lastError?: CrawlPageError;
}

export interface CrawlCompletedEvent {
  jobId: string;
  siteUrl: string;
  pagesScraped: number;
  errorCount: number;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
  clientId?: string;
  errors?: CrawlPageError[];
}

const MAX_RECENT_ERRORS = 50;

export function useCrawlProgress() {
  const { socket } = useSocket();
  const [activeCrawls, setActiveCrawls] = useState<Map<string, CrawlStats>>(
    new Map(),
  );

  const handleStarted = useCallback((event: CrawlStartedEvent) => {
    setActiveCrawls((prev) => {
      const next = new Map(prev);
      next.set(event.jobId, {
        jobId: event.jobId,
        siteUrl: event.siteUrl,
        pagesCompleted: 0,
        totalPages: event.estimatedTotal ?? 0,
        startedAt: event.startedAt ?? new Date().toISOString(),
        status: "running",
        lastUrl: event.siteUrl,
        errorCount: 0,
        errors: [],
        clientId: event.clientId,
      });
      return next;
    });
  }, []);

  const handleProgress = useCallback((event: CrawlProgressEvent) => {
    setActiveCrawls((prev) => {
      const next = new Map(prev);
      const existing = next.get(event.jobId);
      if (!existing) return prev;
      const errors = event.lastError
        ? [...existing.errors, event.lastError].slice(-MAX_RECENT_ERRORS)
        : existing.errors;
      next.set(event.jobId, {
        ...existing,
        pagesCompleted: event.pagesScraped,
        totalPages: event.estimatedTotal || existing.totalPages,
        lastUrl: event.lastUrl || existing.lastUrl,
        errorCount: event.errorCount,
        errors,
      });
      return next;
    });
  }, []);

  const handleCompleted = useCallback((event: CrawlCompletedEvent) => {
    setActiveCrawls((prev) => {
      const next = new Map(prev);
      const existing = next.get(event.jobId);
      if (!existing) return prev;
      next.set(event.jobId, {
        ...existing,
        pagesCompleted: event.pagesScraped,
        totalPages: event.pagesScraped || existing.totalPages,
        status: event.status,
        errorCount: event.errorCount,
        errors: event.errors ?? existing.errors,
      });
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
