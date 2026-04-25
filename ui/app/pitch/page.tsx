"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, MoreVertical } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface DeckSummary {
  id: string;
  title: string;
  brand_kit_id: string;
  aspect_ratio: string;
  slides: Array<unknown>;
  metadata: { source_script?: string; tone?: string };
  created_at: string;
  updated_at: string;
}

interface BrandKit {
  id: string;
  name: string;
}

interface DecksResponse {
  decks: DeckSummary[];
  pagination: { total: number; limit: number; offset: number };
}

interface BrandKitsResponse {
  brandKits: BrandKit[];
}

export default function PitchDeckListPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<DeckSummary | null>(null);

  const decksQuery = useQuery({
    queryKey: ["pitch", "decks"],
    queryFn: () => fetchJson<DecksResponse>("/api/admin/pitch/decks"),
  });

  const kitsQuery = useQuery({
    queryKey: ["pitch", "brand-kits"],
    queryFn: () =>
      fetchJson<BrandKitsResponse>("/api/admin/pitch/brand-kits"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (deckId: string) =>
      fetchJson(`/api/admin/pitch/decks/${deckId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "decks"] });
      showToast("Deck deleted.", "success");
    },
    onError: () => showToast("Could not delete deck.", "error"),
  });

  const decks = decksQuery.data?.decks ?? [];
  const kitNameById = new Map(
    (kitsQuery.data?.brandKits ?? []).map((k) => [k.id, k.name]),
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8" data-testid="deck-list-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Pitch Decks</h1>
          <p className="text-sm text-muted-foreground">
            AI-generated presentations with reusable brand kits.
          </p>
        </div>
        <Link
          href="/pitch/new"
          data-testid="deck-list-new-cta"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Deck
        </Link>
      </div>

      {decksQuery.isLoading ? (
        <div className="mt-12 text-center text-sm text-muted-foreground">
          Loading decks…
        </div>
      ) : decksQuery.isError ? (
        <div className="mt-12 text-center text-sm text-red-500">
          Could not load decks.
        </div>
      ) : decks.length === 0 ? (
        <div
          data-testid="deck-list-empty"
          className="mt-12 rounded-lg border border-dashed border-border p-12 text-center"
        >
          <h2 className="text-lg font-semibold">No decks yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate your first AI-drafted pitch deck to get started.
          </p>
          <Link
            href="/pitch/new"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Deck
          </Link>
        </div>
      ) : (
        <ul
          className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="deck-list-grid"
        >
          {decks.map((deck) => (
            <li
              key={deck.id}
              data-testid={`deck-card-${deck.id}`}
              className="group relative cursor-pointer rounded-lg border border-border bg-card p-4 hover:border-primary"
              onClick={() => router.push(`/pitch/${deck.id}`)}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 text-sm font-semibold">{deck.title}</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Deck ${deck.title} actions`}
                      data-testid={`deck-card-actions-${deck.id}`}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => setPendingDelete(deck)}
                      className="text-red-500 focus:text-red-500"
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                <div>
                  <dt>Slides</dt>
                  <dd className="font-medium text-foreground">
                    {deck.slides.length}
                  </dd>
                </div>
                <div>
                  <dt>Brand kit</dt>
                  <dd className="truncate font-medium text-foreground">
                    {kitNameById.get(deck.brand_kit_id) ?? "—"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt>Updated</dt>
                  <dd className="font-medium text-foreground">
                    {new Date(deck.updated_at).toLocaleString()}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.title}"`}
          message="This permanently removes the deck and its slides. This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => {
            deleteMutation.mutate(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
