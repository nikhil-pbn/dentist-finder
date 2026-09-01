/**
 * Overpass API client - dentist lookup for the OSM provider.
 *
 * Overpass element shapes never leave this file and `normalize.ts`; the rest of
 * the application only ever sees the normalised `Dentist` model.
 */
import {
  OVERPASS_QUERY_TIMEOUT_SECONDS,
  OVERPASS_TIMEOUT_MS,
  WEBSITE_TAG_KEYS,
} from "@/lib/constants";
import { AppError, SearchError } from "@/lib/errors";
import { describeCause, parseJson, requestText } from "@/lib/providers/http";
import type { OsmConfig } from "@/lib/config";

export type OverpassElementType = "node" | "way" | "relation";

/** A single OSM object. Ways and relations carry `center` instead of lat/lon. */
export interface OverpassElement {
  type: OverpassElementType;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: unknown;
  /** Overpass reports query/server problems here, often with HTTP 200. */
  remark?: string;
}

const LABEL = "Overpass";

/**
 * Matches an element carrying any of the website keys with a non-empty value,
 * using Overpass's regular-expression key filter: `[~"keys"~"value"]`.
 *
 * Applying it in the query rather than after the fetch means the upstream never
 * sends records that are about to be discarded, and `limit` is spent entirely
 * on results the caller can use.
 */
const WEBSITE_TAG_FILTER = `[~"^(${WEBSITE_TAG_KEYS.join("|")})$"~"."]`;

/**
 * `out center` is what makes ways and relations usable: it attaches a
 * representative point to geometries that have no coordinates of their own.
 */
export function buildOverpassQuery(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  requireWebsite: boolean,
): string {
  const around = `${radiusMeters},${latitude},${longitude}`;
  const match = `["amenity"="dentist"]${requireWebsite ? WEBSITE_TAG_FILTER : ""}`;
  return [
    `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];`,
    "(",
    `  node${match}(around:${around});`,
    `  way${match}(around:${around});`,
    `  relation${match}(around:${around});`,
    ");",
    "out center;",
  ].join("\n");
}

function isOverpassElement(value: unknown): value is OverpassElement {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OverpassElement>;
  return (
    (candidate.type === "node" ||
      candidate.type === "way" ||
      candidate.type === "relation") &&
    typeof candidate.id === "number"
  );
}

/**
 * Runs the dentist query and returns the raw elements.
 *
 * An empty result set is a valid answer, not an error - some radii genuinely
 * contain no mapped dentists.
 *
 * @throws SearchError on HTTP errors, malformed JSON or an Overpass `remark`.
 * @throws ProviderTimeoutError when Overpass exceeds the client timeout.
 */
export async function fetchDentistElements(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  requireWebsite: boolean,
  config: OsmConfig,
): Promise<OverpassElement[]> {
  const query = buildOverpassQuery(
    latitude,
    longitude,
    radiusMeters,
    requireWebsite,
  );

  try {
    const body = await requestText(config.overpassUrls, {
      method: "POST",
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ data: query }).toString(),
      timeoutMs: OVERPASS_TIMEOUT_MS,
      label: LABEL,
    });

    const payload = parseJson<OverpassResponse>(body, LABEL);

    // Overpass answers "runtime error: Query timed out" with HTTP 200.
    if (typeof payload.remark === "string" && payload.remark.length > 0) {
      throw new SearchError(`${LABEL} remark: ${payload.remark}`);
    }

    if (!Array.isArray(payload.elements)) {
      // A payload with no `elements` array and no remark is simply empty.
      return [];
    }

    return payload.elements.filter(isOverpassElement);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // describeCause unwraps fetch's opaque "fetch failed" into the real reason.
    throw new SearchError(`${LABEL} request failed: ${describeCause(error)}`, {
      cause: error,
    });
  }
}
