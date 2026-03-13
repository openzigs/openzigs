import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PinterestTrackerRepository } from "./pinterest-tracker.js";
import type { TrackedPin } from "./pinterest-tracker.js";

describe("PinterestTrackerRepository", () => {
  let db: InstanceType<typeof Database>;
  let repo: PinterestTrackerRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new PinterestTrackerRepository(db);
    repo.migrate();
  });

  // ── Migration ──

  it("creates tables on migrate()", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("pinterest_tracked_pins");
    expect(names).toContain("pinterest_pin_snapshots");
    expect(names).toContain("pinterest_content_ideas");
  });

  it("is idempotent — calling migrate() twice does not throw", () => {
    expect(() => repo.migrate()).not.toThrow();
  });

  // ── Tracked Pins ──

  const samplePin: Omit<TrackedPin, "last_checked"> = {
    pin_id: "pin-001",
    title: "Test Pin",
    topic: "AI Tools",
    board_id: "board-1",
    link: "https://example.com",
    initial_score: 75,
    created_at: "2026-01-01T00:00:00.000Z",
    status: "active",
  };

  it("tracks a pin and retrieves it", () => {
    repo.trackPin(samplePin);
    const got = repo.getTrackedPin("pin-001");
    expect(got).toBeDefined();
    expect(got!.pin_id).toBe("pin-001");
    expect(got!.title).toBe("Test Pin");
    expect(got!.status).toBe("active");
    expect(got!.initial_score).toBe(75);
  });

  it("returns undefined for nonexistent pin", () => {
    expect(repo.getTrackedPin("nope")).toBeUndefined();
  });

  it("lists tracked pins", () => {
    repo.trackPin(samplePin);
    repo.trackPin({ ...samplePin, pin_id: "pin-002", title: "Second", status: "paused" });
    const all = repo.listTrackedPins();
    expect(all).toHaveLength(2);
  });

  it("lists tracked pins filtered by status", () => {
    repo.trackPin(samplePin);
    repo.trackPin({ ...samplePin, pin_id: "pin-002", status: "paused" });
    const active = repo.listTrackedPins("active");
    expect(active).toHaveLength(1);
    expect(active[0].pin_id).toBe("pin-001");
  });

  it("updates pin status", () => {
    repo.trackPin(samplePin);
    const updated = repo.updatePinStatus("pin-001", "archived");
    expect(updated).toBe(true);
    expect(repo.getTrackedPin("pin-001")!.status).toBe("archived");
  });

  it("returns false when updating nonexistent pin status", () => {
    expect(repo.updatePinStatus("nope", "paused")).toBe(false);
  });

  it("updates last_checked", () => {
    repo.trackPin(samplePin);
    repo.updateLastChecked("pin-001", "2026-02-01T00:00:00.000Z");
    expect(repo.getTrackedPin("pin-001")!.last_checked).toBe("2026-02-01T00:00:00.000Z");
  });

  it("deletes a tracked pin", () => {
    repo.trackPin(samplePin);
    expect(repo.deleteTrackedPin("pin-001")).toBe(true);
    expect(repo.getTrackedPin("pin-001")).toBeUndefined();
  });

  it("returns false when deleting nonexistent pin", () => {
    expect(repo.deleteTrackedPin("nope")).toBe(false);
  });

  it("upserts on trackPin (INSERT OR REPLACE)", () => {
    repo.trackPin(samplePin);
    repo.trackPin({ ...samplePin, title: "Updated Title" });
    const got = repo.getTrackedPin("pin-001");
    expect(got!.title).toBe("Updated Title");
    expect(repo.listTrackedPins()).toHaveLength(1);
  });

  // ── Snapshots ──

  it("adds and retrieves snapshots", () => {
    repo.trackPin(samplePin);
    const id = repo.addSnapshot({
      pin_id: "pin-001",
      checked_at: "2026-01-05T00:00:00.000Z",
      impressions: 100,
      pin_clicks: 10,
      saves: 5,
      outbound_clicks: 3,
      reactions: 1,
      comments: 0,
    });
    expect(id).toBeGreaterThan(0);

    const snapshots = repo.getSnapshots("pin-001");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].impressions).toBe(100);
    expect(snapshots[0].pin_clicks).toBe(10);
  });

  it("getSnapshots returns newest first", () => {
    repo.trackPin(samplePin);
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-01T00:00:00.000Z", impressions: 10, pin_clicks: 1, saves: 0, outbound_clicks: 0, reactions: 0, comments: 0 });
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-02T00:00:00.000Z", impressions: 20, pin_clicks: 2, saves: 1, outbound_clicks: 0, reactions: 0, comments: 0 });
    const snaps = repo.getSnapshots("pin-001");
    expect(snaps[0].checked_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("respects snapshot limit", () => {
    repo.trackPin(samplePin);
    for (let i = 0; i < 5; i++) {
      repo.addSnapshot({ pin_id: "pin-001", checked_at: `2026-01-0${i + 1}T00:00:00.000Z`, impressions: i * 10, pin_clicks: i, saves: 0, outbound_clicks: 0, reactions: 0, comments: 0 });
    }
    const limited = repo.getSnapshots("pin-001", 3);
    expect(limited).toHaveLength(3);
  });

  it("getLatestSnapshot returns most recent", () => {
    repo.trackPin(samplePin);
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-01T00:00:00.000Z", impressions: 10, pin_clicks: 1, saves: 0, outbound_clicks: 0, reactions: 0, comments: 0 });
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-05T00:00:00.000Z", impressions: 50, pin_clicks: 5, saves: 3, outbound_clicks: 1, reactions: 0, comments: 0 });
    const latest = repo.getLatestSnapshot("pin-001");
    expect(latest).toBeDefined();
    expect(latest!.impressions).toBe(50);
  });

  it("getLatestSnapshot returns undefined for pin with no snapshots", () => {
    repo.trackPin(samplePin);
    expect(repo.getLatestSnapshot("pin-001")).toBeUndefined();
  });

  it("cascades deletes from pin to snapshots", () => {
    repo.trackPin(samplePin);
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-05T00:00:00.000Z", impressions: 100, pin_clicks: 10, saves: 5, outbound_clicks: 3, reactions: 1, comments: 0 });
    repo.deleteTrackedPin("pin-001");
    expect(repo.getSnapshots("pin-001")).toHaveLength(0);
  });

  // ── Content Ideas ──

  const sampleIdea = {
    topic: "AI Tools",
    suggested_title: "Top 10 AI Photo Editors",
    suggested_description: "Roundup of the best AI tools for photo editing",
    target_keywords: '["ai photo editor","ai tools"]',
    difficulty: "low",
    estimated_volume: "5K-10K",
    source_data: '{"seeded":true}',
    created_at: "2026-01-01T00:00:00.000Z",
    status: "new" as const,
    pin_id: null,
  };

  it("adds and lists content ideas", () => {
    const id = repo.addContentIdea(sampleIdea);
    expect(id).toBeGreaterThan(0);

    const ideas = repo.listContentIdeas();
    expect(ideas).toHaveLength(1);
    expect(ideas[0].suggested_title).toBe("Top 10 AI Photo Editors");
    expect(ideas[0].difficulty).toBe("low");
  });

  it("filters ideas by status", () => {
    repo.addContentIdea(sampleIdea);
    repo.addContentIdea({ ...sampleIdea, suggested_title: "Created Idea", status: "created" });
    const newIdeas = repo.listContentIdeas("new");
    expect(newIdeas).toHaveLength(1);
    expect(newIdeas[0].suggested_title).toBe("Top 10 AI Photo Editors");
  });

  it("updates idea status", () => {
    const id = repo.addContentIdea(sampleIdea);
    const ok = repo.updateIdeaStatus(id, "created");
    expect(ok).toBe(true);
    const ideas = repo.listContentIdeas("created");
    expect(ideas).toHaveLength(1);
  });

  it("updates idea status with pin_id", () => {
    const id = repo.addContentIdea(sampleIdea);
    repo.updateIdeaStatus(id, "created", "pin-999");
    const ideas = repo.listContentIdeas("created");
    expect(ideas[0].pin_id).toBe("pin-999");
  });

  it("returns false when updating nonexistent idea", () => {
    expect(repo.updateIdeaStatus(999, "dismissed")).toBe(false);
  });

  it("deletes a content idea", () => {
    const id = repo.addContentIdea(sampleIdea);
    expect(repo.deleteContentIdea(id)).toBe(true);
    expect(repo.listContentIdeas()).toHaveLength(0);
  });

  it("returns false when deleting nonexistent idea", () => {
    expect(repo.deleteContentIdea(999)).toBe(false);
  });

  // ── Performance Summary ──

  it("getPinPerformanceSummary returns null for unknown pin", () => {
    expect(repo.getPinPerformanceSummary("nope")).toBeNull();
  });

  it("getPinPerformanceSummary with no snapshots returns nulls", () => {
    repo.trackPin(samplePin);
    const summary = repo.getPinPerformanceSummary("pin-001");
    expect(summary).not.toBeNull();
    expect(summary!.latest).toBeNull();
    expect(summary!.first).toBeNull();
    expect(summary!.totalSnapshots).toBe(0);
  });

  it("getPinPerformanceSummary with snapshots returns first/latest/count", () => {
    repo.trackPin(samplePin);
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-01T00:00:00.000Z", impressions: 10, pin_clicks: 1, saves: 0, outbound_clicks: 0, reactions: 0, comments: 0 });
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-10T00:00:00.000Z", impressions: 100, pin_clicks: 10, saves: 5, outbound_clicks: 3, reactions: 1, comments: 0 });
    repo.addSnapshot({ pin_id: "pin-001", checked_at: "2026-01-05T00:00:00.000Z", impressions: 50, pin_clicks: 5, saves: 2, outbound_clicks: 1, reactions: 0, comments: 0 });

    const summary = repo.getPinPerformanceSummary("pin-001");
    expect(summary!.totalSnapshots).toBe(3);
    expect(summary!.first!.impressions).toBe(10);
    expect(summary!.latest!.impressions).toBe(100);
    expect(summary!.daysSinceCreated).toBeGreaterThanOrEqual(0);
  });

  // ── Null handling ──

  it("handles pins with null optional fields", () => {
    repo.trackPin({
      pin_id: "pin-null",
      title: null,
      topic: null,
      board_id: null,
      link: null,
      initial_score: null,
      created_at: "2026-01-01T00:00:00.000Z",
      status: "active",
    });
    const got = repo.getTrackedPin("pin-null");
    expect(got).toBeDefined();
    expect(got!.title).toBeNull();
    expect(got!.topic).toBeNull();
  });
});
