"use client";

import { useCallback, useEffect, useState } from "react";

export type Toast = {
  id: string;
  message: string;
  type: "info" | "success" | "error";
};

let toastCounter = 0;
const listeners: Set<(toast: Toast) => void> = new Set();

/** Imperatively push a toast from anywhere. */
export const showToast = (message: string, type: Toast["type"] = "info") => {
  toastCounter += 1;
  const toast: Toast = { id: String(toastCounter), message, type };
  for (const listener of listeners) {
    listener(toast);
  }
};

const typeStyles: Record<Toast["type"], string> = {
  info: "bg-primary text-primary-foreground",
  success: "bg-moss text-white",
  error: "bg-destructive text-destructive-foreground",
};

export const ToastContainer = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Toast) => {
    setToasts((prev) => [...prev, toast]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
    }, 4000);
  }, []);

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
          className={`rounded-xl px-4 py-3 text-sm font-medium shadow-lg animate-slide-in ${typeStyles[toast.type]}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};
