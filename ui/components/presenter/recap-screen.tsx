"use client";

import { useMemo } from "react";
import { RotateCcw, Download, CheckCircle2, XCircle, MessageSquare, FileText } from "lucide-react";
import type { QuizResult, QAEntry } from "@/hooks/use-presenter-state";
import { ScoreRing } from "./score-ring";
import { generateRecapPdf } from "./pdf-generator";

interface PresentationInfo {
  id: string;
  title: string;
  duration_seconds: number;
}

interface RecapScreenProps {
  presentation: PresentationInfo;
  quizResults: QuizResult[];
  qaHistory: QAEntry[];
  onRestart: () => void;
}

export function RecapScreen({
  presentation,
  quizResults,
  qaHistory,
  onRestart,
}: RecapScreenProps) {
  const score = useMemo(() => {
    if (quizResults.length === 0) return null;
    const correct = quizResults.filter((r) => r.correct).length;
    return { correct, total: quizResults.length, pct: Math.round((correct / quizResults.length) * 100) };
  }, [quizResults]);

  const handleDownloadPdf = () => {
    generateRecapPdf({
      title: presentation.title,
      quizResults,
      qaHistory,
      score,
    });
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 lg:px-12">
      <header className="mb-8 text-center">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
          Session Complete
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-foreground">
          {presentation.title}
        </h1>
      </header>

      {/* Score ring */}
      {score && (
        <div className="mb-8 flex flex-col items-center">
          <ScoreRing pct={score.pct} size={140} />
          <p className="mt-3 text-sm text-muted-foreground">
            {score.correct} / {score.total} questions correct
          </p>
        </div>
      )}

      {/* Quiz results */}
      {quizResults.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Quiz Results
          </h2>
          <div className="space-y-2">
            {quizResults.map((r, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  r.correct
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-destructive/30 bg-destructive/5"
                }`}
              >
                {r.correct ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{r.question}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{r.explanation}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Q&A transcript */}
      {qaHistory.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">
              Questions Asked
            </h2>
            <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs text-amber-400">
              <FileText className="h-3 w-3" />
              Notes saved
            </span>
          </div>
          <div className="space-y-3">
            {qaHistory.map((qa, i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start gap-2">
                  <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {qa.question}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-3">
                      {qa.answer}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Actions */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onRestart}
          className="flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-muted"
        >
          <RotateCcw className="h-4 w-4" />
          Watch Again
        </button>
        {(quizResults.length > 0 || qaHistory.length > 0) && (
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" />
            Download PDF Recap
          </button>
        )}
      </div>
    </main>
  );
}
