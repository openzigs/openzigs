"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
};

type ApprovalRequest = {
  id: string;
  tool: string;
  explanation?: string;
  preview?: string;
  args?: Record<string, unknown>;
};

export const ChatView = () => {
  const { socket, connected } = useSocket();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [fallbackWarning, setFallbackWarning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<{ id: string; content: string } | null>(null);
  const inputStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const msgCounter = useRef(0);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const nextId = useCallback(() => {
    msgCounter.current += 1;
    return `msg-${msgCounter.current}`;
  }, []);

  const clearStuckTimer = useCallback(() => {
    if (inputStuckTimerRef.current) {
      clearTimeout(inputStuckTimerRef.current);
      inputStuckTimerRef.current = null;
    }
  }, []);

  const finalizeStream = useCallback(() => {
    clearStuckTimer();
    if (streamRef.current) {
      streamRef.current = null;
      setSending(false);
    }
  }, [clearStuckTimer]);

  // Load models
  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchJson<{ models: ModelInfo[]; selectedModel?: string; fallback?: boolean }>("/api/models");
        setModels(data.models ?? []);
        if (data.selectedModel) setSelectedModel(data.selectedModel);
        if (data.fallback) setFallbackWarning(true);
      } catch {
        // Models not available
      }
    };
    void load();
  }, []);

  // Socket events
  useEffect(() => {
    if (!socket) return;

    const onConnected = (data: { chatId: string }) => {
      setChatId(data.chatId);
    };

    const onResponse = (data: { content?: string }) => {
      finalizeStream();
      if (data.content) {
        setMessages((prev) => [...prev, { id: `msg-${Date.now()}`, role: "assistant", content: data.content! }]);
      }
    };

    const onStream = (data: { chunk: string }) => {
      if (!streamRef.current) {
        const id = `stream-${Date.now()}`;
        streamRef.current = { id, content: "" };
        setMessages((prev) => [...prev, { id, role: "assistant", content: "" }]);
      }
      streamRef.current.content += data.chunk;
      const currentContent = streamRef.current.content;
      const currentId = streamRef.current.id;
      setMessages((prev) =>
        prev.map((m) => (m.id === currentId ? { ...m, content: currentContent } : m))
      );
    };

    const onStreamEnd = () => {
      finalizeStream();
    };

    const onError = (data: { error?: string }) => {
      finalizeStream();
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "error", content: data.error ?? "An error occurred" },
      ]);
      setSending(false);
    };

    const onApprovalRequest = (data: ApprovalRequest) => {
      setPendingApproval(data);
    };

    socket.on("chat:connected", onConnected);
    socket.on("chat:response", onResponse);
    socket.on("chat:stream", onStream);
    socket.on("chat:stream:end", onStreamEnd);
    socket.on("chat:error", onError);
    socket.on("approval:request", onApprovalRequest);

    return () => {
      socket.off("chat:connected", onConnected);
      socket.off("chat:response", onResponse);
      socket.off("chat:stream", onStream);
      socket.off("chat:stream:end", onStreamEnd);
      socket.off("chat:error", onError);
      socket.off("approval:request", onApprovalRequest);
    };
  }, [socket, finalizeStream]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !chatId || !socket) return;

    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text }]);
    socket.emit("chat:message", { content: text, model: selectedModel || undefined });
    setInput("");
    setSending(true);

    clearStuckTimer();
    inputStuckTimerRef.current = setTimeout(() => {
      if (sending) {
        finalizeStream();
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "error", content: "No response received — the Copilot SDK may be unavailable. Check server logs." },
        ]);
        setSending(false);
      }
    }, 30_000);
  }, [input, chatId, socket, selectedModel, sending, nextId, clearStuckTimer, finalizeStream]);

  const handleApprovalResponse = useCallback(
    (approved: boolean) => {
      if (pendingApproval && socket) {
        socket.emit("approval:response", { approvalId: pendingApproval.id, approved });
        setPendingApproval(null);
      }
    },
    [pendingApproval, socket]
  );

  const handleModelChange = useCallback(async (modelId: string) => {
    setSelectedModel(modelId);
    try {
      await fetchJson("/api/models/select", {
        method: "POST",
        body: JSON.stringify({ modelId }),
      });
    } catch {
      // Silently fail
    }
  }, []);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    }
  }, []);

  const disabled = !chatId || sending;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-ink/10 bg-stone/95 px-5 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold text-ink">OpenZigs</h1>
        <div className="ml-auto flex items-center gap-3">
          <label htmlFor="model-select" className="text-xs text-ink/60">
            Model
          </label>
          <select
            id="model-select"
            className="rounded-lg border border-ink/10 bg-white/80 px-3 py-1.5 font-mono text-xs text-ink"
            value={selectedModel}
            onChange={(e) => void handleModelChange(e.target.value)}
            disabled={models.length === 0}
          >
            {models.length === 0 && <option value="">Loading…</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <span
            className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-moss" : "bg-ember"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
        </div>
      </header>

      {/* Fallback warning */}
      {fallbackWarning && (
        <div className="border-b border-amber-600/30 bg-amber-900/10 px-5 py-2 text-center text-xs text-amber-700">
          Copilot SDK unavailable — using fallback model list. Update your Copilot CLI to v0.0.394+ for full functionality.
        </div>
      )}

      {/* Messages */}
      <main className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              msg.role === "user"
                ? "self-end bg-tide text-white"
                : msg.role === "error"
                  ? "self-center border border-ember/40 bg-transparent text-xs text-ember"
                  : "self-start bg-ink/5 text-ink"
            }`}
          >
            {msg.content}
            {msg.role === "assistant" && streamRef.current?.id === msg.id && (
              <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-tide align-text-bottom" />
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </main>

      {/* Input */}
      <footer className="border-t border-ink/10 bg-stone/95 px-5 py-3 backdrop-blur">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-xl border border-ink/10 bg-white/80 px-4 py-2.5 text-sm text-ink placeholder:text-ink/40 focus:border-tide focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Type a message…"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={disabled}
          />
          <button
            type="submit"
            className="rounded-xl bg-tide px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={disabled || !input.trim()}
          >
            Send
          </button>
        </form>
      </footer>

      {/* Approval overlay */}
      {pendingApproval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-stone p-6 shadow-panel">
            <h3 className="mb-3 text-base font-semibold text-ink">Tool Approval Required</h3>
            <p className="mb-1 font-mono text-sm text-tide">{pendingApproval.tool}</p>
            {pendingApproval.explanation && (
              <p className="mb-3 text-sm text-ink/60">{pendingApproval.explanation}</p>
            )}
            <pre className="mb-4 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-ink/10 bg-white/60 p-3 font-mono text-xs text-ink/60">
              {pendingApproval.preview ??
                JSON.stringify(pendingApproval.args, null, 2)}
            </pre>
            <div className="flex justify-end gap-3">
              <button
                className="rounded-xl bg-moss px-5 py-2 text-sm font-semibold text-white"
                onClick={() => handleApprovalResponse(true)}
              >
                Approve
              </button>
              <button
                className="rounded-xl border border-ink/20 px-5 py-2 text-sm font-semibold text-ink"
                onClick={() => handleApprovalResponse(false)}
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
