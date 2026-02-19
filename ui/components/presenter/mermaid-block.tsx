"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let mermaidInitialized = false;

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily: "Inter, system-ui, sans-serif",
  });
  mermaidInitialized = true;
}

let counter = 0;

export function MermaidBlock({ definition }: { definition: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${++counter}`);

  useEffect(() => {
    if (!definition.trim()) return;
    initMermaid();

    let cancelled = false;

    void mermaid
      .render(idRef.current, definition)
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [definition]);

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">Diagram error: {error}</p>
        <pre className="mt-1 text-[10px] text-muted-foreground">{definition}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-3 flex items-center justify-center overflow-auto rounded-lg bg-white/5 p-2"
    />
  );
}
