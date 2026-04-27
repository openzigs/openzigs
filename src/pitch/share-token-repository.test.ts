import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ShareTokenRepository,
  generateShareToken,
  hashTokenPrefix,
} from "./share-token-repository.js";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Minimal pitch_decks parent table for the FK. We don't run the full
  // migration — share-token tests must not depend on the deck schema.
  db.exec(
    `CREATE TABLE pitch_decks (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       brand_kit_id TEXT NOT NULL,
       aspect_ratio TEXT NOT NULL DEFAULT '16:9',
       metadata TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     );`,
  );
  db.prepare(
    `INSERT INTO pitch_decks
       (id, title, brand_kit_id, aspect_ratio, metadata, created_at, updated_at)
     VALUES (?, ?, ?, '16:9', '{}', '2026-04-27', '2026-04-27')`,
  ).run("deck-1", "Demo Deck", "kit-default");
  return db;
}

describe("generateShareToken", () => {
  it("returns a 43-char base64url string", () => {
    const t = generateShareToken();
    expect(t).toHaveLength(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique tokens across many calls (entropy sanity)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateShareToken());
    expect(set.size).toBe(1000);
  });
});

describe("hashTokenPrefix", () => {
  it("returns a stable 8-char hex prefix", () => {
    expect(hashTokenPrefix("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashTokenPrefix("abc")).toBe(hashTokenPrefix("abc"));
    expect(hashTokenPrefix("abc")).not.toBe(hashTokenPrefix("def"));
  });
});

describe("ShareTokenRepository", () => {
  function setup(now: Date = new Date("2026-04-27T12:00:00Z")) {
    let current = now;
    const db = makeDb();
    const repo = new ShareTokenRepository(db, () => current);
    repo.migrate();
    return {
      db,
      repo,
      advance(ms: number) {
        current = new Date(current.getTime() + ms);
      },
    };
  }

  it("issues a token with no expiry by default", () => {
    const { repo } = setup();
    const row = repo.issue({ deckId: "deck-1", createdBy: "alice" });
    expect(row.token).toHaveLength(43);
    expect(row.deck_id).toBe("deck-1");
    expect(row.expires_at).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(row.created_by).toBe("alice");
  });

  it("computes expires_at when expiresInDays is provided", () => {
    const { repo } = setup();
    const row = repo.issue({ deckId: "deck-1", expiresInDays: 7 });
    expect(row.expires_at).toBe(row.created_at + 7 * 86_400_000);
  });

  it("lookupActive returns the row for a fresh token", () => {
    const { repo } = setup();
    const row = repo.issue({ deckId: "deck-1" });
    const found = repo.lookupActive(row.token);
    expect(found?.deck_id).toBe("deck-1");
  });

  it("lookupActive returns null for an unknown token", () => {
    const { repo } = setup();
    expect(repo.lookupActive("does-not-exist")).toBeNull();
  });

  it("lookupActive returns null after revoke()", () => {
    const { repo } = setup();
    const row = repo.issue({ deckId: "deck-1" });
    expect(repo.revoke(row.token)).toBe(true);
    expect(repo.lookupActive(row.token)).toBeNull();
  });

  it("revoke is idempotent — second call returns false", () => {
    const { repo } = setup();
    const row = repo.issue({ deckId: "deck-1" });
    expect(repo.revoke(row.token)).toBe(true);
    expect(repo.revoke(row.token)).toBe(false);
  });

  it("lookupActive returns null after expires_at passes", () => {
    const { repo, advance } = setup();
    const row = repo.issue({ deckId: "deck-1", expiresInDays: 1 });
    expect(repo.lookupActive(row.token)).not.toBeNull();
    advance(2 * 86_400_000);
    expect(repo.lookupActive(row.token)).toBeNull();
  });

  it("list returns tokens for a deck newest first", () => {
    const { repo, advance } = setup();
    const a = repo.issue({ deckId: "deck-1" });
    advance(1000);
    const b = repo.issue({ deckId: "deck-1" });
    const list = repo.list("deck-1");
    expect(list.map((r) => r.token)).toEqual([b.token, a.token]);
  });

  it("list does not return tokens from other decks", () => {
    const { repo, db } = setup();
    db.prepare(
      `INSERT INTO pitch_decks
         (id, title, brand_kit_id, aspect_ratio, metadata, created_at, updated_at)
       VALUES (?, ?, ?, '16:9', '{}', '2026-04-27', '2026-04-27')`,
    ).run("deck-2", "Other", "kit-default");
    repo.issue({ deckId: "deck-1" });
    repo.issue({ deckId: "deck-2" });
    expect(repo.list("deck-1")).toHaveLength(1);
    expect(repo.list("deck-2")).toHaveLength(1);
  });
});
