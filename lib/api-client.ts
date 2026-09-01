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
  DentistSearchResponse,
  SearchQuery,
} from "@/lib/types";

export const DENTISTS_ENDPOINT = "/api/dentists";

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
