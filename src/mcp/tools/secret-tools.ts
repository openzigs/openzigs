/**
 * get-secret MCP tool — returns opaque {{SECRET:<uuid>}} reference tokens.
 *
 * The AI sees only the reference token; the actual plaintext is resolved
 * at the last possible moment inside the browser-navigate handler.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { SecretVaultService } from "../../vault/index.js";
import { buildSecretToken } from "../../vault/index.js";

const getSecretSchema = z.object({
  label: z.string().describe("Human-readable label of the secret to retrieve (partial match, case-insensitive)."),
});

const listSecretsSchema = z.object({});

type GetSecretInput = z.infer<typeof getSecretSchema>;

export type SecretToolsOptions = {
  vaultService: SecretVaultService;
};

export const createSecretTools = ({ vaultService }: SecretToolsOptions): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: "get-secret",
    description:
      "Look up a stored credential/secret from the local vault by label. Returns an opaque " +
      "reference token like {{SECRET:<uuid>}} that you MUST pass to browser-navigate's type action " +
      "for secure credential entry. ALWAYS use this tool when a user asks to log in, sign in, " +
      "enter credentials, or use their password for any website — never ask the user for passwords directly. " +
      "The plaintext is NEVER exposed to chat history or logs.",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Human-readable label of the secret (partial match, case-insensitive).",
        },
      },
      required: ["label"],
    },
    zodSchema: getSecretSchema,
    category: "browser",
    riskLevel: "medium",
    handler: async (args) => {
      const { label } = args as GetSecretInput;

      if (!vaultService.isUnlocked()) {
        return {
          text: "Vault is locked. Please unlock it from the Admin → Vault panel first.",
          isError: true,
        };
      }

      const secrets = vaultService.listSecrets();
      const needle = label.toLowerCase();
      const match = secrets.find(
        (s) =>
          s.label.toLowerCase() === needle ||
          s.label.toLowerCase().includes(needle)
      );

      if (!match) {
        return {
          text: `No secret found matching "${label}". Available labels: ${secrets.map((s) => s.label).join(", ") || "(none)"}`,
          isError: true,
        };
      }

      const token = buildSecretToken(match.id);

      return {
        text: JSON.stringify({
          token,
          label: match.label,
          service: match.service ?? null,
          username: match.username ?? null,
          hint: "Use this token as the 'text' parameter in browser-navigate type action. The actual secret will be injected securely at the browser level.",
        }),
      };
    },
  });

  tools.push({
    name: "list-secrets",
    description:
      "List all secrets stored in the local vault (metadata only — no values). " +
      "Call this FIRST when a user asks to log in to any service, to discover available " +
      "credentials before using get-secret to retrieve the secure token.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    zodSchema: listSecretsSchema,
    category: "browser",
    riskLevel: "low",
    handler: async () => {
      if (!vaultService.isUnlocked()) {
        return {
          text: "Vault is locked. Please unlock it from the Admin → Vault panel first.",
          isError: true,
        };
      }

      const secrets = vaultService.listSecrets();
      return {
        text: JSON.stringify({
          count: secrets.length,
          secrets: secrets.map((s) => ({
            label: s.label,
            service: s.service ?? null,
            username: s.username ?? null,
            id: s.id,
          })),
        }),
      };
    },
  });

  return tools;
};
