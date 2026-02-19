"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { ToastContainer, showToast } from "@/components/toast";
import { PresentationCard } from "@/components/presenter/presentation-card";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface PresentationSummary {
  id: string;
  title: string;
  thumbnail_path: string | null;
  duration_seconds: number;
  mode: string;
  quiz_enabled: boolean;
  created_at: string;
}

export default function PresenterPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const presentationsQuery = useQuery({
    queryKey: ["presentations"],
    queryFn: () =>
      fetchJson<{ presentations: PresentationSummary[] }>("/api/presentations"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/presentations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presentations"] });
      showToast("Presentation removed", "success");
    },
    onError: (err) => showToast(`Error: ${err.message}`, "error"),
  });

  const presentations = presentationsQuery.data?.presentations ?? [];
  const filtered = search
    ? presentations.filter((p) =>
        p.title.toLowerCase().includes(search.toLowerCase()),
      )
    : presentations;

  const handleDelete = (id: string, title: string) => {
    setDeleteTarget({ id, title });
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 lg:px-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">
          OpenZigs
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">
          Presenter Mode
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Interactive presentations with AI-powered Q&amp;A, pop quizzes, and
          live blackboard.
        </p>
      </header>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Search presentations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground"
        />
      </div>

      {presentationsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {search
              ? "No presentations match your search."
              : "No presentations yet. Render a video in Director Mode to see it here."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PresentationCard
              key={p.id}
              presentation={p}
              onDelete={() => handleDelete(p.id, p.title)}
            />
          ))}
        </div>
      )}
      <ToastContainer />
      {deleteTarget && (
        <ConfirmDialog
          title="Remove Presentation"
          message={`Remove "${deleteTarget.title}" from the catalog? The video file will not be deleted.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={() => {
            deleteMutation.mutate(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </main>
  );
}
