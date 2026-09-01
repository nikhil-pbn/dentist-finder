/**
 * Request validation.
 *
 * Shared by the API route (authoritative) and the search form (fast feedback).
 * Contains no provider or server-only imports, so it is safe on the client.
 */
import {
  ALLOWED_RADIUS_METERS,
  ALLOWED_RESULT_LIMITS,
  DEFAULT_RADIUS_METERS,
  DEFAULT_REQUIRE_WEBSITE,
  DEFAULT_RESULT_LIMIT,
  UNLIMITED_LIMIT_PARAM,
  US_ZIP_REGEX,
  type RadiusMeters,
  type ResultLimit,
  type ResultLimitOption,
} from "@/lib/constants";
import { InvalidParameterError, InvalidZipError } from "@/lib/errors";
import type { SearchQuery } from "@/lib/types";

/** True for `12345` and `12345-6789`. */
export function isValidUsZip(value: string): boolean {
  return US_ZIP_REGEX.test(value.trim());
}

/**
 * Reduces any accepted ZIP form to the 5-digit base code.
 * ZIP+4 suffixes are accepted from users but are not mapped in OSM, so only
 * the base code is ever sent to a geocoder.
 */
export function normalizeZip(value: string): string {
  return value.trim().slice(0, 5);
}

/** Client-friendly check. Returns a message, or `null` when the ZIP is fine. */
export function getZipValidationError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Please enter a ZIP code.";
  if (!isValidUsZip(trimmed)) return "Please enter a valid US ZIP code.";
  return null;
}

export function parseZip(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidZipError("Missing zip parameter");
  }
  if (!isValidUsZip(value)) {
    throw new InvalidZipError(`Malformed zip parameter: ${value.slice(0, 32)}`);
  }
  return normalizeZip(value);
}

function parseFromAllowList<T extends number>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
  publicMessage: string,
  parameterName: string,
): T {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    throw new InvalidParameterError(
      publicMessage,
      `Non-numeric ${parameterName}: ${String(raw).slice(0, 32)}`,
    );
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new InvalidParameterError(
      publicMessage,
      `Disallowed ${parameterName}: ${value}`,
    );
  }
  return match;
}

const LIMIT_MESSAGE = `Choose one of the supported result counts: ${ALLOWED_RESULT_LIMITS.join(
  ", ",
)}, or "${UNLIMITED_LIMIT_PARAM}" for no limit.`;

const RADIUS_MESSAGE = `Choose one of the supported search radii: ${ALLOWED_RADIUS_METERS.map(
  (meters) => `${meters / 1000} km`,
).join(", ")}.`;

/**
 * A preset count or `null` for no cap. Arbitrary numbers are still refused: an
 * unbounded request is an explicit, named choice rather than something a client
 * can stumble into with `limit=99999`.
 */
export function parseResultLimit(raw: unknown): ResultLimitOption {
  // Absent means "not specified", not "no limit": `URLSearchParams.get()`
  // returns null for a missing parameter, and a missing `limit` must never
  // silently uncap the request. Only the explicit sentinel does that.
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_RESULT_LIMIT;
  }
  if (String(raw).trim().toLowerCase() === UNLIMITED_LIMIT_PARAM) return null;

  return parseFromAllowList<ResultLimit>(
    raw,
    ALLOWED_RESULT_LIMITS,
    // Unreachable: the empty cases are handled above.
    ALLOWED_RESULT_LIMITS[0],
    LIMIT_MESSAGE,
    "limit",
  );
}

/** Only the offered radii - this also caps the work Overpass is asked to do. */
export function parseRadiusMeters(raw: unknown): RadiusMeters {
  return parseFromAllowList(
    raw,
    ALLOWED_RADIUS_METERS,
    DEFAULT_RADIUS_METERS,
    RADIUS_MESSAGE,
    "radius",
  );
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Parses the website filter flag. Absent means the default; anything that is
 * neither clearly true nor clearly false is rejected rather than guessed at, so
 * a typo cannot silently widen a search.
 */
export function parseRequireWebsite(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_REQUIRE_WEBSITE;
  }
  if (typeof raw === "boolean") return raw;

  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;

  throw new InvalidParameterError(
    "The website filter must be either on or off.",
    `Unparseable requireWebsite: ${value.slice(0, 32)}`,
  );
}

/** Turns raw request query parameters into a validated `SearchQuery`. */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  return {
    zip: parseZip(params.get("zip")),
    limit: parseResultLimit(params.get("limit")),
    radiusMeters: parseRadiusMeters(params.get("radius")),
    requireWebsite: parseRequireWebsite(params.get("requireWebsite")),
  };
}

/** Structural type so this module never has to import a router package. */
export interface ReadableSearchParams {
  get(name: string): string | null;
}

function withFallback<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Non-throwing counterpart of `parseSearchQuery`, for reading the page URL.
 *
 * A shared or hand-edited link should populate the form rather than blow up, so
 * unusable values silently fall back to the defaults. The API route still
 * validates strictly - this is convenience, not a security boundary.
 */
export function readSearchQuery(params: ReadableSearchParams): {
  query: SearchQuery;
  hasValidZip: boolean;
} {
  const rawZip = params.get("zip") ?? "";
  const hasValidZip = isValidUsZip(rawZip);

  return {
    query: {
      zip: hasValidZip ? normalizeZip(rawZip) : "",
      limit: withFallback(
        () => parseResultLimit(params.get("limit")),
        DEFAULT_RESULT_LIMIT,
      ),
      radiusMeters: withFallback(
        () => parseRadiusMeters(params.get("radius")),
        DEFAULT_RADIUS_METERS,
      ),
      requireWebsite: withFallback(
        () => parseRequireWebsite(params.get("requireWebsite")),
        DEFAULT_REQUIRE_WEBSITE,
      ),
    },
    hasValidZip,
  };
}
