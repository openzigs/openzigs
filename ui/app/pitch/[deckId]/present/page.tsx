"use client";

/**
 * Authenticated Present route (#1016).
 *
 * Wraps the deck's `/render?mode=present` HTML in a Next.js page that runs
 * inside the user's browser session, so the auth token rides as a Bearer
 * header (via `fetchWithAuth`) instead of being smuggled in the URL as
 * `?token=` (which leaked into browser history, Referer headers, and any
 * upstream proxy access logs — see #1011 for the original trade-off).
 *
 * Implementation: client component that fetches the embedded HTML on mount
 * and injects it into a sandboxed `<iframe srcDoc>`. We use the same
 * pattern as the deck-editor RevealCanvas component so the renderer's
 * inline `<script>` (Reveal.js init) and full-document chrome work
 * exactly as they do today — the only difference is how auth is carried.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { buildUrl, fetchWithAuth } from "@/lib/api";

async function fetchPresentHtml(deckId: string): Promise<string> {
  const url = buildUrl(`/api/admin/pitch/decks/${deckId}/render?mode=present`);
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    throw new Error(`render failed: ${res.status}`);
  }
  return res.text();
}

export default function PitchPresentPage() {
  const params = useParams<{ deckId: string }>();
  const deckId = params.deckId;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPresentHtml(deckId)
      .then((text) => {
        if (!cancelled) setHtml(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  if (error) {
    return (
      <main
        data-testid="pitch-present-error"
        className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100"
        role="alert"
      >
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Could not load deck</h1>
          <p className="mt-2 text-sm text-slate-400">{error}</p>
        </div>
      </main>
    );
  }

  if (html === null) {
    return (
      <main
        data-testid="pitch-present-loading"
        className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-300"
      >
        <p className="text-sm">Loading deck…</p>
      </main>
    );
  }

  return (
    <iframe
      data-testid="pitch-present-frame"
      title="Pitch deck presenter"
      srcDoc={html}
      // `allow-scripts` is required because the renderer ships an inline
      // Reveal.js init script. `allow-same-origin` lets that script reach
      // its own document storage. We deliberately do NOT add
      // `allow-top-navigation` so a malicious deck cannot break out.
      sandbox="allow-scripts allow-same-origin"
      className="h-screen w-screen border-0"
    />
  );
}
