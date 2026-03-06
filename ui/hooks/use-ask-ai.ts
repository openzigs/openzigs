"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import type { PageContext } from "@/components/ask-ai/page-contexts";

export type AskAiMessage = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
};

export type UseAskAiOptions = {
  pageContext: PageContext;
  model: string;
  reasoningEffort?: string;
};

/**
 * Lightweight chat hook for the Ask AI side panel.
 * Reuses the global Socket.IO connection but maintains its own message list.
 * Prepends page context to the first user message so the LLM
 * understands the screen.
 */
export function useAskAi({ pageContext, model, reasoningEffort }: UseAskAiOptions) {
  const { socket, connected } = useSocket();
  const [messages, setMessages] = useState<AskAiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const streamRef = useRef<{ id: string; content: string } | null>(null);
  const contextSentRef = useRef(false);
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgCounter = useRef(0);

  const nextId = useCallback(() => `ask-ai-${++msgCounter.current}`, []);

  const clearStuckTimer = useCallback(() => {
    if (stuckTimerRef.current) {
      clearTimeout(stuckTimerRef.current);
      stuckTimerRef.current = null;
    }
  }, []);

  const finalizeStream = useCallback(() => {
    clearStuckTimer();
    streamRef.current = null;
    setSending(false);
    setThinking(false);
  }, [clearStuckTimer]);

  const resetStuckTimer = useCallback(() => {
    clearStuckTimer();
    stuckTimerRef.current = setTimeout(() => {
      finalizeStream();
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "error", content: "No response received. Check server logs." },
      ]);
    }, 120_000);
  }, [clearStuckTimer, finalizeStream]);

  // Listen for socket events
  useEffect(() => {
    if (!socket) return;

    const onStream = (data: { chunk: string }) => {
      resetStuckTimer();
      setThinking(false);
      if (!streamRef.current) {
        const id = `stream-${Date.now()}`;
        streamRef.current = { id, content: "" };
        setMessages((prev) => [...prev, { id, role: "assistant", content: "" }]);
      }
      streamRef.current.content += data.chunk;
      const currentContent = streamRef.current.content;
      const currentId = streamRef.current.id;
      setMessages((prev) =>
        prev.map((m) => (m.id === currentId ? { ...m, content: currentContent } : m)),
      );
    };

    const onStreamEnd = () => finalizeStream();
    const onResponse = (data: { content?: string }) => {
      finalizeStream();
      if (data.content) {
        setMessages((prev) => [...prev, { id: `msg-${Date.now()}`, role: "assistant", content: data.content! }]);
      }
    };
    const onError = (data: { error?: string }) => {
      finalizeStream();
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "error", content: data.error ?? "An error occurred" },
      ]);
    };
    const onToolCall = () => resetStuckTimer();

    socket.on("chat:stream", onStream);
    socket.on("chat:stream:end", onStreamEnd);
    socket.on("chat:response", onResponse);
    socket.on("chat:error", onError);
    socket.on("chat:tool-call", onToolCall);

    return () => {
      socket.off("chat:stream", onStream);
      socket.off("chat:stream:end", onStreamEnd);
      socket.off("chat:response", onResponse);
      socket.off("chat:error", onError);
      socket.off("chat:tool-call", onToolCall);
    };
  }, [socket, resetStuckTimer, finalizeStream]);

  // Cleanup on unmount
  useEffect(() => () => clearStuckTimer(), [clearStuckTimer]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !socket || sending || !connected) return;

      // Prepend page context to the first message in this panel session
      let content = trimmed;
      if (!contextSentRef.current) {
        content = `[PAGE CONTEXT — I am currently on the ${pageContext.label} screen]\n${pageContext.systemContext}\n\n---\nUser question: ${trimmed}`;
        contextSentRef.current = true;
      }

      setMessages((prev) => [...prev, { id: nextId(), role: "user", content: trimmed }]);
      socket.emit("chat:message", {
        content,
        model: model || undefined,
        reasoningEffort: reasoningEffort && reasoningEffort !== "medium" ? reasoningEffort : undefined,
      });
      setSending(true);
      setThinking(true);
      resetStuckTimer();
    },
    [socket, sending, connected, model, reasoningEffort, pageContext, nextId, resetStuckTimer],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    contextSentRef.current = false;
    finalizeStream();
  }, [finalizeStream]);

  return { messages, sending, thinking, sendMessage, clearMessages, connected };
}
