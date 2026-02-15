"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { Lock, Unlock, Plus, Trash2, Eye, EyeOff, Key, Shield } from "lucide-react";

type SecretEntry = {
  id: string;
  label: string;
  service?: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
};

type VaultStatus = {
  exists: boolean;
  unlocked: boolean;
  secretCount: number | null;
};

export const VaultPanel = () => {
  const queryClient = useQueryClient();
  const [masterPassword, setMasterPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // New secret form state
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newService, setNewService] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [showNewValue, setShowNewValue] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Change password state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const statusQuery = useQuery({
    queryKey: ["vault-status"],
    queryFn: () => fetchJson<VaultStatus>("/api/admin/vault/status"),
    refetchInterval: 10_000,
  });

  const secretsQuery = useQuery({
    queryKey: ["vault-secrets"],
    queryFn: () => fetchJson<{ secrets: SecretEntry[] }>("/api/admin/vault/secrets"),
    enabled: statusQuery.data?.unlocked === true,
  });

  const initializeMutation = useMutation({
    mutationFn: (password: string) =>
      fetchJson("/api/admin/vault/initialize", {
        method: "POST",
        body: JSON.stringify({ masterPassword: password }),
      }),
    onSuccess: () => {
      showToast("Vault initialised successfully", "success");
      setMasterPassword("");
      void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
      void queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const unlockMutation = useMutation({
    mutationFn: (password: string) =>
      fetchJson("/api/admin/vault/unlock", {
        method: "POST",
        body: JSON.stringify({ masterPassword: password }),
      }),
    onSuccess: () => {
      showToast("Vault unlocked", "success");
      setMasterPassword("");
      void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
      void queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const lockMutation = useMutation({
    mutationFn: () =>
      fetchJson("/api/admin/vault/lock", { method: "POST" }),
    onSuccess: () => {
      showToast("Vault locked", "info");
      void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
      void queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const addSecretMutation = useMutation({
    mutationFn: (data: { label: string; value: string; service?: string; username?: string }) =>
      fetchJson("/api/admin/vault/secrets", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      showToast("Secret added", "success");
      setNewLabel("");
      setNewValue("");
      setNewService("");
      setNewUsername("");
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
      void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteSecretMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/admin/vault/secrets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast("Secret deleted", "success");
      void queryClient.invalidateQueries({ queryKey: ["vault-secrets"] });
      void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      fetchJson("/api/admin/vault/change-password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      showToast("Master password changed", "success");
      setCurrentPassword("");
      setNewPassword("");
      setShowChangePassword(false);
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const status = statusQuery.data;
  const secrets = secretsQuery.data?.secrets ?? [];

  // ── Not yet initialised ──
  if (status && !status.exists) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="h-4 w-4" />
          <span>No vault found. Create one to securely store credentials.</span>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Master password (min 8 chars)"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none focus:border-primary/50"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            onClick={() => initializeMutation.mutate(masterPassword)}
            disabled={masterPassword.length < 8 || initializeMutation.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {initializeMutation.isPending ? "Creating…" : "Create Vault"}
          </button>
        </div>
      </div>
    );
  }

  // ── Locked ──
  if (status && !status.unlocked) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" />
          <span>Vault is locked. Enter master password to unlock.</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlockMutation.mutate(masterPassword);
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Master password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none focus:border-primary/50"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            type="submit"
            disabled={!masterPassword || unlockMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <Unlock className="h-3.5 w-3.5" />
            {unlockMutation.isPending ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </div>
    );
  }

  // ── Unlocked — show secrets ──
  return (
    <div className="space-y-4">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-emerald-500">
          <Unlock className="h-4 w-4" />
          <span>{secrets.length} secret{secrets.length !== 1 ? "s" : ""} stored</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowChangePassword(!showChangePassword)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/30 hover:text-foreground"
          >
            Change Password
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/30 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Secret
          </button>
          <button
            onClick={() => lockMutation.mutate()}
            className="flex items-center gap-1 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
          >
            <Lock className="h-3.5 w-3.5" />
            Lock
          </button>
        </div>
      </div>

      {/* Change password form */}
      {showChangePassword && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Change Master Password</p>
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <input
            type="password"
            placeholder="New password (min 8 chars)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <div className="flex gap-2">
            <button
              onClick={() => changePasswordMutation.mutate({ currentPassword, newPassword })}
              disabled={!currentPassword || newPassword.length < 8 || changePasswordMutation.isPending}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {changePasswordMutation.isPending ? "Changing…" : "Change Password"}
            </button>
            <button
              onClick={() => {
                setShowChangePassword(false);
                setCurrentPassword("");
                setNewPassword("");
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add secret form */}
      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Add New Secret</p>
          <input
            placeholder="Label (e.g. GitHub PAT)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <div className="relative">
            <input
              type={showNewValue ? "text" : "password"}
              placeholder="Secret value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none focus:border-primary/50"
            />
            <button
              type="button"
              onClick={() => setShowNewValue(!showNewValue)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showNewValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Service (optional, e.g. github.com)"
              value={newService}
              onChange={(e) => setNewService(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            />
            <input
              placeholder="Username (optional)"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() =>
                addSecretMutation.mutate({
                  label: newLabel,
                  value: newValue,
                  service: newService || undefined,
                  username: newUsername || undefined,
                })
              }
              disabled={!newLabel || !newValue || addSecretMutation.isPending}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {addSecretMutation.isPending ? "Adding…" : "Add Secret"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setNewLabel("");
                setNewValue("");
                setNewService("");
                setNewUsername("");
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Secrets list */}
      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets stored yet. Click &ldquo;Add Secret&rdquo; to get started.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {secrets.map((secret) => (
            <div key={secret.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <Key className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">{secret.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {[secret.service, secret.username].filter(Boolean).join(" · ") ||
                      `Added ${new Date(secret.createdAt).toLocaleDateString()}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground font-mono">
                  {"{{SECRET:" + secret.id.slice(0, 8) + "…}}"}
                </code>
                <button
                  onClick={() => {
                    if (confirm(`Delete secret "${secret.label}"?`)) {
                      deleteSecretMutation.mutate(secret.id);
                    }
                  }}
                  className="rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                  title="Delete secret"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
