/**
 * Pitch share-token SQLite repository (Epic #990 / sub-issue #1000).
 *
 * Owns the `pitch_share_tokens` table — opaque, revocable, optionally-
 * expiring tokens that grant unauthenticated read-only access to a
 * single deck via the public `/p/:token` route.
 *
 * Design notes:
 *   - Token = 32 random bytes from `crypto.randomBytes` rendered as
 *     base64url (43 chars, ~256 bits of entropy). NEVER UUID, never
 *     `Math.random`. Lookup is by primary key so timing-safe comparison
 *     is unnecessary, but we never reflect the token in error messages.
 *   - `revoked_at` and `expires_at` are millisecond epochs. A token is
 *     "active" iff `revoked_at` is NULL AND (`expires_at` is NULL OR
 *     `expires_at > now`).
 *   - Tokens are scoped to a deck via FK with `ON DELETE CASCADE`, so
 *     deleting a deck reaps every token without orphan rows.
 *   - The repo never logs raw tokens. Callers wanting traceability
 *     should hash the token (SHA-256, first 8 chars) themselves before
 *     audit-logging. `hashTokenPrefix(token)` is exposed for that.
 */
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface ShareTokenRow {
  token: string;
  deck_id: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string | null;
}

export interface IssueShareTokenInput {
  deckId: string;
  /** Days until expiry. Omit / pass undefined for no expiry. */
  expiresInDays?: number;
  /** Actor id for audit traceability (never the raw token). */
  createdBy?: string | null;
}

/** Generate a fresh share token. 32 random bytes → 43-char base64url string. */
export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Return the first 8 hex chars of SHA-256(token). Safe to log — gives
 * traceability without exposing the secret.
 */
export function hashTokenPrefix(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export class ShareTokenRepository {
  private readonly db: Database.Database;
  private readonly clock: () => Date;

  constructor(db: Database.Database, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pitch_share_tokens (
        token        TEXT PRIMARY KEY,
        deck_id      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER,
        revoked_at   INTEGER,
        created_by   TEXT,
        FOREIGN KEY (deck_id) REFERENCES pitch_decks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pitch_share_tokens_deck
        ON pitch_share_tokens(deck_id);
    `);
  }

  /** Issue a new token for `deckId`. Returns the persisted row. */
  issue(input: IssueShareTokenInput): ShareTokenRow {
    const token = generateShareToken();
    const now = this.clock().getTime();
    const expiresAt =
      typeof input.expiresInDays === "number" && input.expiresInDays > 0
        ? now + input.expiresInDays * 24 * 60 * 60 * 1000
        : null;
    this.db
      .prepare(
        `INSERT INTO pitch_share_tokens
           (token, deck_id, created_at, expires_at, revoked_at, created_by)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(token, input.deckId, now, expiresAt, input.createdBy ?? null);
    return {
      token,
      deck_id: input.deckId,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      created_by: input.createdBy ?? null,
    };
  }

  /** All tokens (active or otherwise) for a deck, newest first. */
  list(deckId: string): ShareTokenRow[] {
    const rows = this.db
      .prepare(
        `SELECT token, deck_id, created_at, expires_at, revoked_at, created_by
           FROM pitch_share_tokens
          WHERE deck_id = ?
          ORDER BY created_at DESC`,
      )
      .all(deckId) as ShareTokenRow[];
    return rows;
  }

  /**
   * Look up a token. Returns the row only if the token is active
   * (not revoked, not expired). Returns `null` for unknown / revoked /
   * expired so callers can render a single generic 404 without leaking
   * which condition failed.
   */
  lookupActive(token: string): ShareTokenRow | null {
    const row = this.db
      .prepare(
        `SELECT token, deck_id, created_at, expires_at, revoked_at, created_by
           FROM pitch_share_tokens
          WHERE token = ?`,
      )
      .get(token) as ShareTokenRow | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= this.clock().getTime()) {
      return null;
    }
    return row;
  }

  /**
   * Mark a token as revoked. Returns true if a row was updated, false
   * if the token didn't exist or was already revoked.
   */
  revoke(token: string): boolean {
    const now = this.clock().getTime();
    const result = this.db
      .prepare(
        `UPDATE pitch_share_tokens
            SET revoked_at = ?
          WHERE token = ? AND revoked_at IS NULL`,
      )
      .run(now, token);
    return result.changes > 0;
  }
}
