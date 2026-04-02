/**
 * Airtable API TypeScript interfaces.
 */

// ── Base & Table Metadata ────────────────────────────────────────────────

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: "none" | "read" | "comment" | "edit" | "create";
}

export interface AirtableBasesResponse {
  bases: AirtableBase[];
  offset?: string;
}

export interface AirtableFieldOption {
  id: string;
  name: string;
  color?: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: {
    choices?: AirtableFieldOption[];
    [key: string]: unknown;
  };
}

export interface AirtableView {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
  views: AirtableView[];
}

export interface AirtableTablesResponse {
  tables: AirtableTable[];
}

// ── Records ──────────────────────────────────────────────────────────────

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtableRecordsResponse {
  records: AirtableRecord[];
  offset?: string;
}

export interface AirtableRecordWrite {
  fields: Record<string, unknown>;
}

export interface AirtableRecordUpdate {
  id: string;
  fields: Record<string, unknown>;
}

export interface AirtableCreateRecordsRequest {
  records: AirtableRecordWrite[];
  typecast?: boolean;
}

export interface AirtableUpdateRecordsRequest {
  records: AirtableRecordUpdate[];
  typecast?: boolean;
}

export interface AirtableDeleteRecordsResponse {
  records: { id: string; deleted: boolean }[];
}

// ── Query Parameters ─────────────────────────────────────────────────────

export interface AirtableListRecordsParams {
  fields?: string[];
  filterByFormula?: string;
  maxRecords?: number;
  pageSize?: number;
  sort?: { field: string; direction?: "asc" | "desc" }[];
  view?: string;
  offset?: string;
}

// ── Error ────────────────────────────────────────────────────────────────

export interface AirtableApiError {
  error: {
    type: string;
    message: string;
  };
}

// ── Client Config ────────────────────────────────────────────────────────

export interface AirtableClientConfig {
  apiKey: string;
  /** Max requests per second per base (Airtable limit: 5 req/sec). */
  maxRequestsPerSecond?: number;
}
