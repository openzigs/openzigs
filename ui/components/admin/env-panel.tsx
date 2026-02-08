"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { EnvEntry } from "@/lib/types";

export const EnvPanel = () => {
  const query = useQuery({
    queryKey: ["env"],
    queryFn: () => fetchJson<EnvEntry[]>("/api/admin/env"),
  });

  if (query.isLoading) return <p className="text-sm text-ink/50">Loading…</p>;

  const envItems = query.data ?? [];
  if (envItems.length === 0) return <p className="text-sm text-ink/50">No environment items.</p>;

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {envItems.map((item) => (
        <div
          key={item.name}
          className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white/60 px-3 py-2"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              item.configured ? "bg-moss" : "bg-ember"
            }`}
          />
          <span className="text-xs font-medium text-ink">{item.label ?? item.name}</span>
        </div>
      ))}
    </div>
  );
};
