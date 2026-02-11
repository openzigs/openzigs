"use client";

import { X } from "lucide-react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog = ({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => (
  <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onCancel}>
    <div
      className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
      onClick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-label={title}
    >
      <button
        onClick={onCancel}
        className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </button>

      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      <p className="mb-5 text-xs text-muted-foreground">{message}</p>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          className={`rounded-lg px-4 py-2 text-xs font-semibold text-white ${
            variant === "danger"
              ? "bg-destructive hover:bg-destructive/90"
              : "bg-primary hover:bg-primary/90"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);
