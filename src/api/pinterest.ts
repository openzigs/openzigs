/**
 * Pinterest Reports + Tracker API routes.
 *
 * Mounted at /api/pinterest — serves saved Pinterest report data (JSON + markdown)
 * from ~/.openzigs/pinterest-reports/ for the UI analytics dashboard, plus
 * pin tracker & content ideas CRUD backed by SQLite.
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDatabase } from "../productivity/database.js";
import { PinterestTrackerRepository } from "../mcp/tools/pinterest-tracker.js";
import { logger } from "../logging/logger.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

const REPORTS_DIR = path.join(os.homedir(), ".openzigs", "pinterest-reports");
const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

export const createPinterestRouter = (options?: { copilotWrapper?: CopilotWrapper }): Router => {
  const router = Router();
  const db = getDatabase();
  const tracker = new PinterestTrackerRepository(db);
  const copilotWrapper = options?.copilotWrapper;

  // ── Pinterest API helpers (thin wrappers for direct REST calls) ─────

  function getToken(): string | undefined {
    return process.env.PINTEREST_ACCESS_TOKEN;
  }

  // ── GET /boards — list boards for the authenticated user ────────────
  router.get("/boards", async (_req, res) => {
    const token = getToken();
    if (!token) return res.status(401).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });

    try {
      const apiRes = await fetch(`${PINTEREST_API_BASE}/boards?page_size=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!apiRes.ok) {
        const body = await apiRes.text();
        logger.warn(`Pinterest boards fetch failed (${apiRes.status}): ${body}`);
        return res.status(apiRes.status).json({ error: `Pinterest API error: ${body}` });
      }
      const data = (await apiRes.json()) as { items?: Array<Record<string, unknown>> };
      const boards = (data.items ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description ?? "",
        pin_count: b.pin_count ?? 0,
        privacy: b.privacy ?? "PUBLIC",
      }));
      return res.json({ boards });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pinterest boards error: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  });

  // ── POST /create-pin — create a pin on Pinterest ───────────────────
  router.post("/create-pin", async (req, res) => {
    const token = getToken();
    if (!token) return res.status(401).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });

    const { board_id, title, description, link, alt_text, image_url, image_path, board_section_id } = req.body ?? {};
    if (!board_id || !title || !description) {
      return res.status(400).json({ error: "board_id, title, and description are required" });
    }
    if (!image_url && !image_path) {
      return res.status(400).json({ error: "Either image_url or image_path is required" });
    }

    try {
      const pin: Record<string, unknown> = { board_id, title, description };
      if (link) pin.link = link;
      if (alt_text) pin.alt_text = alt_text;
      if (board_section_id) pin.board_section_id = board_section_id;

      if (image_path) {
        if (typeof image_path !== "string" || image_path.includes("..") || image_path.includes("\0")) {
          return res.status(400).json({ error: "Invalid image_path" });
        }
        const absPath = path.resolve(image_path);
        if (!fs.existsSync(absPath)) {
          return res.status(400).json({ error: `Image file not found: ${absPath}` });
        }
        const imgBuf = fs.readFileSync(absPath);
        const ext = path.extname(absPath).toLowerCase();
        const contentTypes: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp",
        };
        pin.media_source = {
          source_type: "image_base64",
          content_type: contentTypes[ext] ?? "image/png",
          data: imgBuf.toString("base64"),
        };
      } else if (image_url) {
        pin.media_source = { source_type: "image_url", url: image_url };
      }

      const apiRes = await fetch(`${PINTEREST_API_BASE}/pins`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(pin),
      });

      const rawBody = await apiRes.text();
      if (!apiRes.ok) {
        logger.warn(`Pinterest create-pin failed (${apiRes.status}): ${rawBody}`);
        return res.status(apiRes.status).json({ error: `Pinterest API error: ${rawBody}` });
      }

      const pinData = JSON.parse(rawBody) as Record<string, unknown>;
      const pinId = pinData.id as string;

      logger.info(`Pinterest pin created: ${pinId} on board ${board_id}`);
      return res.json({
        ok: true,
        pin_id: pinId,
        url: `https://www.pinterest.com/pin/${pinId}/`,
        board_id,
        title: pinData.title,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pinterest create-pin error: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  });

  /** GET /api/pinterest/reports — list all reports with metadata */
  router.get("/reports", (_req, res) => {
    if (!fs.existsSync(REPORTS_DIR)) {
      return res.json({ reports: [] });
    }

    const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md"));
    const reports = files.map((filename) => {
      const baseName = filename.replace(/\.md$/, "");
      const mdPath = path.join(REPORTS_DIR, filename);
      const jsonPath = path.join(REPORTS_DIR, `${baseName}.json`);
      const stat = fs.statSync(mdPath);

      // Extract type from filename pattern: type-...-timestamp.md
      const typeMatch = baseName.match(/^(analytics|keyword-metrics|seo-analysis|trends)-/);
      const type = typeMatch ? typeMatch[1] : "unknown";

      // Extract timestamp from end of filename (2026-03-09T15-44-04)
      const tsMatch = baseName.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
      const generated = tsMatch ? tsMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") : stat.mtime.toISOString();

      return {
        filename: baseName,
        type,
        generated,
        size: stat.size,
        hasJson: fs.existsSync(jsonPath),
      };
    });

    // Sort newest first
    reports.sort((a, b) => b.generated.localeCompare(a.generated));
    return res.json({ reports });
  });

  /** GET /api/pinterest/reports/:filename — get a specific report (JSON preferred, markdown fallback) */
  router.get("/reports/:filename", (req, res) => {
    const filename = path.basename(req.params.filename); // sanitize
    const jsonPath = path.join(REPORTS_DIR, `${filename}.json`);
    const mdPath = path.join(REPORTS_DIR, `${filename}.md`);

    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        return res.json({ format: "json", data });
      } catch {
        // Fall through to markdown
      }
    }

    if (fs.existsSync(mdPath)) {
      const content = fs.readFileSync(mdPath, "utf-8");
      return res.json({ format: "markdown", content });
    }

    return res.status(404).json({ error: "Report not found" });
  });

  /** GET /api/pinterest/status — Pinterest connection status */
  router.get("/status", (_req, res) => {
    const hasToken = !!process.env.PINTEREST_ACCESS_TOKEN;
    const reportCount = fs.existsSync(REPORTS_DIR)
      ? fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md")).length
      : 0;

    return res.json({
      connected: hasToken,
      reportsDir: REPORTS_DIR,
      reportCount,
    });
  });

  // ── Pin Tracker endpoints ───────────────────────────────────────────────

  /** GET /api/pinterest/tracker/pins — list tracked pins */
  router.get("/tracker/pins", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const pins = tracker.listTrackedPins(status);
    return res.json({ pins });
  });

  /** POST /api/pinterest/tracker/pins — track a new pin */
  router.post("/tracker/pins", (req, res) => {
    const { pin_id, title, topic, board_id, link, initial_score, status } = req.body ?? {};
    if (!pin_id || typeof pin_id !== "string") {
      return res.status(400).json({ error: "pin_id is required" });
    }
    tracker.trackPin({
      pin_id,
      title: title ?? null,
      topic: topic ?? null,
      board_id: board_id ?? null,
      link: link ?? null,
      initial_score: initial_score ?? null,
      created_at: new Date().toISOString(),
      status: status ?? "active",
    });
    return res.json({ ok: true, pin_id });
  });

  /** GET /api/pinterest/tracker/pins/:pinId — get a tracked pin with performance summary */
  router.get("/tracker/pins/:pinId", (req, res) => {
    const pinId = req.params.pinId;
    const summary = tracker.getPinPerformanceSummary(pinId);
    if (!summary) return res.status(404).json({ error: "Pin not tracked" });
    return res.json(summary);
  });

  /** DELETE /api/pinterest/tracker/pins/:pinId — stop tracking a pin */
  router.delete("/tracker/pins/:pinId", (req, res) => {
    const deleted = tracker.deleteTrackedPin(req.params.pinId);
    return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "Pin not found" });
  });

  /** PATCH /api/pinterest/tracker/pins/:pinId/status — update pin tracking status */
  router.patch("/tracker/pins/:pinId/status", (req, res) => {
    const { status } = req.body ?? {};
    if (!["active", "paused", "archived"].includes(status)) {
      return res.status(400).json({ error: "status must be active|paused|archived" });
    }
    const ok = tracker.updatePinStatus(req.params.pinId, status);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "Pin not found" });
  });

  /** GET /api/pinterest/tracker/pins/:pinId/snapshots — get performance history */
  router.get("/tracker/pins/:pinId/snapshots", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 90, 365);
    const snapshots = tracker.getSnapshots(req.params.pinId, limit);
    return res.json({ snapshots });
  });

  /** POST /api/pinterest/tracker/pins/:pinId/snapshots — add a metric snapshot */
  router.post("/tracker/pins/:pinId/snapshots", (req, res) => {
    const { impressions, pin_clicks, saves, outbound_clicks, reactions, comments } = req.body ?? {};
    const id = tracker.addSnapshot({
      pin_id: req.params.pinId,
      checked_at: new Date().toISOString(),
      impressions: impressions ?? 0,
      pin_clicks: pin_clicks ?? 0,
      saves: saves ?? 0,
      outbound_clicks: outbound_clicks ?? 0,
      reactions: reactions ?? 0,
      comments: comments ?? 0,
    });
    tracker.updateLastChecked(req.params.pinId, new Date().toISOString());
    return res.json({ ok: true, id });
  });

  // ── Content Ideas endpoints ─────────────────────────────────────────────

  /** GET /api/pinterest/tracker/ideas — list content ideas */
  router.get("/tracker/ideas", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const ideas = tracker.listContentIdeas(status);
    return res.json({ ideas });
  });

  /** POST /api/pinterest/tracker/ideas — add a content idea */
  router.post("/tracker/ideas", (req, res) => {
    const { topic, suggested_title, suggested_description, target_keywords, difficulty, estimated_volume, source_data } = req.body ?? {};
    if (!topic || !suggested_title) {
      return res.status(400).json({ error: "topic and suggested_title are required" });
    }
    const id = tracker.addContentIdea({
      topic,
      suggested_title,
      suggested_description: suggested_description ?? "",
      target_keywords: JSON.stringify(target_keywords ?? []),
      difficulty: difficulty ?? "medium",
      estimated_volume: estimated_volume ?? "unknown",
      source_data: JSON.stringify(source_data ?? {}),
      created_at: new Date().toISOString(),
      status: "new",
      pin_id: null,
    });
    return res.json({ ok: true, id });
  });

  /** PATCH /api/pinterest/tracker/ideas/:id/status — update idea status */
  router.patch("/tracker/ideas/:id/status", (req, res) => {
    const id = Number(req.params.id);
    const { status, pin_id } = req.body ?? {};
    if (!["new", "created", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "status must be new|created|dismissed" });
    }
    const ok = tracker.updateIdeaStatus(id, status, pin_id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "Idea not found" });
  });

  /** DELETE /api/pinterest/tracker/ideas/:id — delete a content idea */
  router.delete("/tracker/ideas/:id", (req, res) => {
    const deleted = tracker.deleteContentIdea(Number(req.params.id));
    return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "Idea not found" });
  });

  // ── Sync real Pinterest data ──────────────────────────────────────────

  /** POST /api/pinterest/sync-pins — import real pins from Pinterest API and track them */
  router.post("/sync-pins", async (_req, res) => {
    const token = getToken();
    if (!token) return res.status(401).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });

    try {
      // Fetch user's real pins
      const apiRes = await fetch(`${PINTEREST_API_BASE}/pins?page_size=50`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!apiRes.ok) {
        const body = await apiRes.text();
        logger.warn(`Pinterest pins fetch failed (${apiRes.status}): ${body}`);
        return res.status(apiRes.status).json({ error: `Pinterest API error: ${body}` });
      }

      const data = (await apiRes.json()) as { items?: Array<Record<string, unknown>> };
      const pins = data.items ?? [];
      let imported = 0;

      for (const pin of pins) {
        const pinId = String(pin.id ?? "");
        if (!pinId) continue;

        const boardId = pin.board_id as string | undefined;
        const title = (pin.title as string) ?? null;
        const description = (pin.description as string) ?? null;
        const link = (pin.link as string) ?? null;
        const createdAt = (pin.created_at as string) ?? new Date().toISOString();

        tracker.trackPin({
          pin_id: pinId,
          title: title ?? (description ? description.slice(0, 100) : pinId),
          topic: null,
          board_id: boardId ?? null,
          link,
          initial_score: null,
          created_at: createdAt,
          status: "active",
        });
        imported++;
      }

      logger.info(`Pinterest sync: imported ${imported} pins`);
      return res.json({ ok: true, imported, total: pins.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pinterest sync-pins error: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  });

  /** POST /api/pinterest/sync-metrics — fetch analytics for all tracked active pins */
  router.post("/sync-metrics", async (_req, res) => {
    const token = getToken();
    if (!token) return res.status(401).json({ error: "PINTEREST_ACCESS_TOKEN not configured" });

    try {
      const activePins = tracker.listTrackedPins("active");
      let synced = 0;
      let errors = 0;

      for (const pin of activePins) {
        try {
          const apiRes = await fetch(
            `${PINTEREST_API_BASE}/pins/${pin.pin_id}/analytics?start_date=${getDateDaysAgo(1)}&end_date=${getTodayDate()}&metric_types=IMPRESSION,PIN_CLICK,SAVE,OUTBOUND_CLICK`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
          );

          if (!apiRes.ok) {
            logger.warn(`Pinterest analytics for ${pin.pin_id} failed (${apiRes.status})`);
            errors++;
            continue;
          }

          const analyticsData = (await apiRes.json()) as Record<string, unknown>;
          // Pinterest analytics v5 returns { all: { daily_metrics: [...], summary_metrics: {...} } }
          const all = analyticsData.all as Record<string, unknown> | undefined;
          const summary = (all?.summary_metrics ?? analyticsData.summary_metrics ?? {}) as Record<string, number>;

          tracker.addSnapshot({
            pin_id: pin.pin_id,
            checked_at: new Date().toISOString(),
            impressions: Number(summary.IMPRESSION ?? 0),
            pin_clicks: Number(summary.PIN_CLICK ?? 0),
            saves: Number(summary.SAVE ?? 0),
            outbound_clicks: Number(summary.OUTBOUND_CLICK ?? 0),
            reactions: 0,
            comments: 0,
          });
          tracker.updateLastChecked(pin.pin_id, new Date().toISOString());
          synced++;
        } catch {
          errors++;
        }
      }

      logger.info(`Pinterest sync-metrics: ${synced} synced, ${errors} errors`);
      return res.json({ ok: true, synced, errors, total: activePins.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pinterest sync-metrics error: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  });

  /** POST /api/pinterest/generate-ideas — use AI to generate content ideas */
  router.post("/generate-ideas", async (req, res) => {
    const { topic, count } = req.body ?? {};
    const numIdeas = Math.min(Number(count) || 5, 10);
    const topicHint = typeof topic === "string" && topic.trim() ? topic.trim() : "trending Pinterest topics";

    try {
      if (!copilotWrapper) {
        return res.status(503).json({ error: "AI backend is not available" });
      }

      const prompt = [
        `You are a Pinterest content strategist. Generate ${numIdeas} content ideas for Pinterest pins.`,
        ``,
        `Topic/niche focus: ${topicHint}`,
        ``,
        `For each idea provide:`,
        `- topic: broad category`,
        `- suggested_title: SEO-optimized pin title (under 100 chars)`,
        `- suggested_description: keyword-rich description (under 500 chars) with relevant hashtags`,
        `- target_keywords: array of 3-5 keywords`,
        `- difficulty: "low", "medium", or "high"`,
        `- estimated_volume: search volume range like "1K-5K", "5K-10K", "10K-50K", "50K-100K"`,
        ``,
        `Return ONLY a valid JSON array of objects (no markdown fences, no explanation).`,
      ].join("\n");

      let result = "";
      for await (const chunk of copilotWrapper.chat(prompt, {})) {
        result += chunk;
      }

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return res.status(500).json({ error: "AI did not return valid JSON" });
      }
      const ideas = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      let added = 0;

      for (const idea of ideas) {
        tracker.addContentIdea({
          topic: String(idea.topic ?? topicHint),
          suggested_title: String(idea.suggested_title ?? ""),
          suggested_description: String(idea.suggested_description ?? ""),
          target_keywords: JSON.stringify(idea.target_keywords ?? []),
          difficulty: String(idea.difficulty ?? "medium"),
          estimated_volume: String(idea.estimated_volume ?? "unknown"),
          source_data: JSON.stringify({ ai_generated: true, topic: topicHint }),
          created_at: new Date().toISOString(),
          status: "new",
          pin_id: null,
        });
        added++;
      }

      return res.json({ ok: true, added, ideas: ideas.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Pinterest generate-ideas error: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  });

  // ── Seed test data (dev helper) ─────────────────────────────────────────

  /** POST /api/pinterest/tracker/seed — seed test data for development */
  router.post("/tracker/seed", (_req, res) => {
    const now = new Date();
    const testPins = [
      { pin_id: "test-pin-001", title: "10 AI Tools for Content Creators in 2026", topic: "AI Tools", board_id: "board-1", link: "https://example.com/ai-tools", initial_score: 72 },
      { pin_id: "test-pin-002", title: "Spring Nail Art Trends You Need to Try", topic: "Nail Art", board_id: "board-2", link: "https://example.com/nail-trends", initial_score: 85 },
      { pin_id: "test-pin-003", title: "Minimalist Home Office Setup Guide", topic: "Home Decor", board_id: "board-3", link: "https://example.com/home-office", initial_score: 63 },
      { pin_id: "test-pin-004", title: "Easy Keto Meal Prep for Beginners", topic: "Keto Recipes", board_id: "board-1", link: "https://example.com/keto-meals", initial_score: 91 },
      { pin_id: "test-pin-005", title: "Summer Travel Bucket List 2026", topic: "Travel", board_id: "board-4", link: "https://example.com/travel-2026", initial_score: 78 },
    ];

    for (const p of testPins) {
      tracker.trackPin({ ...p, created_at: new Date(now.getTime() - 30 * 86400000).toISOString(), status: "active" });
    }

    // Seed 30 days of snapshots with growing metrics for each pin
    for (const p of testPins) {
      for (let day = 30; day >= 0; day--) {
        const date = new Date(now.getTime() - day * 86400000);
        const growth = (30 - day) / 30; // 0 → 1 over 30 days
        const base = { impressions: 0, pin_clicks: 0, saves: 0, outbound_clicks: 0, reactions: 0, comments: 0 };
        if (p.pin_id === "test-pin-001") {
          base.impressions = Math.round(100 + growth * 900);
          base.pin_clicks = Math.round(10 + growth * 90);
          base.saves = Math.round(5 + growth * 45);
          base.outbound_clicks = Math.round(3 + growth * 27);
        } else if (p.pin_id === "test-pin-002") {
          base.impressions = Math.round(500 + growth * 2500);
          base.pin_clicks = Math.round(50 + growth * 200);
          base.saves = Math.round(30 + growth * 150);
          base.outbound_clicks = Math.round(10 + growth * 40);
        } else if (p.pin_id === "test-pin-003") {
          base.impressions = Math.round(80 + growth * 400);
          base.pin_clicks = Math.round(8 + growth * 40);
          base.saves = Math.round(4 + growth * 20);
          base.outbound_clicks = Math.round(2 + growth * 10);
        } else if (p.pin_id === "test-pin-004") {
          base.impressions = Math.round(300 + growth * 2000);
          base.pin_clicks = Math.round(40 + growth * 300);
          base.saves = Math.round(25 + growth * 200);
          base.outbound_clicks = Math.round(15 + growth * 100);
        } else {
          base.impressions = Math.round(200 + growth * 800);
          base.pin_clicks = Math.round(20 + growth * 80);
          base.saves = Math.round(10 + growth * 50);
          base.outbound_clicks = Math.round(5 + growth * 30);
        }
        tracker.addSnapshot({
          pin_id: p.pin_id,
          checked_at: date.toISOString(),
          ...base,
        });
      }
      tracker.updateLastChecked(p.pin_id, now.toISOString());
    }

    // Seed content ideas
    const ideas = [
      { topic: "AI Tools", suggested_title: "Top 15 AI Image Generators for Pinterest Pins", suggested_description: "Roundup of the best AI tools to create scroll-stopping Pin graphics", target_keywords: ["ai image generator", "ai tools pinterest", "ai pin design"], difficulty: "low", estimated_volume: "5K-10K" },
      { topic: "Nail Art", suggested_title: "DIY Chrome Nails Tutorial Step-by-Step", suggested_description: "Easy chrome nail tutorial perfect for Pinterest's visual audience", target_keywords: ["chrome nails tutorial", "diy nails", "nail art 2026"], difficulty: "medium", estimated_volume: "10K-50K" },
      { topic: "Home Decor", suggested_title: "Budget-Friendly Home Office Makeover Ideas", suggested_description: "Transform your workspace for under $200 with these Pinterest-worthy ideas", target_keywords: ["home office ideas", "budget decor", "small office setup"], difficulty: "low", estimated_volume: "10K-50K" },
      { topic: "Keto Recipes", suggested_title: "30-Minute Keto Dinner Recipes for Busy Weeknights", suggested_description: "Quick keto dinners that perform well on Pinterest food boards", target_keywords: ["keto dinner", "quick keto recipes", "easy keto meals"], difficulty: "high", estimated_volume: "50K-100K" },
    ];

    for (const idea of ideas) {
      tracker.addContentIdea({
        ...idea,
        target_keywords: JSON.stringify(idea.target_keywords),
        source_data: JSON.stringify({ seeded: true }),
        created_at: new Date().toISOString(),
        status: "new",
        pin_id: null,
      });
    }

    return res.json({
      ok: true,
      warning: "This is synthetic demo data for UI testing. Pin IDs are fake and do not correspond to real Pinterest pins.",
      pins: testPins.length,
      snapshots: testPins.length * 31,
      ideas: ideas.length,
    });
  });

  return router;
};

// ── Date helpers for Pinterest API ──

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
