/**
 * React Query hooks for the Knowledge Base subsystem.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { KnowledgeStats, KnowledgeDocument, KnowledgeSearchResult } from "@/lib/types";

/** Converter availability info from the backend. */
export type ConverterInfo = {
  name: string;
  extensions: string[];
  available: boolean;
  reason?: string;
};

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

/** Fetch available converters and their status. */
export const useConverters = () =>
  useQuery({
    queryKey: ["knowledge", "converters"],
    queryFn: () => fetchJson<{ converters: ConverterInfo[] }>("/api/admin/knowledge/converters"),
  });

/** Update visibility and/or category metadata for a knowledge document. */
export const useUpdateDocumentMeta = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, visibility, category }: { documentId: string; visibility: string; category: string }) =>
      fetchJson<{ ok: boolean; visibility: string; category: string }>(
        `/api/admin/knowledge/documents/${encodeURIComponent(documentId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ visibility, category }),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
};

/** Convert files by path — copies them into the knowledge directory + indexes. */
export const useConvertFiles = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (filePaths: string[]) =>
      fetchJson<{ ok: boolean; results: Array<{ file: string; ok: boolean; error?: string }>; stats: KnowledgeStats }>(
        "/api/admin/knowledge/convert",
        {
          method: "POST",
          body: JSON.stringify({ filePaths }),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
};
