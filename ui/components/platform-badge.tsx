/**
 * PlatformBadge — Shows feature availability with platform-specific messaging.
 * Issue #601
 */

"use client";

import type { FeatureAvailability } from "@/lib/hooks/use-platform";

export function PlatformBadge({
  feature,
}: {
  feature: FeatureAvailability | undefined;
}) {
  if (!feature) return null;

  if (feature.available) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        Available
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      title={feature.reason}
    >
      {feature.reason ?? "Unavailable"}
    </span>
  );
}
