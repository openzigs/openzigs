"use client";

import type { ReactNode } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface KPIDelta {
  /** Percent change versus a comparison period. */
  percent: number;
  /** Optional label, e.g. "vs last 7 days". */
  label?: string;
}

export interface KPICardProps {
  label: string;
  value: ReactNode;
  /** Optional sublabel/help text. */
  hint?: string;
  /** Optional icon node. */
  icon?: ReactNode;
  /** Optional delta vs prior period for trend arrow. */
  delta?: KPIDelta;
  /** Higher = better. Default true. */
  higherIsBetter?: boolean;
}

/**
 * Reusable KPI card with optional trend indicator. Extracted from
 * analytics-dashboard.tsx + analytics page for reuse across both
 * analytics views (#831).
 */
export function KPICard({
  label,
  value,
  hint,
  icon,
  delta,
  higherIsBetter = true,
}: KPICardProps) {
  const sign = delta ? Math.sign(delta.percent) : 0;
  const trendUp = sign > 0;
  const trendDown = sign < 0;
  const positive = higherIsBetter ? trendUp : trendDown;
  const negative = higherIsBetter ? trendDown : trendUp;

  return (
    <div
      className="rounded-lg border border-border bg-card p-3"
      data-testid={`kpi-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        {icon}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 flex items-center justify-between text-[10px]">
        {hint && <span className="text-muted-foreground">{hint}</span>}
        {delta && (
          <span
            className={`ml-auto inline-flex items-center gap-0.5 ${
              positive
                ? "text-emerald-500"
                : negative
                  ? "text-red-500"
                  : "text-muted-foreground"
            }`}
            aria-label={`${delta.label ?? "Change"}: ${delta.percent.toFixed(1)} percent`}
          >
            {sign > 0 ? (
              <TrendingUp className="h-3 w-3" />
            ) : sign < 0 ? (
              <TrendingDown className="h-3 w-3" />
            ) : (
              <Minus className="h-3 w-3" />
            )}
            {delta.percent > 0 ? "+" : ""}
            {delta.percent.toFixed(1)}%{delta.label ? ` ${delta.label}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sublabel?: string;
}

/** Compact stat card variant. */
export function StatCard({ label, value, sublabel }: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sublabel && (
        <div className="text-[10px] text-muted-foreground">{sublabel}</div>
      )}
    </div>
  );
}
