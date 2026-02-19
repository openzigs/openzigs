"use client";

import { useState } from "react";
import { Send, X, Play } from "lucide-react";
import { MermaidBlock } from "./mermaid-block";
import ReactMarkdown from "react-markdown";

interface BlackboardOverlayProps {
  question: string | null;
  answerTokens: string;
  isAnswering: boolean;
  isDone: boolean;
  onAsk: (question: string) => void;
  onResume: () => void;
}

export function BlackboardOverlay({
  question,
  answerTokens,
  isAnswering,
  isDone,
  onAsk,
  onResume,
}: BlackboardOverlayProps) {
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    onAsk(trimmed);
    setInput("");
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="mx-4 flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-[#1a1a2e] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h3 className="text-sm font-semibold text-white">
            🎓 Blackboard — Ask a Question
          </h3>
          <button
            onClick={onResume}
            className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            title="Resume video"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ maxHeight: "50vh" }}>
          {!question && !answerTokens && (
            <p className="text-sm text-white/50">
              Type your question below — the Teacher Agent will explain using the
              presentation content.
            </p>
          )}

          {question && (
            <div className="mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                Your Question
              </p>
              <p className="mt-1 text-sm text-white">{question}</p>
            </div>
          )}

          {(answerTokens || isAnswering) && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                Teacher Agent
              </p>
              {answerTokens ? (
                <BlackboardContent content={answerTokens} />
              ) : (
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                  Thinking…
                </div>
              )}
            </div>
          )}
        </div>

        {/* Input / Resume */}
        <div className="border-t border-white/10 px-5 py-3">
          {isDone ? (
            <button
              onClick={onResume}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Play className="h-4 w-4" />
              Resume Video
            </button>
          ) : !question ? (
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                type="text"
                placeholder="Ask anything about this topic…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="flex-1 rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-primary focus:outline-none"
                autoFocus
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-xl bg-primary px-4 py-2.5 text-primary-foreground disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders streaming markdown with Mermaid diagram support.
 * Detects ```mermaid code blocks and renders them as SVG diagrams.
 */
function BlackboardContent({ content }: { content: string }) {
  // Split content into segments: text and mermaid blocks
  const segments = splitMermaidBlocks(content);

  return (
    <div className="prose prose-sm prose-invert max-w-none text-white/90">
      {segments.map((seg, i) =>
        seg.type === "mermaid" ? (
          <MermaidBlock key={i} definition={seg.content} />
        ) : (
          <ReactMarkdown key={i}>{seg.content}</ReactMarkdown>
        ),
      )}
    </div>
  );
}

function splitMermaidBlocks(
  text: string,
): Array<{ type: "text" | "mermaid"; content: string }> {
  const result: Array<{ type: "text" | "mermaid"; content: string }> = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    result.push({ type: "mermaid", content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ type: "text", content: text.slice(lastIndex) });
  }

  return result;
}
