/**
 * The one place the browser talks to `/api/dentists`.
 *
 * Components call `fetchDentists`; none of them build URLs, parse payloads or
 * interpret status codes. Safe for Client Components: it imports only the
 * shared domain types, never configuration or provider code.
 */
import { UNLIMITED_LIMIT_PARAM } from "@/lib/constants";
import type {
  DentistSearchApiResponse,
  DentistSearchErrorResponse,
  DentistSearchResponse,
  PmsDetectStartApiResponse,
  PmsDetectStartResponse,
  PmsJobApiResponse,
  PmsJobResponse,
  SearchQuery,
  SheetSaveApiResponse,
  SheetSaveResponse,
} from "@/lib/types";

export const DENTISTS_ENDPOINT = "/api/dentists";
export const SHEET_SAVE_ENDPOINT = "/api/dentists/save";
export const PMS_DETECT_ENDPOINT = "/api/pms/detect";
export const PMS_JOBS_ENDPOINT = "/api/pms/jobs";

/** A failed search, carrying a message that is already safe to display. */
export class DentistSearchRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Development-only operator detail; absent in production. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DentistSearchRequestError";
  }
}

const GENERIC_FAILURE =
  "The dentist search service is temporarily unavailable. Please try again.";

const SHEET_SAVE_FAILURE =
  "Could not save to the spreadsheet. Please try again.";

/** Builds the canonical query string, shared by the request and the page URL. */
export function toSearchParams(query: SearchQuery): URLSearchParams {
  return new URLSearchParams({
    zip: query.zip,
    limit: query.limit === null ? UNLIMITED_LIMIT_PARAM : String(query.limit),
    radius: String(query.radiusMeters),
    requireWebsite: query.requireWebsite ? "1" : "0",
  });
}

/**
 * Runs a search.
 *
 * @param signal aborts an in-flight search when a newer one replaces it.
 * @throws DentistSearchRequestError with a user-presentable message.
 */
export async function fetchDentists(
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<DentistSearchResponse> {
  let response: Response;
  try {
    response = await fetch(`${DENTISTS_ENDPOINT}?${toSearchParams(query)}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    // Let an intentional abort propagate; the caller ignores it.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DentistSearchRequestError(
      "Could not reach the search service. Check your connection and try again.",
      "NETWORK_ERROR",
    );
  }

  let payload: DentistSearchApiResponse | null = null;
  try {
    payload = (await response.json()) as DentistSearchApiResponse;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new DentistSearchRequestError(GENERIC_FAILURE, "BAD_RESPONSE");
  }

  if (!response.ok || !payload.success) {
    const error = payload.success ? null : payload;
    throw new DentistSearchRequestError(
      error?.error ?? GENERIC_FAILURE,
      error?.code ?? "UNKNOWN",
      error?.detail,
    );
  }

  return payload;
}

/**
 * Appends the results of a search to the configured Google Sheet.
 *
 * The query goes over the wire, not the rows: the server re-runs the search and
 * appends what the provider returned, so this endpoint cannot be used to write
 * arbitrary data into the spreadsheet.
 *
 * @throws DentistSearchRequestError with a user-presentable message.
 */
export async function saveToSheet(
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<SheetSaveResponse> {
  let response: Response;
  try {
    response = await fetch(`${SHEET_SAVE_ENDPOINT}?${toSearchParams(query)}`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DentistSearchRequestError(
      "Could not reach the server. Check your connection and try again.",
      "NETWORK_ERROR",
    );
  }

  let payload: SheetSaveApiResponse | null = null;
  try {
    payload = (await response.json()) as SheetSaveApiResponse;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new DentistSearchRequestError(SHEET_SAVE_FAILURE, "BAD_RESPONSE");
  }

  if (!response.ok || !payload.success) {
    const error = payload.success ? null : payload;
    throw new DentistSearchRequestError(
      error?.error ?? SHEET_SAVE_FAILURE,
      error?.code ?? "UNKNOWN",
      error?.detail,
    );
  }

  return payload;
}

const PMS_FAILURE = "Could not run PMS detection. Please try again.";

/** Shared request/parse step for the PMS endpoints. */
async function requestPms<T extends { success: true }>(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DentistSearchRequestError(
      "Could not reach the server. Check your connection and try again.",
      "NETWORK_ERROR",
    );
  }

  let payload: T | DentistSearchErrorResponse | null = null;
  try {
    payload = (await response.json()) as T | DentistSearchErrorResponse;
  } catch {
    payload = null;
  }

  if (!payload) throw new DentistSearchRequestError(PMS_FAILURE, "BAD_RESPONSE");

  if (!response.ok || !payload.success) {
    const error = payload.success ? null : payload;
    throw new DentistSearchRequestError(
      error?.error ?? PMS_FAILURE,
      error?.code ?? "UNKNOWN",
      error?.detail,
    );
  }
  return payload;
}

/**
 * Starts (or joins) a PMS scan of the dentists this search returns.
 *
 * The query goes over the wire, not the websites: the server re-runs the
 * cached search and scans what the provider returned.
 */
export function startPmsDetection(
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<PmsDetectStartResponse> {
  return requestPms<PmsDetectStartApiResponse & { success: true }>(
    `${PMS_DETECT_ENDPOINT}?${toSearchParams(query)}`,
    { method: "POST" },
    signal,
  );
}

/** Current state of a scan job. Throws `JOB_NOT_FOUND` once the server forgot it. */
export function fetchPmsJob(jobId: string, signal?: AbortSignal): Promise<PmsJobResponse> {
  return requestPms<PmsJobApiResponse & { success: true }>(
    `${PMS_JOBS_ENDPOINT}/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    signal,
  );
}

/** Stops a running scan job; answers with its final state. */
export function stopPmsJob(jobId: string, signal?: AbortSignal): Promise<PmsJobResponse> {
  return requestPms<PmsJobApiResponse & { success: true }>(
    `${PMS_JOBS_ENDPOINT}/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
    signal,
  );
}
