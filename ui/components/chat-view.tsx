"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ToastContainer } from "@/components/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Send, Loader2, Bot, User, AlertCircle } from "lucide-react";
import { ChatMarkdown } from "@/components/chat-markdown";
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
  const [thinking, setThinking] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [fallbackWarning, setFallbackWarning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftInput, setDraftInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<{ id: string; content: string } | null>(null);
  const inputStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const msgCounter = useRef(0);
  const HISTORY_KEY = "openzigs:chat-history";
  const MAX_HISTORY = 100;

  // Load history from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (Array.isArray(parsed)) setHistory(parsed.slice(-MAX_HISTORY));
      }
    } catch {
      // Ignore corrupt localStorage
    }
  }, []);

  // Persist history on change
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
    } catch {
      // localStorage full or unavailable
    }
  }, [history]);

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
    }
    setSending(false);
    setThinking(false);
    setActiveTool(null);
  }, [clearStuckTimer]);

  /** Reset the stuck timer — call on every inbound event to keep it alive during long tool executions. */
  const resetStuckTimer = useCallback(() => {
    clearStuckTimer();
    inputStuckTimerRef.current = setTimeout(() => {
      finalizeStream();
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "error", content: "No response received — the Copilot SDK may be unavailable. Check server logs." },
      ]);
    }, 300_000); // 5 minutes — browser automation and multi-step tool chains can take a while
  }, [clearStuckTimer, finalizeStream]);

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
      // Any stream chunk = work is happening, reset the stuck timer
      resetStuckTimer();
      setThinking(false);
      setActiveTool(null);

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
    };

    const onApprovalRequest = (data: ApprovalRequest) => {
      resetStuckTimer();
      setThinking(false);
      setPendingApproval(data);
    };

    const onToolCall = (data: { tool: string }) => {
      // A tool is executing — reset the stuck timer so we don't time out during long operations
      resetStuckTimer();
      setActiveTool(data.tool);
    };

    const onDisconnected = () => {
      setChatId(null);
      finalizeStream();
    };

    socket.on("chat:connected", onConnected);
    socket.on("chat:response", onResponse);
    socket.on("chat:stream", onStream);
    socket.on("chat:stream:end", onStreamEnd);
    socket.on("chat:error", onError);
    socket.on("chat:tool_call", onToolCall);
    socket.on("approval:request", onApprovalRequest);
    socket.on("disconnect", onDisconnected);

    return () => {
      socket.off("chat:connected", onConnected);
      socket.off("chat:response", onResponse);
      socket.off("chat:stream", onStream);
      socket.off("chat:stream:end", onStreamEnd);
      socket.off("chat:error", onError);
      socket.off("chat:tool_call", onToolCall);
      socket.off("approval:request", onApprovalRequest);
      socket.off("disconnect", onDisconnected);
    };
  }, [socket, finalizeStream, resetStuckTimer]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, thinking, scrollToBottom]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !socket || sending || !connected) return;

    // If not yet connected, show a warning instead of silently failing
    if (!chatId) {
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "error", content: "Waiting for server connection. Please try again in a moment." },
      ]);
      return;
    }

    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text }]);
    socket.emit("chat:message", { content: text, model: selectedModel || undefined });
    setInput("");
    setSending(true);
    setThinking(true);
    // Push to history
    setHistory((prev) => [...prev.slice(-(MAX_HISTORY - 1)), text]);
    setHistoryIndex(-1);
    setDraftInput("");

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // Start the stuck timer — will be reset on every stream chunk or tool-call event
    resetStuckTimer();
  }, [input, chatId, socket, selectedModel, sending, connected, nextId, resetStuckTimer]);

  const handleApprovalResponse = useCallback(
    (approved: boolean) => {
      if (pendingApproval && socket) {
        socket.emit("approval:response", { approvalId: pendingApproval.id, approved });
        setPendingApproval(null);
        setThinking(true);
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
      el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
    }
  }, []);

  // Allow sending while connected to socket, show connecting state if no chatId yet
  const inputDisabled = sending;
  const showConnecting = connected && !chatId;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-border bg-card px-5 py-3">
        <h1 className="text-lg font-semibold text-foreground">OpenZigs</h1>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Model</span>
          <Select
            value={selectedModel}
            onValueChange={(value) => void handleModelChange(value)}
            disabled={models.length === 0}
          >
            <SelectTrigger className="h-8 w-48 font-mono text-xs">
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                  {m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full transition-colors",
              connected ? "bg-moss" : "bg-destructive"
            )}
            title={connected ? "Connected" : "Disconnected"}
          />
        </div>
      </header>

      {/* Fallback warning */}
      {fallbackWarning && (
        <div className="border-b border-amber-600/30 bg-amber-500/10 px-5 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
          Copilot SDK unavailable — using fallback model list. Update your Copilot CLI to v0.0.394+ for full functionality.
        </div>
      )}

      {/* Connecting indicator */}
      {showConnecting && (
        <div className="border-b border-primary/20 bg-primary/5 px-5 py-2 text-center text-xs text-primary">
          <Loader2 className="mr-1.5 inline-block h-3 w-3 animate-spin" />
          Connecting to server…
        </div>
      )}

      {/* Messages */}
      <main className="min-h-0 flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        {messages.length === 0 && !thinking && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Bot className="h-12 w-12 opacity-30" />
            <p className="text-sm">Send a message to start chatting with OpenZigs.</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex items-start gap-3 animate-slide-in",
              msg.role === "user" && "flex-row-reverse"
            )}
          >
            {/* Avatar */}
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : msg.role === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground"
              )}
            >
              {msg.role === "user" ? (
                <User className="h-4 w-4" />
              ) : msg.role === "error" ? (
                <AlertCircle className="h-4 w-4" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
            </div>
            {/* Bubble */}
            <div
              className={cn(
                "max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
                msg.role === "user"
                  ? "whitespace-pre-wrap bg-primary text-primary-foreground"
                  : msg.role === "error"
                    ? "whitespace-pre-wrap border border-destructive/30 bg-destructive/5 text-destructive text-xs"
                    : "bg-muted text-foreground"
              )}
            >
              {msg.role === "assistant" ? (
                <ChatMarkdown
                  content={msg.content}
                  isStreaming={streamRef.current?.id === msg.id}
                />
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}

        {/* Thinking indicator */}
        {thinking && (
          <div className="flex items-start gap-3 animate-slide-in">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-1 rounded-2xl bg-muted px-4 py-3">
              {activeTool ? <ToolProgress tool={activeTool} /> : <ThinkingDots />}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* Input */}
      <footer className="border-t border-border bg-card px-5 py-4">
        <form
          className="mx-auto flex max-w-3xl items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              className="w-full resize-none rounded-xl border border-input bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={
                !connected
                  ? "Connecting…"
                  : showConnecting
                    ? "Almost ready…"
                    : "Type a message… (Shift+Enter for new line)"
              }
              rows={2}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                  return;
                }
                // History navigation: only when cursor is at position 0 or input is empty
                const el = textareaRef.current;
                const atStart = !el || el.selectionStart === 0;
                if (e.key === "ArrowUp" && (atStart || !input)) {
                  e.preventDefault();
                  if (history.length === 0) return;
                  if (historyIndex === -1) {
                    // Entering history mode — save current draft
                    setDraftInput(input);
                    const idx = history.length - 1;
                    setHistoryIndex(idx);
                    setInput(history[idx]);
                  } else if (historyIndex > 0) {
                    const idx = historyIndex - 1;
                    setHistoryIndex(idx);
                    setInput(history[idx]);
                  }
                  return;
                }
                if (e.key === "ArrowDown" && historyIndex >= 0) {
                  e.preventDefault();
                  if (historyIndex < history.length - 1) {
                    const idx = historyIndex + 1;
                    setHistoryIndex(idx);
                    setInput(history[idx]);
                  } else {
                    // Past the end — restore draft
                    setHistoryIndex(-1);
                    setInput(draftInput);
                  }
                  return;
                }
                if (e.key === "Escape" && historyIndex >= 0) {
                  e.preventDefault();
                  setHistoryIndex(-1);
                  setInput(draftInput);
                }
              }}
              disabled={inputDisabled}
              style={{ maxHeight: "300px" }}
            />
          </div>
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-xl"
            disabled={inputDisabled || !input.trim() || !chatId || !connected}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </form>
      </footer>

      {/* Approval dialog */}
      <Dialog open={!!pendingApproval} onOpenChange={(open) => !open && handleApprovalResponse(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tool Approval Required</DialogTitle>
            <DialogDescription>
              The assistant wants to use a tool that requires your approval.
            </DialogDescription>
          </DialogHeader>
          {pendingApproval && (
            <div className="space-y-3">
              <p className="font-mono text-sm text-primary">{pendingApproval.tool}</p>
              {pendingApproval.explanation && (
                <p className="text-sm text-muted-foreground">{pendingApproval.explanation}</p>
              )}
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">
                {pendingApproval.preview ??
                  JSON.stringify(pendingApproval.args, null, 2)}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => handleApprovalResponse(false)}>
              Deny
            </Button>
            <Button onClick={() => handleApprovalResponse(true)}>
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      <ToastContainer />
    </>
  );
};

/** Animated thinking dots — mimics the GitHub Copilot thinking indicator */
const ThinkingDots = () => (
  <div className="flex items-center gap-1">
    <span className="text-xs text-muted-foreground">Thinking</span>
    <span className="flex gap-0.5">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
    </span>
  </div>
);

/** Shows the active tool name with a pulsing indicator */
const ToolProgress = ({ tool }: { tool: string }) => (
  <div className="flex items-center gap-2">
    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
    <span className="text-xs text-muted-foreground">
      Using <span className="font-mono">{tool}</span>
    </span>
  </div>
);
