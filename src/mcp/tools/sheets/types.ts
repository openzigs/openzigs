/**
 * Google Sheets API TypeScript interfaces.
 */

// ── Spreadsheet Metadata ─────────────────────────────────────────────────

export interface SheetProperties {
  sheetId: number;
  title: string;
  index: number;
  sheetType: string;
  gridProperties?: {
    rowCount: number;
    columnCount: number;
  };
}

export interface SpreadsheetProperties {
  title: string;
  locale?: string;
  timeZone?: string;
}

export interface Sheet {
  properties: SheetProperties;
}

export interface Spreadsheet {
  spreadsheetId: string;
  properties: SpreadsheetProperties;
  sheets: Sheet[];
  spreadsheetUrl: string;
}

// ── Values ───────────────────────────────────────────────────────────────

export interface ValueRange {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values: unknown[][];
}

export interface UpdateValuesResponse {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface AppendValuesResponse {
  spreadsheetId: string;
  tableRange: string;
  updates: UpdateValuesResponse;
}

// ── Formatting ───────────────────────────────────────────────────────────

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  backgroundColor?: {
    red: number;
    green: number;
    blue: number;
    alpha?: number;
  };
  textFormat?: {
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    foregroundColor?: {
      red: number;
      green: number;
      blue: number;
      alpha?: number;
    };
  };
  numberFormat?: { type: string; pattern?: string };
  horizontalAlignment?: "LEFT" | "CENTER" | "RIGHT";
}

// ── Client Config ────────────────────────────────────────────────────────

export interface SheetsClientConfig {
  /** Google API key for read-only access. */
  apiKey?: string;
  /** OAuth2 access token for read/write access. */
  accessToken?: string;
  /** OAuth2 refresh token (will auto-refresh if expired). */
  refreshToken?: string;
  /** OAuth2 client ID (required for token refresh). */
  clientId?: string;
  /** OAuth2 client secret (required for token refresh). */
  clientSecret?: string;
  /** Max requests per minute (Google default: 60). */
  maxRequestsPerMinute?: number;
}

// ── Drive File Listing ───────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}
