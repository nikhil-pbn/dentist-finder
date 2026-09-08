/**
 * Saves results to a Google Sheet, one tab per provider.
 *
 * The tab and its header row are created on first use, so a fresh spreadsheet
 * needs no manual setup. A save is an upsert keyed on the Map URL column, which
 * is unique per practice: a practice the tab has never seen is appended, one it
 * already has is updated in place where a value changed, and the rest are left
 * alone. Nothing is ever deleted, and a blank in the new data never erases a
 * value the sheet already holds.
 *
 * Server-only.
 */
import {
  GOOGLE_SHEETS_API_BASE,
  SHEET_TAB_NAMES,
  SHEETS_TIMEOUT_MS,
  XLSX_MIME,
  type ProviderId,
} from "@/lib/constants";
import type { SheetsConfig } from "@/lib/config";
import { AppError, ConfigurationError, SearchError } from "@/lib/errors";
import {
  fixedColumnCount,
  sheetColumnsFor,
  type ExportContext,
} from "@/lib/export-columns";
import {
  describeCause,
  HttpStatusError,
  parseJson,
  requestText,
} from "@/lib/providers/http";
import { getAccessToken } from "@/lib/sheets/auth";
import {
  downloadFile,
  getFileMeta,
  isNativeSheet,
  isOfficeWorkbook,
  uploadFile,
} from "@/lib/sheets/drive";
import { appendRowsToWorkbook, columnLetter } from "@/lib/sheets/xlsx-edit";
import type { Dentist } from "@/lib/types";

const LABEL = "Google Sheets";

/** The column that identifies a practice: an OSM element URL or a Google place URL. */
const ROW_KEY_HEADER = "Map URL";
/** Written once, when the practice first appears; a later search does not rewrite it. */
const FIRST_SEEN_HEADER = "Search ZIP";

/** A cell as the Sheets API accepts it. */
type SheetCell = string | number;

/** Shown to the user when a save fails for a reason only the operator can fix. */
const SAVE_PUBLIC_MESSAGE =
  "The spreadsheet is not set up for saving. The results are still exportable as Excel or CSV.";

/**
 * How this spreadsheet has to be written.
 *
 * `sheets` is the native Google Sheet path, one cell-range append.
 * `office` is a Drive-hosted .xlsx, which the Sheets API refuses; the workbook
 * is downloaded, edited and written back to the same file id.
 */
export type SheetWriteMode = "sheets" | "office";

export interface SheetTarget {
  /** The tab the rows go into, which is the provider's own id. */
  tab: string;
  provider: ProviderId;
  headers: readonly string[];
  token: string;
  mode: SheetWriteMode;
  fileName: string;
  createdTab: boolean;
  wroteHeader: boolean;
}

/*
 * The single most common way this fails, and the one worth naming precisely: a
 * spreadsheet that opens at a /spreadsheets/ URL but is still an uploaded
 * .xlsx. Google answers `FAILED_PRECONDITION`, which says nothing useful on its
 * own, so the message says what to do instead of what went wrong.
 */
const OFFICE_FILE = /must not be an Office file|not supported for this document/i;

const MISSING_DOCUMENT = /requested entity was not found/i;

function explainFailure(error: HttpStatusError, spreadsheetId: string): AppError {
  if (OFFICE_FILE.test(error.bodySnippet)) {
    return new ConfigurationError(
      `${LABEL} refused spreadsheet ${spreadsheetId}: it is an uploaded Office file, which the Sheets API cannot write to. Open it and use File > Save as Google Sheets, then set SHEETS_SPREADSHEET_ID to the id of the new document. Google's own words: ${error.bodySnippet}`,
      SAVE_PUBLIC_MESSAGE,
    );
  }
  if (error.status === 403) {
    return new ConfigurationError(
      `${LABEL} refused access to spreadsheet ${spreadsheetId}: ${error.bodySnippet}. Share the sheet with SHEETS_CLIENT_EMAIL as an Editor, and check that the Google Sheets API is enabled for the project.`,
      SAVE_PUBLIC_MESSAGE,
    );
  }
  if (error.status === 404 || MISSING_DOCUMENT.test(error.bodySnippet)) {
    return new ConfigurationError(
      `${LABEL} could not find spreadsheet ${spreadsheetId}: ${error.bodySnippet}. Check SHEETS_SPREADSHEET_ID - it is the part of the URL between /d/ and /edit.`,
      SAVE_PUBLIC_MESSAGE,
    );
  }
  return new SearchError(
    `${LABEL} request failed with HTTP ${error.status}: ${error.bodySnippet}`,
  );
}

async function sheetsRequest<T>(
  url: string,
  token: string,
  spreadsheetId: string,
  init: { method: "GET" | "POST" | "PUT"; body?: string } = { method: "GET" },
): Promise<T> {
  try {
    const text = await requestText(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
      timeoutMs: SHEETS_TIMEOUT_MS,
      label: LABEL,
    });
    return parseJson<T>(text, LABEL);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof HttpStatusError) throw explainFailure(error, spreadsheetId);
    throw new SearchError(`${LABEL} request failed: ${describeCause(error)}`, {
      cause: error,
    });
  }
}

interface SpreadsheetMeta {
  sheets?: { properties?: { title?: string } }[];
}

interface ValueRange {
  values?: SheetCell[][];
}

/** Creates the provider's tab if the spreadsheet does not already have it. */
async function ensureTab(
  config: SheetsConfig,
  token: string,
  tab: string,
): Promise<boolean> {
  const meta = await sheetsRequest<SpreadsheetMeta>(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}?fields=sheets.properties.title`,
    token,
    config.spreadsheetId,
  );

  const titles = (meta.sheets ?? []).map((sheet) => sheet.properties?.title);
  if (titles.includes(tab)) return false;

  await sheetsRequest(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}:batchUpdate`,
    token,
    config.spreadsheetId,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tab } } }],
      }),
    },
  );
  return true;
}

/**
 * Writes the header row when the tab is empty. Never rewrites an existing one.
 *
 * One addition is allowed: a tab created before the PMS columns existed has a
 * header that is exactly the first `fixedCount` of today's headers. Those tabs
 * get the missing PMS headers written into the empty cells to its right, and
 * nothing else is touched. A header that differs in any other way - fewer
 * columns, a renamed one - is left alone, as before.
 */
async function ensureHeader(
  config: SheetsConfig,
  token: string,
  tab: string,
  headers: readonly string[],
  fixedCount: number,
): Promise<boolean> {
  const range = `${encodeURIComponent(tab)}!A1:Z1`;
  const existing = await sheetsRequest<ValueRange>(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values/${range}`,
    token,
    config.spreadsheetId,
  );

  const current = (existing.values?.[0] ?? []).map(String);

  if (current.length === 0) {
    await sheetsRequest(
      `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values/${range}?valueInputOption=RAW`,
      token,
      config.spreadsheetId,
      { method: "PUT", body: JSON.stringify({ values: [headers] }) },
    );
    return true;
  }

  const isOlderHeader =
    current.length >= fixedCount &&
    current.length < headers.length &&
    current.every((header, index) => header === headers[index]);
  if (!isOlderHeader) return false;

  const tail = headers.slice(current.length);
  const tailRange = `${encodeURIComponent(tab)}!${columnLetter(current.length)}1:${columnLetter(headers.length - 1)}1`;
  await sheetsRequest(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values/${tailRange}?valueInputOption=RAW`,
    token,
    config.spreadsheetId,
    { method: "PUT", body: JSON.stringify({ values: [tail] }) },
  );
  return true;
}

/** Maps results onto the tab's fixed columns. */
export function toSheetRows(
  dentists: readonly Dentist[],
  provider: ProviderId,
  context: ExportContext,
): SheetCell[][] {
  const columns = sheetColumnsFor(provider);
  return dentists.map((dentist) =>
    columns.map((column) => {
      const value = column.value(dentist, context);
      if (typeof value === "number") return value;
      // An absent value becomes an empty cell, never a placeholder string.
      return value ?? "";
    }),
  );
}

/**
 * Works out how to write to this spreadsheet, and prepares whatever needs
 * preparing.
 *
 * Two documents can sit behind the same `/spreadsheets/d/...` link:
 *
 *   - a **native Google Sheet**, written cell by cell through the Sheets API;
 *   - an **uploaded .xlsx**, which the Sheets API refuses outright, and which
 *     is therefore edited through Drive: fetch the file, insert the rows,
 *     write it back to the same id.
 *
 * Deliberately separate from the append so the caller can run it *before* the
 * search. A spreadsheet that cannot be written to should fail in about a
 * second, rather than after fifteen seconds of Overpass queries whose results
 * are then thrown away.
 */
export async function ensureSheetReady(
  config: SheetsConfig,
  provider: ProviderId,
): Promise<SheetTarget> {
  const tab = SHEET_TAB_NAMES[provider];
  const columns = sheetColumnsFor(provider);
  const headers = columns.map((column) => column.header);
  const token = await getAccessToken(config);
  const meta = await getFileMeta(config.spreadsheetId, token);

  if (!meta.canEdit) {
    throw new ConfigurationError(
      `${LABEL}: the service account can see "${meta.name}" but cannot edit it. Share the spreadsheet with ${config.clientEmail} as an Editor rather than a Viewer.`,
      SAVE_PUBLIC_MESSAGE,
    );
  }

  if (isOfficeWorkbook(meta)) {
    /*
     * Nothing to bootstrap: the tab and header are handled inside the workbook
     * at append time, in one download-edit-upload cycle rather than three
     * round trips.
     */
    return {
      tab,
      provider,
      headers,
      token,
      mode: "office",
      fileName: meta.name,
      createdTab: false,
      wroteHeader: false,
    };
  }

  if (!isNativeSheet(meta)) {
    throw new ConfigurationError(
      `${LABEL}: "${meta.name}" is a ${meta.mimeType}, which is neither a Google Sheet nor an .xlsx workbook. Point SHEETS_SPREADSHEET_ID at a spreadsheet.`,
      SAVE_PUBLIC_MESSAGE,
    );
  }

  const createdTab = await ensureTab(config, token, tab);
  const wroteHeader = await ensureHeader(
    config,
    token,
    tab,
    headers,
    fixedColumnCount(columns),
  );

  return {
    tab,
    provider,
    headers,
    token,
    mode: "sheets",
    fileName: meta.name,
    createdTab,
    wroteHeader,
  };
}

/** Appends through the Sheets API, one values.append call. */
async function appendViaSheets(
  config: SheetsConfig,
  target: SheetTarget,
  rows: readonly SheetCell[][],
): Promise<void> {
  await sheetsRequest(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values/${encodeURIComponent(target.tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    target.token,
    config.spreadsheetId,
    { method: "POST", body: JSON.stringify({ values: rows }) },
  );
}

/**
 * Appends by rewriting the workbook in place.
 *
 * The file keeps its id, so the link, the sharing and the revision history all
 * survive - and Drive keeps the previous version, so a bad write is
 * recoverable through File > Version history.
 */
async function appendViaDrive(
  config: SheetsConfig,
  target: SheetTarget,
  rows: readonly SheetCell[][],
): Promise<void> {
  const workbook = await downloadFile(config.spreadsheetId, target.token);
  const updated = appendRowsToWorkbook(workbook, target.tab, rows, target.headers);
  await uploadFile(config.spreadsheetId, target.token, updated, XLSX_MIME);
}

/** What one save did to the tab. */
export interface SaveSummary {
  /** Practices the tab had never seen, appended. */
  added: number;
  /** Practices already in the tab whose row changed. */
  updated: number;
  /** Practices already in the tab with nothing new to write. */
  unchanged: number;
}

/** One existing row to rewrite: its 1-based sheet row and the full new values. */
export interface RowUpdate {
  row: number;
  values: SheetCell[];
}

export interface UpsertPlan {
  additions: SheetCell[][];
  updates: RowUpdate[];
  unchanged: number;
}

/** Every row of the tab, header first, as the API returns it. */
async function readTabRows(
  config: SheetsConfig,
  token: string,
  tab: string,
): Promise<string[][]> {
  const range = `${encodeURIComponent(tab)}!A:Z`;
  const existing = await sheetsRequest<ValueRange>(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values/${range}`,
    token,
    config.spreadsheetId,
  );
  return (existing.values ?? []).map((row) => row.map(String));
}

/**
 * Decides, row by row, what a save has to write.
 *
 * A row whose key the tab does not have is appended. A row whose key it has is
 * merged onto the existing one: a non-empty new value replaces the old, an
 * empty one leaves the old in place (a scan that has not run must not blank a
 * PMS found last time), and the Search ZIP keeps the value from the first save.
 * The row is rewritten only when that merge changed something. A key the tab
 * holds twice - saves made before this existed - matches its first occurrence.
 */
export function planUpsert(
  existing: readonly string[][],
  headers: readonly string[],
  rows: readonly SheetCell[][],
): UpsertPlan {
  const keyIndex = headers.indexOf(ROW_KEY_HEADER);
  const firstSeenIndex = headers.indexOf(FIRST_SEEN_HEADER);
  const text = (cell: SheetCell | undefined): string => String(cell ?? "").trim();

  const byKey = new Map<string, { row: number; cells: string[] }>();
  existing.slice(1).forEach((cells, index) => {
    const key = text(cells[keyIndex]);
    if (key && !byKey.has(key)) byKey.set(key, { row: index + 2, cells });
  });

  const plan: UpsertPlan = { additions: [], updates: [], unchanged: 0 };
  for (const row of rows) {
    const found = keyIndex === -1 ? undefined : byKey.get(text(row[keyIndex]));
    if (!found) {
      plan.additions.push(row);
      continue;
    }
    const merged = headers.map((_, i): SheetCell => {
      const current = found.cells[i] ?? "";
      if (i === firstSeenIndex && current.trim() !== "") return current;
      return text(row[i]) === "" ? current : (row[i] as SheetCell);
    });
    const changed = merged.some((cell, i) => text(cell) !== text(found.cells[i]));
    if (changed) plan.updates.push({ row: found.row, values: merged });
    else plan.unchanged += 1;
  }
  return plan;
}

/** Rewrites existing rows through the Sheets API, one values.batchUpdate call. */
async function updateViaSheets(
  config: SheetsConfig,
  target: SheetTarget,
  updates: readonly RowUpdate[],
): Promise<void> {
  const last = columnLetter(target.headers.length - 1);
  await sheetsRequest(
    `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}/values:batchUpdate`,
    target.token,
    config.spreadsheetId,
    {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: updates.map((update) => ({
          range: `${target.tab}!A${update.row}:${last}${update.row}`,
          values: [update.values],
        })),
      }),
    },
  );
}

/**
 * Saves rows into a tab `ensureSheetReady` has already prepared, and reports
 * what that took.
 *
 * The workbook path can only append (see xlsx-edit.ts), so an uploaded .xlsx
 * gets every row appended and no duplicate detection.
 */
export async function saveRows(
  config: SheetsConfig,
  target: SheetTarget,
  dentists: readonly Dentist[],
  context: ExportContext,
): Promise<SaveSummary> {
  const rows = toSheetRows(dentists, target.provider, context);
  if (rows.length === 0) return { added: 0, updated: 0, unchanged: 0 };

  if (target.mode === "office") {
    await appendViaDrive(config, target, rows);
    return { added: rows.length, updated: 0, unchanged: 0 };
  }

  const existing = await readTabRows(config, target.token, target.tab);
  const plan = planUpsert(existing, target.headers, rows);
  if (plan.updates.length > 0) await updateViaSheets(config, target, plan.updates);
  if (plan.additions.length > 0) await appendViaSheets(config, target, plan.additions);

  return {
    added: plan.additions.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged,
  };
}
