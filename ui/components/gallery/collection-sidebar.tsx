"use client";

import { useState, useCallback, useEffect } from "react";
import {
  FolderOpen,
  Plus,
  Trash2,
  Loader2,
  Pencil,
  Check,
  X,
  Layers,
} from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";

interface Collection {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  createdAt: string;
}

interface CollectionSidebarProps {
  activeCollection: string | null;
  onSelectCollection: (id: string | null) => void;
}

export function CollectionSidebar({ activeCollection, onSelectCollection }: CollectionSidebarProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchJson<{ collections: Collection[] }>("/api/admin/director/gallery/collections");
      setCollections(res.collections);
    } catch {
      // silently fail — collections may not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await fetchJson("/api/admin/director/gallery/collections", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() }),
      });
      setNewName("");
      setCreating(false);
      load();
      showToast("Collection created", "success");
    } catch {
      showToast("Failed to create collection", "error");
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    try {
      await fetchJson(`/api/admin/director/gallery/collections/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name: editName.trim() }),
      });
      setEditingId(null);
      load();
    } catch {
      showToast("Failed to rename collection", "error");
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await fetchJson(`/api/admin/director/gallery/collections/${id}`, { method: "DELETE" });
      if (activeCollection === id) onSelectCollection(null);
      load();
      showToast("Collection deleted", "success");
    } catch {
      showToast("Failed to delete collection", "error");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="w-48 shrink-0 space-y-2 border-r border-border pr-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Collections</h3>
        <button
          onClick={() => setCreating(true)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="New collection"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* All Assets */}
      <button
        onClick={() => onSelectCollection(null)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
          activeCollection === null ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <Layers className="h-3.5 w-3.5" />
        All Assets
      </button>

      {/* Create form */}
      {creating && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
            placeholder="Collection name"
            autoFocus
          />
          <button onClick={handleCreate} className="rounded p-1 text-green-500 hover:bg-muted">
            <Check className="h-3 w-3" />
          </button>
          <button onClick={() => { setCreating(false); setNewName(""); }} className="rounded p-1 text-muted-foreground hover:bg-muted">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-0.5">
          {collections.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-md px-2 py-1.5 transition ${
                activeCollection === c.id ? "bg-primary/10" : "hover:bg-muted"
              }`}
            >
              {editingId === c.id ? (
                <div className="flex flex-1 items-center gap-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleRename(c.id)}
                    className="w-full rounded border border-border bg-background px-1 py-0.5 text-xs"
                    autoFocus
                  />
                  <button onClick={() => handleRename(c.id)} className="p-0.5 text-green-500">
                    <Check className="h-3 w-3" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="p-0.5 text-muted-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => onSelectCollection(c.id)}
                    className={`flex flex-1 items-center gap-2 text-left text-xs ${
                      activeCollection === c.id ? "font-medium text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] opacity-60">{c.itemCount}</span>
                  </button>
                  <div className="flex shrink-0 opacity-0 group-hover:opacity-100">
                    <button
                      onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                      className="p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={deleting === c.id}
                      className="p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      {deleting === c.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Trash2 className="h-2.5 w-2.5" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
