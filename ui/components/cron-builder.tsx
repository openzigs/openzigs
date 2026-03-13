"use client";

import { useMemo, useState } from "react";
import { Clock } from "lucide-react";

type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "custom";

const DAYS_OF_WEEK = [
  { short: "Mon", value: 1 },
  { short: "Tue", value: 2 },
  { short: "Wed", value: 3 },
  { short: "Thu", value: 4 },
  { short: "Fri", value: 5 },
  { short: "Sat", value: 6 },
  { short: "Sun", value: 0 },
];

/**
 * Compute next N run dates from a cron expression.
 * Lightweight implementation that handles common patterns.
 */
function getNextRuns(cron: string, count: number, _timezone?: string): Date[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const [minStr, hourStr, domStr, monStr, dowStr] = parts;
  const results: Date[] = [];
  const now = new Date();
  const cursor = new Date(now.getTime() + 60000); // start 1 min from now
  cursor.setSeconds(0, 0);

  for (let i = 0; i < 525960 && results.length < count; i++) {
    const min = cursor.getMinutes();
    const hour = cursor.getHours();
    const dom = cursor.getDate();
    const mon = cursor.getMonth() + 1;
    const dow = cursor.getDay();

    if (
      matchField(minStr, min) &&
      matchField(hourStr, hour) &&
      matchField(domStr, dom) &&
      matchField(monStr, mon) &&
      matchField(dowStr, dow)
    ) {
      results.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return results;
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    if (part.includes("/")) {
      const [base, step] = part.split("/");
      const s = parseInt(step, 10);
      const b = base === "*" ? 0 : parseInt(base, 10);
      return (value - b) % s === 0 && value >= b;
    }
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(part, 10) === value;
  });
}

export function CronBuilder({
  value,
  onChange,
  timezone,
}: {
  value: string;
  onChange: (cron: string) => void;
  timezone?: string;
}) {
  const [mode, setMode] = useState<"simple" | "advanced">(isSimpleExpression(value) ? "simple" : "advanced");
  const [frequency, setFrequency] = useState<Frequency>(() => parseFrequency(value));
  const [hour, setHour] = useState(() => parseHour(value));
  const [minute, setMinute] = useState(() => parseMinute(value));
  const [selectedDays, setSelectedDays] = useState<number[]>(() => parseDays(value));
  const [monthDay, setMonthDay] = useState(() => parseMonthDay(value));

  const nextRuns = useMemo(() => getNextRuns(value, 3, timezone), [value, timezone]);

  const buildCron = (freq: Frequency, h: number, m: number, days: number[], mday: number) => {
    switch (freq) {
      case "hourly": return `0 * * * *`;
      case "daily": return `${m} ${h} * * *`;
      case "weekdays": return `${m} ${h} * * 1-5`;
      case "weekly": return `${m} ${h} * * ${days.length > 0 ? days.join(",") : "1"}`;
      case "monthly": return `${m} ${h} ${mday} * *`;
      default: return value;
    }
  };

  const handleFrequencyChange = (f: Frequency) => {
    setFrequency(f);
    if (f !== "custom") {
      onChange(buildCron(f, hour, minute, selectedDays, monthDay));
    }
  };

  const handleTimeChange = (h: number, m: number) => {
    setHour(h);
    setMinute(m);
    if (frequency !== "custom") onChange(buildCron(frequency, h, m, selectedDays, monthDay));
  };

  const handleDayToggle = (day: number) => {
    const next = selectedDays.includes(day) ? selectedDays.filter((d) => d !== day) : [...selectedDays, day];
    setSelectedDays(next);
    if (frequency === "weekly") onChange(buildCron("weekly", hour, minute, next, monthDay));
  };

  const handleMonthDayChange = (d: number) => {
    setMonthDay(d);
    if (frequency === "monthly") onChange(buildCron("monthly", hour, minute, selectedDays, d));
  };

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
        <button
          type="button"
          onClick={() => setMode("simple")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
            mode === "simple" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Simple
        </button>
        <button
          type="button"
          onClick={() => setMode("advanced")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
            mode === "advanced" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Advanced
        </button>
      </div>

      {mode === "simple" ? (
        <div className="space-y-3">
          {/* Frequency presets */}
          <div className="flex flex-wrap gap-1.5">
            {(["hourly", "daily", "weekdays", "weekly", "monthly"] as Frequency[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => handleFrequencyChange(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  frequency === f
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Time picker (hidden for hourly) */}
          {frequency !== "hourly" && (
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">at</span>
              <select
                value={hour}
                onChange={(e) => handleTimeChange(parseInt(e.target.value), minute)}
                className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, "0")}</option>
                ))}
              </select>
              <span className="text-sm text-muted-foreground">:</span>
              <select
                value={minute}
                onChange={(e) => handleTimeChange(hour, parseInt(e.target.value))}
                className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
              >
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                ))}
              </select>
            </div>
          )}

          {/* Day picker for weekly */}
          {frequency === "weekly" && (
            <div className="flex gap-1">
              {DAYS_OF_WEEK.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => handleDayToggle(d.value)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                    selectedDays.includes(d.value)
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {d.short}
                </button>
              ))}
            </div>
          )}

          {/* Month day picker */}
          {frequency === "monthly" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">on day</span>
              <select
                value={monthDay}
                onChange={(e) => handleMonthDayChange(parseInt(e.target.value))}
                className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
              >
                {Array.from({ length: 28 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1}</option>
                ))}
              </select>
            </div>
          )}

          {/* Generated expression */}
          <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-1.5">
            <code className="font-mono text-xs text-muted-foreground">{value}</code>
          </div>
        </div>
      ) : (
        /* Advanced mode: raw text input */
        <input
          type="text"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
          placeholder="* * * * *  (min hour day month weekday)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {/* Next runs preview */}
      {nextRuns.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Next runs</p>
          <div className="space-y-0.5">
            {nextRuns.map((d, i) => (
              <p key={i} className="text-xs text-foreground/80">
                {d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}{" "}
                {d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Helpers to parse cron into simple mode state ── */

function isSimpleExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Check if it matches common simple patterns
  const [min, hour, dom, mon, dow] = parts;
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return true; // hourly
  if (dom === "*" && mon === "*" && dow === "*") return true; // daily
  if (dom === "*" && mon === "*" && dow === "1-5") return true; // weekdays
  if (dom === "*" && mon === "*" && /^\d(,\d)*$/.test(dow)) return true; // weekly
  if (mon === "*" && dow === "*" && /^\d+$/.test(dom)) return true; // monthly
  return false;
}

function parseFrequency(cron: string): Frequency {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "daily";
  const [, hour, dom, , dow] = parts;
  if (hour === "*") return "hourly";
  if (dom !== "*") return "monthly";
  if (dow === "1-5") return "weekdays";
  if (dow !== "*") return "weekly";
  return "daily";
}

function parseHour(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return 8;
  const h = parseInt(parts[1], 10);
  return isNaN(h) ? 8 : h;
}

function parseMinute(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 1) return 0;
  const m = parseInt(parts[0], 10);
  return isNaN(m) ? 0 : m;
}

function parseDays(cron: string): number[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return [1];
  const dow = parts[4];
  if (dow === "*" || dow === "1-5") return [1];
  return dow.split(",").map(Number).filter((n) => !isNaN(n));
}

function parseMonthDay(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 3) return 1;
  const d = parseInt(parts[2], 10);
  return isNaN(d) || d < 1 ? 1 : d;
}
