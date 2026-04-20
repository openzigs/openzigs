"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";

export interface AuditSnapshot {
  id: number;
  siteUrl: string;
  healthScore: number;
  rating: string;
  pagesAudited: number;
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  dataJson: string;
  createdAt: string;
}

export interface AuditComparison {
  current: AuditSnapshot;
  previous: AuditSnapshot | null;
  scoreDelta: number;
  newIssues: number;
  resolvedIssues: number;
  regressions: string[];
}

export function useSeoHistory(siteUrl?: string) {
  return useQuery<AuditSnapshot[]>({
    queryKey: ["seo-history", siteUrl ?? "all"],
    queryFn: () => {
      const params = siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : "";
      return fetchJson<AuditSnapshot[]>(`/api/seo/history${params}`);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: 30_000,
  });
}

export function useSeoSnapshot(id: number | null) {
  return useQuery<AuditSnapshot>({
    queryKey: ["seo-snapshot", id],
    queryFn: () => fetchJson<AuditSnapshot>(`/api/seo/history/${id}`),
    enabled: id !== null,
  });
}

export function useSeoComparison(siteUrl: string | null) {
  return useQuery<AuditComparison>({
    queryKey: ["seo-comparison", siteUrl],
    queryFn: () =>
      fetchJson<AuditComparison>(
        `/api/seo/history/compare/${encodeURIComponent(siteUrl!)}`,
      ),
    enabled: siteUrl !== null,
  });
}
