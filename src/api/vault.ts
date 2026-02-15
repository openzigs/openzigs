/**
 * Vault Admin API routes — manage the zero-trust secret vault.
 *
 * Mounted at /api/admin/vault in server.ts.
 * All routes require the vault to be unlocked unless noted otherwise.
 */

import { Router } from "express";
import type { SecretVaultService } from "../vault/index.js";

export type VaultRouterOptions = {
  vaultService: SecretVaultService;
};

export const createVaultRouter = ({ vaultService }: VaultRouterOptions) => {
  const router = Router();

  // ── Vault status ──
  router.get("/status", async (_req, res) => {
    try {
      const exists = await vaultService.exists();
      res.json({
        exists,
        unlocked: vaultService.isUnlocked(),
        secretCount: vaultService.isUnlocked() ? vaultService.listSecrets().length : null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // ── Initialise vault (first time setup) ──
  router.post("/initialize", async (req, res) => {
    try {
      const { masterPassword } = req.body as { masterPassword?: string };
      if (!masterPassword || typeof masterPassword !== "string" || masterPassword.length < 8) {
        res.status(400).json({ error: "Master password must be at least 8 characters" });
        return;
      }
      await vaultService.initialize(masterPassword);
      res.json({ ok: true, message: "Vault initialised" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // ── Unlock vault ──
  router.post("/unlock", async (req, res) => {
    try {
      const { masterPassword } = req.body as { masterPassword?: string };
      if (!masterPassword || typeof masterPassword !== "string") {
        res.status(400).json({ error: "masterPassword is required" });
        return;
      }
      await vaultService.unlock(masterPassword);
      res.json({ ok: true, message: "Vault unlocked" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(401).json({ error: msg });
    }
  });

  // ── Lock vault ──
  router.post("/lock", (_req, res) => {
    vaultService.lock();
    res.json({ ok: true, message: "Vault locked" });
  });

  // ── Change master password ──
  router.post("/change-password", async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: "Both currentPassword and newPassword are required" });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: "New password must be at least 8 characters" });
        return;
      }
      await vaultService.changeMasterPassword(currentPassword, newPassword);
      res.json({ ok: true, message: "Master password changed" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // ── List secrets (metadata only) ──
  router.get("/secrets", (_req, res) => {
    try {
      const secrets = vaultService.listSecrets();
      res.json({ secrets });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(403).json({ error: msg });
    }
  });

  // ── Add a new secret ──
  router.post("/secrets", async (req, res) => {
    try {
      const { label, value, service, username } = req.body as {
        label?: string;
        value?: string;
        service?: string;
        username?: string;
      };
      if (!label || !value) {
        res.status(400).json({ error: "label and value are required" });
        return;
      }
      const entry = await vaultService.addSecret({ label, value, service, username });
      res.status(201).json({ secret: entry });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // ── Update a secret ──
  router.patch("/secrets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { label, value, service, username } = req.body as {
        label?: string;
        value?: string;
        service?: string;
        username?: string;
      };
      const entry = await vaultService.updateSecret(id, { label, value, service, username });
      res.json({ secret: entry });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // ── Delete a secret ──
  router.delete("/secrets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await vaultService.deleteSecret(id);
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  return router;
};
