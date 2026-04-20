/**
 * Sub-issue #903 — `LIKE` queries in `listContacts({ search })` previously
 * concatenated user input directly into the bound parameter, which lets `%`
 * and `_` in attacker input perform unintended scans. The fix escapes those
 * metacharacters and uses `LIKE ... ESCAPE '\\'`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialRepository } from "./social-repository.js";

const buildRepo = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new SocialRepository(db);
  repo.migrate();
  return repo;
};

describe("SocialRepository.listContacts LIKE escaping (sub-issue #903)", () => {
  let repo: ReturnType<typeof buildRepo>;

  beforeEach(() => {
    repo = buildRepo();
    repo.upsertContact({
      platform: "twitter",
      platformUserId: "u-1",
      username: "alice",
      displayName: "Alice",
    });
    repo.upsertContact({
      platform: "twitter",
      platformUserId: "u-2",
      username: "bob",
      displayName: "Bob",
    });
    repo.upsertContact({
      platform: "twitter",
      platformUserId: "u-3",
      username: "100%user",
      displayName: "Hundred Percent",
    });
  });

  it("matches the literal `%` character (no wildcard expansion)", () => {
    const result = repo.listContacts({ search: "100%" });
    // Must match the `100%user` row but NOT `alice` / `bob`.
    expect(result.data.map((c) => c.username).sort()).toEqual(["100%user"]);
  });

  it("treats `%` as a literal in search input — does not match every row", () => {
    const all = repo.listContacts({ search: "%" });
    // With the patched escape the lone `%` is a literal — none of the seeded
    // rows contain a literal `%` in username/display_name/notes EXCEPT the
    // `100%user` row. So we expect exactly one match, not all three.
    expect(all.data).toHaveLength(1);
    expect(all.data[0].username).toBe("100%user");
  });

  it("treats `_` as a literal (does not match a single character)", () => {
    const result = repo.listContacts({ search: "_lice" });
    // Without escaping, `_lice` would match `alice` (the `_` matches `a`).
    // With escaping it must not match.
    expect(result.data).toHaveLength(0);
  });

  it("still finds normal substring matches", () => {
    const result = repo.listContacts({ search: "ali" });
    expect(result.data.map((c) => c.username)).toContain("alice");
  });

  it("caps very long search input to defeat scan-amplification", () => {
    const huge = "a".repeat(10_000);
    // No throw, no hang.
    const start = performance.now();
    const result = repo.listContacts({ search: huge });
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.data).toHaveLength(0);
  });
});
