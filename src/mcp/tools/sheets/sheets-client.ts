/**
 * Google Sheets API v4 Client with rate limiting.
 *
 * Rate limit: ≤60 requests/min per user.
 * Auth: API key (read-only) or OAuth2 token (read/write) from Secret Vault.
 * A1 notation parsing and validation.
 * Error handling: 400, 401, 403, 404, 429 with exponential backoff.
 */

import type {
  SheetsClientConfig,
  Spreadsheet,
  ValueRange,
  UpdateValuesResponse,
  AppendValuesResponse,
  CellFormat,
  DriveFileList,
} from "./types.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

const DEFAULT_MAX_RPM = 60;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ── A1 Notation Validation ───────────────────────────────────────────────

const A1_PATTERN =
  /^(?:'?[^']*'?!)?(?:\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\d+:\d+)$/i;

export function validateA1Notation(range: string): boolean {
  // Allow sheet name with range or just range
  const stripped = range.trim();
  if (!stripped) return false;

  // Split on ! if present (sheet name separator)
  const parts = stripped.split("!");
  if (parts.length > 2) return false;

  const rangePart = parts.length === 2 ? parts[1] : parts[0];
  if (!rangePart) return false;

  // Check pattern
  return A1_PATTERN.test(stripped) || /^[A-Z]+\d+$/i.test(rangePart);
}

// ── Per-user rate limiter (sliding window per minute) ────────────────────

export class SheetsRateLimiter {
  private timestamps: number[] = [];
  private maxRpm: number;
  private queue: { resolve: () => void }[] = [];
  private processing = false;

  constructor(maxRpm: number = DEFAULT_MAX_RPM) {
    this.maxRpm = maxRpm;
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    const drain = () => {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }

      const now = Date.now();
      const windowStart = now - 60_000;
      this.timestamps = this.timestamps.filter((t) => t > windowStart);

      if (this.timestamps.length < this.maxRpm) {
        const entry = this.queue.shift()!;
        this.timestamps.push(now);
        entry.resolve();
        if (this.queue.length > 0) drain();
        else this.processing = false;
      } else {
        const waitMs = this.timestamps[0] + 60_000 - now + 10;
        setTimeout(() => drain(), waitMs);
      }
    };

    drain();
  }
}

// ── Client ───────────────────────────────────────────────────────────────

export class SheetsClient {
  private apiKey?: string;
  private accessToken?: string;
  private refreshToken?: string;
  private clientId?: string;
  private clientSecret?: string;
  private rateLimiter: SheetsRateLimiter;

  constructor(config: SheetsClientConfig) {
    if (!config.apiKey && !config.accessToken) {
      throw new Error(
        "Google Sheets requires an API key or OAuth2 access token",
      );
    }
    this.apiKey = config.apiKey;
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.rateLimiter = new SheetsRateLimiter(
      config.maxRequestsPerMinute ?? DEFAULT_MAX_RPM,
    );
  }

  // ── Spreadsheet metadata ──

  async getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet> {
    return this.request<Spreadsheet>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties,sheets.properties,spreadsheetUrl`,
    );
  }

  // ── Read values ──

  async getValues(spreadsheetId: string, range: string): Promise<ValueRange> {
    if (!validateA1Notation(range)) {
      throw new Error(`Invalid A1 notation: "${range}"`);
    }
    return this.request<ValueRange>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    );
  }

  // ── Write values ──

  async updateValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    inputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED",
  ): Promise<UpdateValuesResponse> {
    this.requireWriteAccess();
    if (!validateA1Notation(range)) {
      throw new Error(`Invalid A1 notation: "${range}"`);
    }
    return this.request<UpdateValuesResponse>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${inputOption}`,
      {
        method: "PUT",
        body: JSON.stringify({
          range,
          majorDimension: "ROWS",
          values,
        }),
      },
    );
  }

  async appendValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    inputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED",
  ): Promise<AppendValuesResponse> {
    this.requireWriteAccess();
    if (!validateA1Notation(range)) {
      throw new Error(`Invalid A1 notation: "${range}"`);
    }
    return this.request<AppendValuesResponse>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=${inputOption}`,
      {
        method: "POST",
        body: JSON.stringify({
          range,
          majorDimension: "ROWS",
          values,
        }),
      },
    );
  }

  // ── Create spreadsheet ──

  async createSpreadsheet(title: string): Promise<Spreadsheet> {
    this.requireWriteAccess();
    return this.request<Spreadsheet>(SHEETS_API_BASE, {
      method: "POST",
      body: JSON.stringify({
        properties: { title },
      }),
    });
  }

  // ── Add sheet (tab) ──

  async addSheet(spreadsheetId: string, title: string): Promise<unknown> {
    this.requireWriteAccess();
    return this.request(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: { title },
              },
            },
          ],
        }),
      },
    );
  }

  // ── Format cells ──

  async formatCells(
    spreadsheetId: string,
    sheetId: number,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
    format: CellFormat,
  ): Promise<unknown> {
    this.requireWriteAccess();
    const fields: string[] = [];
    const cellFormat: Record<string, unknown> = {};

    if (format.bold !== undefined) {
      cellFormat.textFormat = {
        ...((cellFormat.textFormat as object) ?? {}),
        bold: format.bold,
      };
      fields.push("userEnteredFormat.textFormat.bold");
    }
    if (format.italic !== undefined) {
      cellFormat.textFormat = {
        ...((cellFormat.textFormat as object) ?? {}),
        italic: format.italic,
      };
      fields.push("userEnteredFormat.textFormat.italic");
    }
    if (format.fontSize !== undefined) {
      cellFormat.textFormat = {
        ...((cellFormat.textFormat as object) ?? {}),
        fontSize: format.fontSize,
      };
      fields.push("userEnteredFormat.textFormat.fontSize");
    }
    if (format.backgroundColor) {
      cellFormat.backgroundColor = format.backgroundColor;
      fields.push("userEnteredFormat.backgroundColor");
    }
    if (format.numberFormat) {
      cellFormat.numberFormat = format.numberFormat;
      fields.push("userEnteredFormat.numberFormat");
    }
    if (format.horizontalAlignment) {
      cellFormat.horizontalAlignment = format.horizontalAlignment;
      fields.push("userEnteredFormat.horizontalAlignment");
    }

    return this.request(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: startRow,
                  endRowIndex: endRow,
                  startColumnIndex: startCol,
                  endColumnIndex: endCol,
                },
                cell: { userEnteredFormat: cellFormat },
                fields: fields.join(","),
              },
            },
          ],
        }),
      },
    );
  }

  // ── List spreadsheets (via Drive API) ──

  async listSpreadsheets(pageToken?: string): Promise<DriveFileList> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken",
      pageSize: "50",
      orderBy: "modifiedTime desc",
    });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<DriveFileList>(
      `${DRIVE_API_BASE}/files?${params.toString()}`,
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private requireWriteAccess(): void {
    if (!this.accessToken) {
      throw new Error(
        "Write operations require OAuth2 access token. API key provides read-only access.",
      );
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) return;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { access_token: string };
      this.accessToken = data.access_token;
    }
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.accessToken) {
      return { Authorization: `Bearer ${this.accessToken}` };
    }
    // API key is added as query param, not header
    return {};
  }

  private addApiKey(url: string): string {
    if (this.apiKey && !this.accessToken) {
      const separator = url.includes("?") ? "&" : "?";
      return `${url}${separator}key=${encodeURIComponent(this.apiKey)}`;
    }
    return url;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    await this.rateLimiter.acquire();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }

      const fullUrl = this.addApiKey(url);
      const response = await fetch(fullUrl, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
          ...(init?.headers as Record<string, string> | undefined),
        },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const status = response.status;
      const body = await response.text();

      // 401 — try refresh token once
      if (status === 401 && attempt === 0 && this.refreshToken) {
        await this.refreshAccessToken();
        continue;
      }

      // Retryable: 429 and 5xx
      if (status === 429 || status >= 500) {
        lastError = new Error(`Google Sheets API error ${status}: ${body}`);
        continue;
      }

      // Non-retryable
      if (status === 400) {
        throw new Error(`Google Sheets bad request (400): ${body}`);
      }
      if (status === 401) {
        throw new Error(
          "Google Sheets authentication failed (401). Check your credentials.",
        );
      }
      if (status === 403) {
        throw new Error(`Google Sheets access denied (403): ${body}`);
      }
      if (status === 404) {
        throw new Error(`Google Sheets resource not found (404): ${body}`);
      }

      throw new Error(`Google Sheets API error ${status}: ${body}`);
    }

    throw lastError ?? new Error("Google Sheets request failed after retries");
  }
}
