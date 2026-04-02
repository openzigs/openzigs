/**
 * Integrations API Router
 *
 * Provides endpoints for managing Airtable & Google Sheets credentials
 * and testing connectivity.
 */

import { Router } from "express";
import type { SecretVaultService } from "../vault/secret-vault-service.js";

export type IntegrationsRouterOptions = {
  vaultService: SecretVaultService;
};

export const createIntegrationsRouter = ({
  vaultService,
}: IntegrationsRouterOptions): Router => {
  const router = Router();

  // ── GET /status ────────────────────────────────────────────────────────
  router.get("/status", (_req, res) => {
    const unlocked = vaultService.isUnlocked();

    const airtableKey = unlocked
      ? vaultService.getByLabel("airtable-api-key")
      : undefined;
    const sheetsApiKey = unlocked
      ? vaultService.getByLabel("google-sheets-api-key")
      : undefined;
    const sheetsOAuth = unlocked
      ? vaultService.getByLabel("google-sheets-oauth-token")
      : undefined;

    res.json({
      airtable: {
        configured: !!airtableKey,
      },
      sheets: {
        configured: !!(sheetsApiKey || sheetsOAuth),
        hasApiKey: !!sheetsApiKey,
        hasOAuth: !!sheetsOAuth,
      },
    });
  });

  // ── POST /save ─────────────────────────────────────────────────────────
  router.post("/save", async (req, res) => {
    const { service, secrets } = req.body as {
      service: string;
      secrets: Record<string, string>;
    };

    if (!service || !secrets || typeof secrets !== "object") {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    if (!vaultService.isUnlocked()) {
      res
        .status(400)
        .json({ error: "Vault is locked. Unlock it first via Admin → Vault." });
      return;
    }

    try {
      for (const [label, value] of Object.entries(secrets)) {
        if (!label || typeof value !== "string" || !value) continue;

        // Check if the secret already exists
        const existing = vaultService.getByLabel(label);
        if (existing) {
          // Find and update existing secret
          const all = vaultService.listSecrets();
          const entry = all.find(
            (s) => s.label?.toLowerCase() === label.toLowerCase(),
          );
          if (entry) {
            vaultService.updateSecret(entry.id, { value });
          }
        } else {
          vaultService.addSecret({
            label,
            value,
            service: service === "airtable" ? "Airtable" : "Google Sheets",
          });
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── POST /test ─────────────────────────────────────────────────────────
  router.post("/test", async (req, res) => {
    const { service } = req.body as { service: string };

    if (!vaultService.isUnlocked()) {
      res.json({ ok: false, message: "Vault is locked." });
      return;
    }

    try {
      if (service === "airtable") {
        const apiKey = vaultService.getByLabel("airtable-api-key");
        if (!apiKey) {
          res.json({
            ok: false,
            message: "No Airtable API key found in vault.",
          });
          return;
        }

        // Test by listing bases (minimal API call)
        const response = await fetch(
          "https://api.airtable.com/v0/meta/bases?pageSize=1",
          {
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.ok) {
          res.json({ ok: true, message: "Airtable connection successful!" });
        } else {
          const body = await response.text();
          res.json({
            ok: false,
            message: `Airtable returned ${response.status}: ${body}`,
          });
        }
      } else if (service === "sheets") {
        const apiKey = vaultService.getByLabel("google-sheets-api-key");
        const oauthToken = vaultService.getByLabel("google-sheets-oauth-token");

        if (!apiKey && !oauthToken) {
          res.json({
            ok: false,
            message: "No Google Sheets credentials found in vault.",
          });
          return;
        }

        // Test sheets API with a simple discovery call
        const url =
          "https://www.googleapis.com/drive/v3/files?pageSize=1&q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27";
        const headers: Record<string, string> = {};
        if (oauthToken) {
          headers.Authorization = `Bearer ${oauthToken}`;
        } else if (apiKey) {
          // API key goes as query param but this endpoint requires auth
          res.json({
            ok: true,
            message:
              "API key saved. Note: API key provides read-only access. Add an OAuth token for write operations.",
          });
          return;
        }

        const response = await fetch(url, { headers });
        if (response.ok) {
          res.json({
            ok: true,
            message: "Google Sheets connection successful!",
          });
        } else {
          const body = await response.text();
          res.json({
            ok: false,
            message: `Google API returned ${response.status}: ${body}`,
          });
        }
      } else {
        res.json({ ok: false, message: `Unknown service: ${service}` });
      }
    } catch (err) {
      res.json({
        ok: false,
        message: `Connection test failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  return router;
};
