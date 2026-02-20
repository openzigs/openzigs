"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import type { QuizQuestion, QuizResult } from "@/hooks/use-presenter-state";

interface QuizOverlayProps {
  quiz: QuizQuestion;
  lastResult: QuizResult | null;
  onAnswer: (selectedIndex: number) => void;
  onDismiss: () => void;
}

export function QuizOverlay({
  quiz,
  lastResult,
  onAnswer,
  onDismiss,
}: QuizOverlayProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const answered = lastResult?.questionId === quiz.id;

  const handleSelect = (idx: number) => {
    if (answered) return;
    setSelected(idx);
    onAnswer(idx);
  };

  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center">
      <div className="w-full max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-white/10 bg-card p-4 shadow-xl sm:mx-4 sm:max-w-lg sm:rounded-2xl sm:p-6">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-primary">
          Pop Quiz
        </p>
        <h3 className="mb-4 text-base font-semibold text-foreground">
          {quiz.question}
        </h3>

        <div className="space-y-2">
          {quiz.options.map((option, i) => {
            let style =
              "border-border hover:border-primary/40 hover:bg-primary/5";
            if (answered) {
              if (i === quiz.correct_index)
                style =
                  "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
              else if (i === selected && i !== quiz.correct_index)
                style =
                  "border-destructive/50 bg-destructive/10 text-destructive";
              else style = "border-border opacity-50";
            } else if (i === selected) {
              style = "border-primary bg-primary/10";
            }

            return (
              <button
                key={i}
                onClick={() => handleSelect(i)}
                disabled={answered}
                className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${style}`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="flex-1">{option}</span>
                {answered && i === quiz.correct_index && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                )}
                {answered &&
                  i === selected &&
                  i !== quiz.correct_index && (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                  )}
              </button>
            );
          })}
        </div>

        {answered && lastResult && (
          <div className="mt-4 rounded-xl border border-border bg-muted/50 p-3">
            <p className="text-xs font-semibold text-foreground">
              {lastResult.correct ? "✓ Correct!" : "✗ Not quite."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {quiz.explanation}
            </p>
          </div>
        )}

        {answered && (
          <button
            onClick={onDismiss}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Continue Watching
          </button>
        )}
      </div>
    </div>
  );
}
