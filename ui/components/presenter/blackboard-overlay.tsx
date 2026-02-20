"use client";

import { useState, useRef, useCallback } from "react";
import { Send, X, Play, Mic, MicOff, FileText } from "lucide-react";
import { MermaidBlock } from "./mermaid-block";
import ReactMarkdown from "react-markdown";

interface BlackboardOverlayProps {
  question: string | null;
  answerTokens: string;
  isAnswering: boolean;
  isDone: boolean;
  noteSaved: boolean;
  onAsk: (question: string) => void;
  onResume: () => void;
  onTranscribe: (audioBlob: Blob) => Promise<string | null>;
  /** Called when user wants to ask a follow-up after getting an answer */
  onFollowUp?: () => void;
  /** Live transcription from the voice pipe — populates input for user review */
  voiceTranscription?: string | null;
  /** Socket ID of the person who asked (room mode only) */
  askedBy?: string;
  /** The question text asked by another participant (room mode only) */
  askedQuestion?: string;
}

export function BlackboardOverlay({
  question,
  answerTokens,
  isAnswering,
  isDone,
  noteSaved,
  onAsk,
  onResume,
  onTranscribe,
  onFollowUp,
  voiceTranscription,
  askedBy,
  askedQuestion,
}: BlackboardOverlayProps) {
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const prevTranscriptionRef = useRef<string | null>(null);

  // When voice pipe produces a new transcription, populate the input for user review
  if (voiceTranscription && voiceTranscription !== prevTranscriptionRef.current) {
    prevTranscriptionRef.current = voiceTranscription;
    setInput(voiceTranscription);
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    onAsk(trimmed);
    setInput("");
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size > 0) {
          setIsTranscribing(true);
          try {
            const text = await onTranscribe(blob);
            if (text && text.trim()) {
              setInput(text.trim());
            }
          } finally {
            setIsTranscribing(false);
          }
        }
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      // Mic permission denied — text input still available
    }
  }, [onTranscribe, onAsk]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const showInput = !question && !isTranscribing;

  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center">
      <div className="flex w-full max-h-[85dvh] flex-col rounded-t-2xl border border-white/10 bg-[#1a1a2e] shadow-xl sm:mx-4 sm:max-w-2xl sm:rounded-2xl">
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

        {/* Notes indicator */}
        <div className="flex items-center gap-2 border-b border-white/5 bg-amber-500/10 px-5 py-2">
          <FileText className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-xs text-amber-300/90">
            {noteSaved
              ? "Notes saved — available in your session recap and for download."
              : "Notes are being taken for this Q&A session. They'll be available when you're done."}
          </span>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4" style={{ maxHeight: "50dvh" }}>
          {/* Question attribution banner (room mode) */}
          {askedBy && askedQuestion && (
            <div className="mb-3 rounded-lg border border-white/10 bg-indigo-500/10 px-4 py-2">
              <p className="text-sm text-white/90">
                💬 &ldquo;{askedQuestion}&rdquo;
              </p>
              <p className="mt-0.5 text-[10px] text-white/40">
                Asked by Guest
              </p>
            </div>
          )}

          {!question && !answerTokens && !isTranscribing && !askedQuestion && (
            <p className="text-sm text-white/50">
              Type your question below, or tap the microphone to speak.
            </p>
          )}

          {isTranscribing && (
            <div className="flex items-center gap-3 text-sm text-white/60">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
              Transcribing your question…
            </div>
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
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  onClick={() => onFollowUp?.()}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10"
                >
                  <Send className="h-4 w-4" />
                  Ask Another Question
                </button>
                <button
                  onClick={onResume}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  <Play className="h-4 w-4" />
                  Resume
                </button>
              </div>
            </div>
          ) : showInput ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
                    isRecording
                      ? "animate-pulse bg-red-500 text-white"
                      : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                  title={isRecording ? "Stop recording" : "Start recording"}
                >
                  {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                <form onSubmit={handleSubmit} className="flex flex-1 gap-2">
                  <input
                    type="text"
                    placeholder={isTranscribing ? "Transcribing…" : isRecording ? "Listening… tap mic to stop" : "Ask anything about this topic…"}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="flex-1 rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm text-white placeholder:text-white/30 focus:border-primary focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    className="rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </div>
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
