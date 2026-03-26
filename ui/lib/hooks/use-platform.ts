/**
 * React hook for querying platform capabilities from the backend.
 * Issue #601 — Show platform-appropriate feature availability in the UI.
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";

export type PlatformInfo = {
  os: string;
  arch: string;
  dockerAvailable: boolean;
  sidecarsSupported: boolean;
  chromePath: string | null;
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
};

export type FeatureAvailability = {
  available: boolean;
  reason?: string;
};

export type PlatformResponse = {
  platform: PlatformInfo;
  features: Record<string, FeatureAvailability>;
};

export function usePlatform() {
  return useQuery<PlatformResponse>({
    queryKey: ["platform"],
    queryFn: () => fetchJson<PlatformResponse>("/api/admin/platform"),
    staleTime: 5 * 60 * 1000, // 5 minutes — platform doesn't change at runtime
    retry: 1,
  });
}
