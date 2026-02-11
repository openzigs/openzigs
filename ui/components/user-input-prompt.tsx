"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Bot, Clock, Check, AlertCircle } from "lucide-react";
import type { UserInputRequest } from "@/lib/types";

type PromptState = "active" | "answered" | "timed-out";

/* ── Timeout Bar ── */

const TimeoutBar = ({ remaining, total }: { remaining: number; total: number }) => {
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  const seconds = Math.ceil(remaining / 1000);

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-1000 ease-linear",
            pct > 50 ? "bg-primary" : pct > 20 ? "bg-amber-500" : "bg-destructive"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {seconds}s
      </span>
    </div>
  );
};

/* ── Choice List ── */

const ChoiceList = ({
  choices,
  selected,
  onSelect,
  disabled,
}: {
  choices: string[];
  selected: string | null;
  onSelect: (choice: string) => void;
  disabled: boolean;
}) => (
  <div className="space-y-1.5" role="radiogroup" aria-label="Agent choices">
    {choices.map((choice) => (
      <button
        key={choice}
        type="button"
        role="radio"
        aria-checked={selected === choice}
        disabled={disabled}
        onClick={() => onSelect(choice)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors text-left",
          selected === choice
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-card hover:border-primary/30 hover:bg-primary/5",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected === choice
              ? "border-primary bg-primary"
              : "border-muted-foreground/40"
          )}
        >
          {selected === choice && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
          )}
        </span>
        <span>{choice}</span>
      </button>
    ))}
  </div>
);

/* ── User Input Prompt ── */

export const UserInputPrompt = ({
  request,
  onSubmit,
}: {
  request: UserInputRequest;
  onSubmit: (answer: string, wasFreeform: boolean) => void;
}) => {
  const [state, setState] = useState<PromptState>("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [freeformText, setFreeformText] = useState("");
  const [answeredWith, setAnsweredWith] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(request.timeout ?? 0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const totalTimeout = request.timeout ?? 0;

  // Timeout countdown
  useEffect(() => {
    if (!totalTimeout || state !== "active") return;
    setRemaining(totalTimeout);
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const left = totalTimeout - elapsed;
      if (left <= 0) {
        setState("timed-out");
        onSubmit("", false);
        if (timerRef.current) clearInterval(timerRef.current);
      } else {
        setRemaining(left);
      }
    }, 250);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [totalTimeout, state, onSubmit]);

  const handleSubmit = useCallback(() => {
    if (state !== "active") return;
    const answer = selected ?? freeformText.trim();
    if (!answer) return;
    const wasFreeform = !selected;
    setAnsweredWith(answer);
    setState("answered");
    if (timerRef.current) clearInterval(timerRef.current);
    onSubmit(answer, wasFreeform);
  }, [state, selected, freeformText, onSubmit]);

  const showFreeform = request.allowFreeform !== false || !request.choices?.length;

  return (
    <div className="flex items-start gap-3 animate-slide-in">
      {/* Bot avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Bot className="h-4 w-4" />
      </div>
      {/* Prompt card */}
      <div
        className={cn(
          "max-w-[75%] space-y-3 rounded-2xl border px-4 py-3 text-sm",
          state === "active"
            ? "border-primary/30 bg-primary/5"
            : state === "answered"
              ? "border-border bg-muted"
              : "border-amber-500/30 bg-amber-500/5"
        )}
      >
        {/* Question */}
        <p className="font-medium text-foreground">{request.question}</p>

        {/* Active state */}
        {state === "active" && (
          <>
            {request.choices && request.choices.length > 0 && (
              <ChoiceList
                choices={request.choices}
                selected={selected}
                onSelect={(c) => {
                  setSelected(c);
                  setFreeformText("");
                }}
                disabled={false}
              />
            )}

            {showFreeform && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={freeformText}
                  onChange={(e) => {
                    setFreeformText(e.target.value);
                    setSelected(null);
                  }}
                  placeholder="Or type your answer…"
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                disabled={!selected && !freeformText.trim()}
                onClick={handleSubmit}
              >
                Submit
              </Button>
              {totalTimeout > 0 && <TimeoutBar remaining={remaining} total={totalTimeout} />}
            </div>
          </>
        )}

        {/* Answered state */}
        {state === "answered" && answeredWith && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-primary" />
            <span>Answered: <span className="font-medium text-foreground">{answeredWith}</span></span>
          </div>
        )}

        {/* Timed out state */}
        {state === "timed-out" && (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>Timed out — agent continued with default</span>
          </div>
        )}
      </div>
    </div>
  );
};
