/**
 * Pinterest polling function for the GenericPollAdapter.
 *
 * Fetches owned pins via the Pinterest API v5 and emits activity records
 * (new pins, save count deltas) into the Social Brain pipeline.
 *
 * NOTE: Pinterest's public REST API v5 does NOT expose individual pin comments
 * (only `comment_count` aggregate — confirmed via Pinterest developer docs).
 * This poller therefore surfaces *save engagement* as the primary signal, and
 * emits a synthetic IncomingComment per pin per polling window whenever the
 * pin is newly created or its save_count has changed. When Pinterest later
 * exposes individual comments (or a Pinterest MCP sidecar adds the capability),
 * extend `fetchPinComments` accordingly.
 */

import { logger } from "../../logging/logger.js";
import type { IncomingComment, IncomingSocialMessage } from "./types.js";

const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

interface PinterestPin {
  id?: string;
  created_at?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  board_id?: string | null;
  pin_metrics?: {
    "90d"?: { save?: number; impression?: number; pin_click?: number };
    all_time?: { save?: number; impression?: number; pin_click?: number };
  };
}

interface PinterestPinsResponse {
  items?: PinterestPin[];
  bookmark?: string | null;
}

interface PinterestPollOptions {
  /** Override token (defaults to PINTEREST_ACCESS_TOKEN env). */
  accessToken?: string;
  /** Override fetch (defaults to global). Used for testing. */
  fetchImpl?: typeof fetch;
  /** Max pins to scan per cycle. */
  maxPins?: number;
}

export function createPinterestPollFn(
  options: PinterestPollOptions = {},
): (since: string) => Promise<(IncomingSocialMessage | IncomingComment)[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxPins = options.maxPins ?? 25;

  // Track last-seen save_count per pin so we only emit on deltas.
  const lastSaveCount = new Map<string, number>();

  return async (since: string) => {
    const results: (IncomingSocialMessage | IncomingComment)[] = [];
    const token = options.accessToken ?? process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) {
      logger.warn("[PinterestPoll] PINTEREST_ACCESS_TOKEN not set; skipping");
      return results;
    }

    const sinceDate = new Date(since);

    let resp: Response;
    try {
      resp = await fetchImpl(
        `${PINTEREST_API_BASE}/pins?page_size=${maxPins}&pin_metrics=true`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[PinterestPoll] fetch failed: ${msg}`);
      return results;
    }

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after") ?? "60";
      logger.warn(
        `[PinterestPoll] rate-limited (429); retry-after=${retryAfter}s`,
      );
      return results;
    }
    if (!resp.ok) {
      logger.warn(
        `[PinterestPoll] non-OK response ${resp.status}: ${(await safeText(resp)).slice(0, 200)}`,
      );
      return results;
    }

    let data: PinterestPinsResponse;
    try {
      data = (await resp.json()) as PinterestPinsResponse;
    } catch {
      logger.warn("[PinterestPoll] failed to parse JSON response");
      return results;
    }

    const pins = data.items ?? [];
    logger.info(`[PinterestPoll] scanned ${pins.length} pins (since=${since})`);

    for (const pin of pins) {
      if (!pin.id) continue;

      const createdAt = pin.created_at ? new Date(pin.created_at) : null;
      const saveCount =
        pin.pin_metrics?.["90d"]?.save ?? pin.pin_metrics?.all_time?.save ?? 0;
      const prevSave = lastSaveCount.get(pin.id);
      const isNewPin = createdAt !== null && createdAt > sinceDate;
      const saveDelta = prevSave === undefined ? 0 : saveCount - prevSave;
      lastSaveCount.set(pin.id, saveCount);

      // Emit ONE record per pin per cycle when something changed.
      if (!isNewPin && saveDelta <= 0) continue;

      const text = isNewPin
        ? `New pin published: ${pin.title ?? pin.description ?? "(untitled)"}`
        : `+${saveDelta} new save${saveDelta === 1 ? "" : "s"} on pin`;
      const commentId = isNewPin
        ? `pin_created_${pin.id}`
        : `pin_saves_${pin.id}_${new Date().toISOString().slice(0, 10)}`;

      results.push({
        platform: "pinterest",
        postId: pin.id,
        commentId,
        userId: "pinterest_engagement",
        username: "pinterest",
        text,
        timestamp: (createdAt ?? new Date()).toISOString(),
      } satisfies IncomingComment);
    }

    logger.info(`[PinterestPoll] emitted ${results.length} activity events`);
    return results;
  };
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
