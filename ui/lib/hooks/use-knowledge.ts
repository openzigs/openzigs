/**
 * React Query hooks for the Knowledge Base subsystem.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { KnowledgeStats, KnowledgeDocument, KnowledgeSearchResult } from "@/lib/types";

/** Fetch knowledge base statistics. */
export const useKnowledgeStats = () =>
  useQuery({
    queryKey: ["knowledge", "stats"],
    queryFn: () => fetchJson<KnowledgeStats>("/api/admin/knowledge/stats"),
    refetchInterval: 10_000,
  });

/** Fetch all tracked documents. */
export const useKnowledgeDocuments = () =>
  useQuery({
    queryKey: ["knowledge", "documents"],
    queryFn: () => fetchJson<{ documents: KnowledgeDocument[] }>("/api/admin/knowledge/documents"),
    refetchInterval: 10_000,
  });

/** Search the knowledge base. */
export const useKnowledgeSearch = (query: string, limit: number = 10) =>
  useQuery({
    queryKey: ["knowledge", "search", query, limit],
    queryFn: () =>
      fetchJson<{ results: KnowledgeSearchResult[]; query: string; count: number }>(
        "/api/admin/knowledge/search",
        {
          method: "POST",
          body: JSON.stringify({ query, limit }),
        }
      ),
    enabled: query.trim().length > 0,
  });

/** Force re-index all documents. */
export const useReindexAll = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchJson<{ ok: boolean; stats: KnowledgeStats }>("/api/admin/knowledge/reindex", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
};

/** Force re-index a single document. */
export const useReindexDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      fetchJson<{ ok: boolean }>(`/api/admin/knowledge/reindex/${documentId}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
};

/** Delete a document from the knowledge base. */
export const useDeleteDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      fetchJson<{ ok: boolean }>(`/api/admin/knowledge/documents/${documentId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
};
