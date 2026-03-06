"use client";

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { Bot, Send, Loader2, Trash2, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatMarkdown } from "@/components/chat-markdown";
import { InlineModelPicker } from "@/components/model-picker-select";
import { useAskAi, type AskAiMessage } from "@/hooks/use-ask-ai";
import type { PageContext } from "./page-contexts";

type AskAiPanelProps = {
  pageContext: PageContext;
  open: boolean;
  onClose: () => void;
};

export function AskAiPanel({ pageContext, open, onClose }: AskAiPanelProps) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sending, thinking, sendMessage, clearMessages, connected } = useAskAi({
    pageContext,
    model,
  });

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open]);

  const handleSend = useCallback(() => {
    if (!input.trim() || sending) return;
    sendMessage(input);
    setInput("");
  }, [input, sending, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleStarter = useCallback(
    (question: string) => {
      if (sending) return;
      sendMessage(question);
    },
    [sending, sendMessage],
  );

  return (
    <div
      className={cn(
        "fixed right-0 top-0 z-50 flex h-full w-[380px] flex-col border-l border-border bg-background shadow-2xl transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{pageContext.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearMessages}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Clear conversation"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Model Selector ── */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">Model:</span>
        <InlineModelPicker value={model} onChange={setModel} className="flex-1" />
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="space-y-4 pt-4">
            <div className="text-center">
              <Bot className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground">
                Ask me anything about this page
              </p>
            </div>
            {/* Starter questions */}
            <div className="space-y-2">
              {pageContext.starters.map((q) => (
                <button
                  key={q}
                  onClick={() => handleStarter(q)}
                  disabled={sending || !connected}
                  className="w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {thinking && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Thinking…</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input ── */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? "Ask a question…" : "Connecting…"}
            disabled={!connected}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            style={{ maxHeight: 120 }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending || !connected}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Floating Ask AI Button ── */

export function AskAiButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors",
        className,
      )}
    >
      <Sparkles className="h-3.5 w-3.5" />
      Ask AI
    </button>
  );
}

/* ── Message Bubble ── */

function MessageBubble({ message }: { message: AskAiMessage }) {
  if (message.role === "error") {
    return (
      <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {isUser ? "U" : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser ? "bg-primary/10 text-foreground" : "bg-muted/50 text-foreground",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ChatMarkdown content={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}
