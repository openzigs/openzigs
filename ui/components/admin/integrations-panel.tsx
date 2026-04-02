"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Database,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

type IntegrationStatus = {
  airtable: { configured: boolean; label?: string };
  sheets: { configured: boolean; hasApiKey: boolean; hasOAuth: boolean };
};

export const IntegrationsPanel = () => {
  const queryClient = useQueryClient();
  const [airtableKey, setAirtableKey] = useState("");
  const [sheetsApiKey, setSheetsApiKey] = useState("");
  const [sheetsOAuthToken, setSheetsOAuthToken] = useState("");

  const statusQuery = useQuery({
    queryKey: ["integrations-status"],
    queryFn: () =>
      fetchJson<IntegrationStatus>("/api/admin/integrations/status"),
    refetchInterval: 15_000,
  });

  const saveMutation = useMutation({
    mutationFn: (data: { service: string; secrets: Record<string, string> }) =>
      fetchJson("/api/admin/integrations/save", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["integrations-status"] });
      queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
      showToast(
        `${variables.service === "airtable" ? "Airtable" : "Google Sheets"} credentials saved.`,
        "success",
      );
      setAirtableKey("");
      setSheetsApiKey("");
      setSheetsOAuthToken("");
    },
    onError: (err) => {
      showToast(
        `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    },
  });

  const testMutation = useMutation({
    mutationFn: (service: string) =>
      fetchJson<{ ok: boolean; message: string }>(
        "/api/admin/integrations/test",
        {
          method: "POST",
          body: JSON.stringify({ service }),
        },
      ),
    onSuccess: (data) => {
      if (data.ok) {
        showToast(data.message, "success");
      } else {
        showToast(data.message, "error");
      }
    },
    onError: (err) => {
      showToast(
        `Test failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    },
  });

  const status = statusQuery.data;

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Configure Airtable and Google Sheets credentials for the spreadsheet MCP
        tools. Credentials are stored in the encrypted Secret Vault.
      </p>

      {/* Airtable */}
      <div className="rounded-lg border border-zinc-700/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-blue-400" />
          <h3 className="font-medium text-zinc-200">Airtable</h3>
          {status?.airtable.configured ? (
            <CheckCircle2 className="h-4 w-4 text-green-400 ml-auto" />
          ) : (
            <XCircle className="h-4 w-4 text-zinc-500 ml-auto" />
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs text-zinc-400">
            Personal Access Token (pat_...)
          </label>
          <input
            type="password"
            className="w-full rounded bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500"
            placeholder={
              status?.airtable.configured
                ? "••• configured — enter new value to update"
                : "pat_xxxx.xxxxxxxxx"
            }
            value={airtableKey}
            onChange={(e) => setAirtableKey(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              disabled={!airtableKey || saveMutation.isPending}
              onClick={() =>
                saveMutation.mutate({
                  service: "airtable",
                  secrets: { "airtable-api-key": airtableKey },
                })
              }
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Save"
              )}
            </button>
            {status?.airtable.configured && (
              <button
                className="rounded border border-zinc-600 hover:bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
                onClick={() => testMutation.mutate("airtable")}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? "Testing…" : "Test Connection"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Google Sheets */}
      <div className="rounded-lg border border-zinc-700/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-green-400" />
          <h3 className="font-medium text-zinc-200">Google Sheets</h3>
          {status?.sheets.configured ? (
            <CheckCircle2 className="h-4 w-4 text-green-400 ml-auto" />
          ) : (
            <XCircle className="h-4 w-4 text-zinc-500 ml-auto" />
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs text-zinc-400">
            API Key (read-only access)
          </label>
          <input
            type="password"
            className="w-full rounded bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500"
            placeholder={
              status?.sheets.hasApiKey
                ? "••• configured — enter new value to update"
                : "AIza..."
            }
            value={sheetsApiKey}
            onChange={(e) => setSheetsApiKey(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-zinc-400">
            OAuth2 Access Token (read/write)
          </label>
          <input
            type="password"
            className="w-full rounded bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500"
            placeholder={
              status?.sheets.hasOAuth
                ? "••• configured — enter new value to update"
                : "ya29..."
            }
            value={sheetsOAuthToken}
            onChange={(e) => setSheetsOAuthToken(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="rounded bg-green-600 hover:bg-green-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              disabled={
                (!sheetsApiKey && !sheetsOAuthToken) || saveMutation.isPending
              }
              onClick={() => {
                const secrets: Record<string, string> = {};
                if (sheetsApiKey)
                  secrets["google-sheets-api-key"] = sheetsApiKey;
                if (sheetsOAuthToken)
                  secrets["google-sheets-oauth-token"] = sheetsOAuthToken;
                saveMutation.mutate({ service: "sheets", secrets });
              }}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Save"
              )}
            </button>
            {status?.sheets.configured && (
              <button
                className="rounded border border-zinc-600 hover:bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
                onClick={() => testMutation.mutate("sheets")}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? "Testing…" : "Test Connection"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
