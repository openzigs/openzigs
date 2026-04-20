"use client";

import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { useEffect, useRef, useState } from "react";

/** Monotonic counter so every render attempt gets a unique DOM id. */
let renderCounter = 0;

/**
 * DOMPurify configuration for Mermaid SVG output. Allows the SVG element set
 * Mermaid emits (paths, text, foreignObject for HTML labels) but strips any
 * `<script>` tags or event handler attributes that an attacker-controlled
 * Mermaid source could inject (sub-issue #901).
 */
const SANITIZER_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ["foreignObject"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
};

type MermaidDiagramProps = {
  /** Raw mermaid definition string (e.g. "graph TD\n  A-->B") */
  chart: string;
};

/**
 * Renders a mermaid diagram client-side using the mermaid library.
 * The library is dynamically imported on first render so it doesn't
 * bloat the initial bundle.
 *
 * To avoid DOM pollution during streaming, callers should only mount this
 * component once the chart text is finalized (i.e. streaming is complete).
 */
export const MermaidDiagram = ({ chart }: MermaidDiagramProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid_${++renderCounter}`;

    const render = async () => {
      try {
        const mermaid = (await import("mermaid")).default;

        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          // Sub-issue #901 — `loose` permits `<foreignObject>` HTML embedding
          // and click handlers in diagrams sourced from LLM/chat output. Use
          // `strict` and rely on DOMPurify (below) as a second layer.
          securityLevel: "strict",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        });

        // Create a temporary off-screen container for rendering so mermaid
        // doesn't pollute the visible DOM with error elements.
        const tempContainer = document.createElement("div");
        tempContainer.id = renderId;
        tempContainer.style.position = "absolute";
        tempContainer.style.left = "-9999px";
        tempContainer.style.top = "-9999px";
        document.body.appendChild(tempContainer);

        try {
          const sanitized = sanitizeMermaidChart(chart.trim());
          const { svg: rendered } = await mermaid.render(renderId, sanitized);
          if (!cancelled) {
            // Defence-in-depth: even with `securityLevel: 'strict'`, scrub the
            // rendered SVG with DOMPurify before injecting it into the DOM
            // (sub-issue #901).
            const cleanSvg = DOMPurify.sanitize(rendered, SANITIZER_CONFIG);
            setSvg(cleanSvg);
            setError(null);
          }
        } finally {
          // Always clean up the temp container + any mermaid error elements
          tempContainer.remove();
          cleanupMermaidErrors(renderId);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      }
    };

    render();
    return () => {
      cancelled = true;
      cleanupMermaidErrors(renderId);
    };
  }, [chart]);

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-ember/30 bg-ember/5 p-4">
        <p className="mb-2 text-xs font-medium text-ember">
          Mermaid diagram error
        </p>
        <pre className="overflow-x-auto text-xs text-muted-foreground whitespace-pre-wrap">
          {chart}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 flex items-center justify-center rounded-lg border border-border bg-muted/30 p-8">
        <span className="text-xs text-muted-foreground animate-pulse">
          Rendering diagram…
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-x-auto rounded-lg border border-border bg-white/5 p-4 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

/** Remove any mermaid-inserted error/temp elements from the DOM. */
function cleanupMermaidErrors(renderId: string): void {
  // Mermaid injects `<div id="d<renderId>">` for errors and temp SVGs
  const selectors = [
    `#${renderId}`,
    `#d${renderId}`,
    `[id^="d${renderId}"]`,
  ];
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // Ignore invalid selector errors
    }
  }
}

/**
 * Sanitize LLM-generated mermaid chart text to fix common syntax issues.
 *
 * Mermaid treats parentheses inside `[...]` as shape delimiters (e.g. `[A (B)]`
 * is parsed as stadium shape). LLMs frequently produce labels like
 * `SG[Security Group (stateful rules)]` which breaks the parser.
 *
 * Fix: wrap any bracket label containing `(` in double quotes so mermaid
 * treats it as a literal string — `SG["Security Group (stateful rules)"]`.
 *
 * Also handles edge labels `|...|` containing parentheses.
 */
function sanitizeMermaidChart(chart: string): string {
  // Quote bracket labels containing parentheses: [Label (stuff)] → ["Label (stuff)"]
  // Only if not already quoted.
  let result = chart.replace(
    /\[([^\]"]*\([^\]]*)\]/g,
    (_match, inner: string) => `["${inner}"]`,
  );

  // Quote edge labels containing special chars: |label (x)| → |"label (x)"|
  result = result.replace(
    /\|([^|"]*[()/][^|"]*)\|/g,
    (_match, inner: string) => `|"${inner}"|`,
  );

  return result;
}
