"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

const buildUrl = (path: string) => (API_BASE ? `${API_BASE}${path}` : path);

const fetchJson = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (AUTH_TOKEN) headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  const response = await fetch(buildUrl(path), { ...options, headers });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

export const PromptLibraryDrawer = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const promptsQuery = useQuery({
    queryKey: ["prompts", search],
    queryFn: () => {
      const params = search ? `?query=${encodeURIComponent(search)}` : "";
      return fetchJson<{ prompts: SavedPrompt[] }>(`/api/prompts${params}`);
    },
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; template: string; description: string }) =>
      fetchJson("/api/prompts", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      setShowCreate(false);
      setNewName("");
      setNewTemplate("");
      setNewDescription("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/prompts/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompts"] }),
  });

  const prompts = promptsQuery.data?.prompts ?? [];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-stone shadow-panel overflow-y-auto">
        <div className="sticky top-0 z-10 bg-stone/95 backdrop-blur p-6 border-b border-ink/10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-ink">Prompt Library</h2>
            <button onClick={onClose} className="text-ink/60 hover:text-ink text-lg">✕</button>
          </div>
          <input
            type="text"
            placeholder="Search prompts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-ink/10 bg-white/80 px-4 py-2 text-sm"
          />
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="mt-3 w-full rounded-xl bg-tide px-4 py-2 text-sm font-semibold text-white"
          >
            {showCreate ? "Cancel" : "+ New Prompt"}
          </button>
        </div>

        <div className="p-6 space-y-4">
          {showCreate && (
            <div className="rounded-2xl border border-tide/20 bg-white/60 p-4 space-y-3">
              <input
                type="text"
                placeholder="Prompt name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm"
              />
              <textarea
                placeholder="Template (use {{variable}} for placeholders)"
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm"
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm"
              />
              <button
                onClick={() => createMutation.mutate({ name: newName, template: newTemplate, description: newDescription })}
                disabled={!newName || !newTemplate}
                className="w-full rounded-xl bg-moss px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                Save Prompt
              </button>
            </div>
          )}

          {prompts.length === 0 ? (
            <p className="text-sm text-ink/60">
              {search ? "No prompts match your search." : "No saved prompts yet."}
            </p>
          ) : (
            prompts.map((prompt) => (
              <div key={prompt.id} className="rounded-2xl border border-ink/10 bg-white/60 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-ink">{prompt.name}</p>
                    {prompt.description && (
                      <p className="text-xs text-ink/60 mt-1">{prompt.description}</p>
                    )}
                    <p className="text-xs text-ink/40 mt-2 font-mono line-clamp-2">
                      {prompt.template}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteMutation.mutate(prompt.id)}
                    className="ml-3 text-xs text-ember hover:underline"
                  >
                    Delete
                  </button>
                </div>
                {prompt.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {prompt.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-tide/10 px-2 py-0.5 text-[10px] text-tide">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
