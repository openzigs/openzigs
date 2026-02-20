"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface SlideDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Title shown in the drawer header */
  title: string;
  children: ReactNode;
  /** Which side the drawer slides from. Defaults to "right". */
  side?: "left" | "right";
}

/**
 * A slide-out drawer that works as a sidebar on desktop (lg+) and
 * as a bottom sheet / side panel on mobile/tablet. Used for the
 * chapter list and participant panel on the presenter page.
 */
export function SlideDrawer({
  open,
  onClose,
  title,
  children,
  side = "right",
}: SlideDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Trap focus and handle Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Prevent body scroll on mobile when drawer is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const translateClass =
    side === "right"
      ? open
        ? "translate-x-0"
        : "translate-x-full"
      : open
        ? "translate-x-0"
        : "-translate-x-full";

  const positionClass =
    side === "right" ? "right-0" : "left-0";

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={title}
        className={`fixed top-0 ${positionClass} z-50 flex h-full w-[85vw] max-w-xs flex-col border-l border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-xl transition-transform duration-300 ease-out lg:static lg:z-auto lg:w-72 lg:translate-x-0 lg:border-l lg:border-white/5 lg:shadow-none lg:backdrop-blur-none ${translateClass} ${!open ? "lg:hidden" : ""}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </>
  );
}
