/**
 * Drive API access, used only for spreadsheets the Sheets API will not touch.
 *
 * A Drive-hosted .xlsx cannot be written cell by cell, so the file is fetched,
 * edited in memory and written back to the *same file id* - the link the user
 * already has keeps working and keeps its history.
 *
 * Server-only.
 */
import {
  DRIVE_FILES_URL,
  DRIVE_UPLOAD_URL,
  GOOGLE_SHEET_MIME,
  SHEETS_TIMEOUT_MS,
  XLSX_MIME,
} from "@/lib/constants";
import { ConfigurationError, SearchError } from "@/lib/errors";
import { describeCause } from "@/lib/providers/http";

const LABEL = "Google Drive";

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  /** False when the service account has read-only access. */
  canEdit: boolean;
}

/** Whether this file is a native Google Sheet, which the Sheets API can write. */
export function isNativeSheet(meta: DriveFileMeta): boolean {
  return meta.mimeType === GOOGLE_SHEET_MIME;
}

export function isOfficeWorkbook(meta: DriveFileMeta): boolean {
  return meta.mimeType === XLSX_MIME;
}

async function driveFetch(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SearchError(`${LABEL} request failed: ${describeCause(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    if (response.status === 403 || response.status === 404) {
      throw new ConfigurationError(
        `${LABEL} could not access the file (HTTP ${response.status}): ${body}. Share the spreadsheet with the service account as an Editor, and enable the Google Drive API for the project.`,
        "The spreadsheet is not set up for saving. The results are still exportable as Excel or CSV.",
      );
    }
    throw new SearchError(`${LABEL} returned HTTP ${response.status}: ${body}`);
  }

  return response;
}

export async function getFileMeta(
  fileId: string,
  token: string,
): Promise<DriveFileMeta> {
  const url = `${DRIVE_FILES_URL}/${fileId}?fields=id,name,mimeType,capabilities/canEdit&supportsAllDrives=true`;
  const response = await driveFetch(url, token);

  const payload = (await response.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    capabilities?: { canEdit?: boolean };
  };

  return {
    id: payload.id ?? fileId,
    name: payload.name ?? "(untitled)",
    mimeType: payload.mimeType ?? "",
    canEdit: payload.capabilities?.canEdit ?? false,
  };
}

/** Downloads the file's bytes. Only sane for the small workbooks this edits. */
export async function downloadFile(
  fileId: string,
  token: string,
): Promise<Buffer> {
  const url = `${DRIVE_FILES_URL}/${fileId}?alt=media&supportsAllDrives=true`;
  const response = await driveFetch(url, token);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Replaces the file's contents, keeping its id, name, link and revision
 * history. Drive keeps the previous version, so a bad write is recoverable
 * through File > Version history.
 */
export async function uploadFile(
  fileId: string,
  token: string,
  contents: Buffer,
  mimeType: string,
): Promise<void> {
  const url = `${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media&supportsAllDrives=true`;
  await driveFetch(url, token, {
    method: "PATCH",
    headers: { "Content-Type": mimeType },
    body: new Uint8Array(contents),
  });
}
