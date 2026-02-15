/**
 * Zero-Trust Secret Vault — Shared types.
 *
 * Secrets are stored AES-256-GCM encrypted at ~/.openzigs/vault.enc.
 * Plaintext never enters chat history, session JSONL, audit logs, or Socket.IO events.
 * Only opaque reference tokens ({{SECRET:<uuid>}}) flow through the system.
 */

export type SecretEntry = {
  /** Unique identifier (UUIDv4). */
  id: string;
  /** Human-readable label (e.g. "GitHub PAT", "AWS secret key"). */
  label: string;
  /** The service or site this secret is associated with (e.g. "github.com"). */
  service?: string;
  /** The username / email associated with this credential. */
  username?: string;
  /** ISO-8601 timestamp of when the entry was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
};

/**
 * Full secret entry including the plaintext value.
 * NEVER serialised to logs, session history, or Socket.IO events.
 */
export type SecretEntryWithValue = SecretEntry & {
  /** The actual secret value (password, API key, token, etc.). */
  value: string;
};

/**
 * Encrypted vault file format persisted at ~/.openzigs/vault.enc.
 *
 * The entire payload is a JSON object containing:
 * - `salt`:    hex-encoded random salt for PBKDF2
 * - `iv`:      hex-encoded initialisation vector for AES-256-GCM
 * - `tag`:     hex-encoded GCM authentication tag
 * - `data`:    hex-encoded AES-256-GCM ciphertext of the UTF-8 JSON secrets array
 * - `version`: schema version (currently 1)
 */
export type EncryptedVaultFile = {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

/**
 * The shape of the reference token embedded in tool arguments.
 * Pattern: {{SECRET:<uuid>}}
 */
export const SECRET_TOKEN_PATTERN = /\{\{SECRET:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/gi;

/**
 * Build a reference token string for a given secret ID.
 */
export const buildSecretToken = (id: string): string => `{{SECRET:${id}}}`;
