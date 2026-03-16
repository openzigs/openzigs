import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialRepository } from "./social-repository.js";
import { LeadCaptureService } from "./lead-capture.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

describe("LeadCaptureService", () => {
  let db: Database.Database;
  let repo: SocialRepository;
  let capture: LeadCaptureService;
  const now = new Date("2026-02-21T12:00:00Z");
  const clock = () => now;

  beforeEach(() => {
    db = createTestDb();
    repo = new SocialRepository(db, clock);
    repo.migrate();
    capture = new LeadCaptureService({ repository: repo });
  });

  it("extracts email from message text", () => {
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_1", username: "alice" });
    const result = capture.extract(contact.id, "My email is alice@example.com, thanks!", "twitter");
    expect(result).toBe(true);

    const updated = repo.getContact(contact.id) as Record<string, unknown>;
    expect(updated.email).toBe("alice@example.com");
  });

  it("extracts phone number from message text", () => {
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_2", username: "bob" });
    const result = capture.extract(contact.id, "Call me at +1-555-123-4567", "twitter");
    expect(result).toBe(true);

    const updated = repo.getContact(contact.id) as Record<string, unknown>;
    expect(updated.phone).toBe("+1-555-123-4567");
  });

  it("extracts both email and phone from same message", () => {
    const contact = repo.upsertContact({ platform: "reddit", platformUserId: "u_3", username: "charlie" });
    const result = capture.extract(contact.id, "Email: charlie@test.org Phone: (555) 987-6543", "reddit");
    expect(result).toBe(true);

    const updated = repo.getContact(contact.id) as Record<string, unknown>;
    expect(updated.email).toBe("charlie@test.org");
    expect(updated.phone).toBe("(555) 987-6543");
  });

  it("returns false when no lead data found", () => {
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_4", username: "dave" });
    const result = capture.extract(contact.id, "Just saying hello!", "twitter");
    expect(result).toBe(false);
  });

  it("does not overwrite existing email", () => {
    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_5", username: "eve" });
    // First capture
    capture.extract(contact.id, "eve@first.com", "twitter");
    // Second capture should not overwrite
    const result = capture.extract(contact.id, "eve@second.com", "twitter");
    expect(result).toBe(false);

    const updated = repo.getContact(contact.id) as Record<string, unknown>;
    expect(updated.email).toBe("eve@first.com");
  });

  it("adds auto-tag on capture", () => {
    const contact = repo.upsertContact({ platform: "youtube", platformUserId: "u_6", username: "frank" });
    capture.extract(contact.id, "frank@example.com", "youtube");

    const updated = repo.getContact(contact.id)!;
    const tags = JSON.parse(updated.tags);
    expect(tags).toContain("lead");
  });

  it("uses custom auto-tag", () => {
    const customCapture = new LeadCaptureService({ repository: repo, autoTag: "hot-lead" });
    const contact = repo.upsertContact({ platform: "tiktok", platformUserId: "u_7", username: "grace" });
    customCapture.extract(contact.id, "grace@example.com", "tiktok");

    const updated = repo.getContact(contact.id)!;
    const tags = JSON.parse(updated.tags);
    expect(tags).toContain("hot-lead");
  });

  it("emits lead_captured event", () => {
    const handler = vi.fn();
    capture.on("lead_captured", handler);

    const contact = repo.upsertContact({ platform: "twitter", platformUserId: "u_8", username: "heidi" });
    capture.extract(contact.id, "heidi@test.com", "twitter");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      contactId: contact.id,
      email: "heidi@test.com",
      platform: "twitter",
    });
  });

  it("returns false for nonexistent contact", () => {
    const result = capture.extract("nonexistent", "alice@example.com", "twitter");
    expect(result).toBe(false);
  });
});
