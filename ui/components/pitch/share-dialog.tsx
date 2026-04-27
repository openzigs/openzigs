"use client";

import { useEffect, useState } from "react";
import { Copy, Loader2, Share2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchJson } from "@/lib/api";

/**
 * Share-link dialog (Epic #990 / sub-issue #1000).
 *
 * Issues a public share token, displays the resulting `/p/<token>` URL,
 * and lets the user revoke any previously-issued tokens. Tokens are
 * never written to localStorage / cookies / URL fragments — they live
 * only in the React state for the duration of the dialog.
 */

interface ShareTokenView {
  token: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ListResponse {
  tokens: ShareTokenView[];
}

interface IssueResponse {
  token: string;
  url: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface ShareDialogProps {
  deckId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowToast?: (message: string, kind?: "success" | "error" | "info") => void;
  /** Override for the public-link host. Defaults to `window.location.origin`. */
  publicHost?: string;
}

function publicUrlFor(token: string, host?: string): string {
  if (typeof window === "undefined") return `/p/${token}`;
  return `${host ?? window.location.origin}/p/${token}`;
}

function formatRelative(now: number, ts: number): string {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export function ShareDialog({
  deckId,
  open,
  onOpenChange,
  onShowToast,
  publicHost,
}: ShareDialogProps) {
  const [tokens, setTokens] = useState<ShareTokenView[]>([]);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetchJson<ListResponse>(
        `/api/admin/pitch/decks/${deckId}/share`,
      );
      setTokens(Array.isArray(res?.tokens) ? res.tokens : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deckId]);

  const issue = async (): Promise<void> => {
    setIssuing(true);
    try {
      const res = await fetchJson<IssueResponse>(
        `/api/admin/pitch/decks/${deckId}/share`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const url = publicUrlFor(res.token, publicHost);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          onShowToast?.("Share link copied to clipboard", "success");
        } else {
          onShowToast?.("Share link created", "success");
        }
      } catch {
        onShowToast?.("Share link created", "success");
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onShowToast?.(`Failed to create share link: ${msg}`, "error");
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (token: string): Promise<void> => {
    try {
      await fetchJson(
        `/api/admin/pitch/decks/${deckId}/share/${token}/revoke`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onShowToast?.("Share link revoked", "success");
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onShowToast?.(`Failed to revoke: ${msg}`, "error");
    }
  };

  const copy = async (token: string): Promise<void> => {
    const url = publicUrlFor(token, publicHost);
    try {
      await navigator.clipboard.writeText(url);
      onShowToast?.("Copied", "success");
    } catch {
      onShowToast?.("Copy failed — select the URL manually", "error");
    }
  };

  const now = Date.now();
  const active = tokens.filter((t) => t.revokedAt === null);
  const revoked = tokens.filter((t) => t.revokedAt !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="pitch-editor-share-dialog"
      >
        <DialogHeader>
          <DialogTitle>Share this deck</DialogTitle>
          <DialogDescription>
            Anyone with an active link can view this deck without logging
            in. Revoke a link any time.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => void issue()}
            disabled={issuing}
            data-testid="pitch-editor-share-create"
            className="inline-flex items-center justify-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {issuing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" />
            )}
            {issuing ? "Creating link…" : "Create new share link"}
          </button>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              Active links ({active.length})
            </h3>
            {loading && active.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : null}
            {!loading && active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active share links yet.
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {active.map((t) => {
                const url = publicUrlFor(t.token, publicHost);
                return (
                  <li
                    key={t.token}
                    className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1.5"
                    data-testid="pitch-editor-share-row"
                  >
                    <code className="flex-1 truncate text-xs" title={url}>
                      {url}
                    </code>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelative(now, t.createdAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copy(t.token)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted/40"
                      title="Copy link"
                      data-testid="pitch-editor-share-copy"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void revoke(t.token)}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="Revoke"
                      data-testid="pitch-editor-share-revoke"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {revoked.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                Revoked ({revoked.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-1 pl-4">
                {revoked.map((t) => (
                  <li key={t.token} className="truncate">
                    <span className="line-through">{publicUrlFor(t.token, publicHost)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
