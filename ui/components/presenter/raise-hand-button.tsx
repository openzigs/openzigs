"use client";

import { Hand } from "lucide-react";

export function RaiseHandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Raise Hand — Ask a question"
      className="absolute bottom-4 right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-110 hover:shadow-xl"
    >
      <Hand className="h-5 w-5" />
    </button>
  );
}
