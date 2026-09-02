/**
 * Appends results to a Google Sheet, one tab per provider.
 *
 * The tab and its header row are created on first use, so a fresh spreadsheet
 * needs no manual setup. Rows are appended, never overwritten - the sheet is a
 * running log, and losing an earlier search to a later one would be a
 * surprising way to lose data.
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

/** Appends rows to a tab `ensureSheetReady` has already prepared. */
export async function appendRows(
  config: SheetsConfig,
  target: SheetTarget,
  dentists: readonly Dentist[],
  context: ExportContext,
): Promise<number> {
  const rows = toSheetRows(dentists, target.provider, context);
  if (rows.length === 0) return 0;

  if (target.mode === "office") {
    await appendViaDrive(config, target, rows);
  } else {
    await appendViaSheets(config, target, rows);
  }

  return rows.length;
}
