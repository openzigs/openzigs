"use client";

import { Hand } from "lucide-react";

export function RaiseHandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Raise Hand — Ask a question"
      className="absolute right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-110 hover:shadow-xl md:bottom-4"
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <Hand className="h-5 w-5" />
    </button>
  );
}
