"use client";

import { useCallback, useEffect, useState } from "react";

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type Toast = {
  id: string;
  message: string;
  type: "info" | "success" | "error";
  action?: ToastAction;
  /** ms before auto-dismiss; 0 means stay until clicked. Default 4000. */
  durationMs?: number;
};

let toastCounter = 0;
const listeners: Set<(toast: Toast) => void> = new Set();

export type ShowToastOptions = {
  type?: Toast["type"];
  action?: ToastAction;
  durationMs?: number;
};

/** Imperatively push a toast from anywhere. */
export function showToast(
  message: string,
  typeOrOpts: Toast["type"] | ShowToastOptions = "info",
) {
  toastCounter += 1;
  const opts: ShowToastOptions =
    typeof typeOrOpts === "string" ? { type: typeOrOpts } : typeOrOpts;
  const toast: Toast = {
    id: String(toastCounter),
    message,
    type: opts.type ?? "info",
    action: opts.action,
    durationMs: opts.durationMs,
  };
  for (const listener of listeners) {
    listener(toast);
  }
}

/** Sidecar error toast that attaches a Restart CTA on gateway statuses. */
export function showSidecarErrorToast(
  message: string,
  options: {
    sidecarName?: string;
    status?: number;
    apiBase?: string;
    apiToken?: string;
  } = {},
) {
  const { sidecarName, status, apiBase = "", apiToken } = options;
  const canRestart =
    Boolean(sidecarName) &&
    (status === 502 || status === 503 || status === 504);

  if (!canRestart) {
    showToast(message, "error");
    return;
  }

  showToast(message, {
    type: "error",
    durationMs: 8000,
    action: {
      label: "Restart sidecar",
      onClick: async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
        try {
          const res = await fetch(
            `${apiBase}/api/admin/ai-sidecars/${encodeURIComponent(sidecarName!)}/restart`,
            { method: "POST", headers },
          );
          if (!res.ok) {
            showToast(`Failed to restart ${sidecarName}`, "error");
            return;
          }
          showToast(`Restarted ${sidecarName}`, "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`Restart failed: ${msg}`, "error");
        }
      },
    },
  });
}

const typeStyles: Record<Toast["type"], string> = {
  info: "bg-primary text-primary-foreground",
  success: "bg-moss text-white",
  error: "bg-destructive text-destructive-foreground",
};

export const ToastContainer = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toast: Toast) => {
      setToasts((prev) => [...prev, toast]);
      const ttl = toast.durationMs ?? 4000;
      if (ttl > 0) {
        setTimeout(() => dismiss(toast.id), ttl);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    listeners.add(addToast);
    return () => {
      listeners.delete(addToast);
    };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-lg animate-slide-in ${typeStyles[toast.type]}`}
        >
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              onClick={async () => {
                try {
                  await toast.action!.onClick();
                } finally {
                  dismiss(toast.id);
                }
              }}
              className="rounded-md bg-white/20 px-2 py-1 text-xs font-semibold uppercase tracking-wide hover:bg-white/30"
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};
