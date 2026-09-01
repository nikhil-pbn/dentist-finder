/**
 * Google Geocoding client - ZIP code lookup for the Google provider.
 *
 * Google's response shapes never leave this file. The API key is passed as a
 * query parameter because the Geocoding API requires it there; nothing in this
 * module ever logs a URL, and the shared HTTP layer reports only the host, so
 * the key cannot reach a log line.
 */
import { GOOGLE_GEOCODING_URL, GOOGLE_TIMEOUT_MS } from "@/lib/constants";
import { AppError, ConfigurationError, GeocodingError } from "@/lib/errors";
import { describeCause, parseJson, requestText } from "@/lib/providers/http";
import type { GeoLocation } from "@/lib/types";

interface GeocodeResult {
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
}

interface GeocodeResponse {
  results?: GeocodeResult[];
  status?: string;
  error_message?: string;
}

const LABEL = "Google Geocoding";

/** Trims Google's trailing country, so "Irvine, CA 92618, USA" reads better. */
function toDisplayName(result: GeocodeResult, zip: string): string {
  const formatted = result.formatted_address?.trim();
  if (!formatted) return zip;
  return formatted.replace(/,\s*USA$/i, "");
}

/**
 * Resolves a 5-digit US ZIP to a point, or `null` when Google has no such
 * postal code.
 *
 * @throws ConfigurationError when the key is rejected - a misconfiguration the
 * operator must fix, not a transient fault worth retrying.
 * @throws GeocodingError on any other upstream failure.
 */
export async function geocodeUsZip(
  zip: string,
  apiKey: string,
): Promise<GeoLocation | null> {
  const url = new URL(GOOGLE_GEOCODING_URL);
  // A component filter is exact, where a free-text query would guess.
  url.searchParams.set("components", `postal_code:${zip}|country:US`);
  url.searchParams.set("key", apiKey);

  try {
    const body = await requestText(url.toString(), {
      headers: { Accept: "application/json" },
      timeoutMs: GOOGLE_TIMEOUT_MS,
      label: LABEL,
    });

    const payload = parseJson<GeocodeResponse>(body, LABEL);

    switch (payload.status) {
      case "OK":
        break;
      case "ZERO_RESULTS":
        return null;
      case "REQUEST_DENIED":
        // Google's own error_message says which of the several causes it is -
        // bad key, API not enabled, or a key restriction - so pass it through.
        throw new ConfigurationError(
          `${LABEL} rejected the request (REQUEST_DENIED)${
            payload.error_message ? `: ${payload.error_message}` : ""
          }. Check that GOOGLE_MAPS_API_KEY is valid, that the Geocoding API is enabled for the project, and that any key restrictions (HTTP referrer or IP) allow server-side use.`,
        );
      case "OVER_QUERY_LIMIT":
        throw new GeocodingError(`${LABEL} quota exceeded (OVER_QUERY_LIMIT)`);
      default:
        throw new GeocodingError(
          `${LABEL} returned status ${payload.status ?? "(none)"}${
            payload.error_message ? `: ${payload.error_message}` : ""
          }`,
        );
    }

    const result = payload.results?.[0];
    if (!result) return null;

    const latitude = result.geometry?.location?.lat;
    const longitude = result.geometry?.location?.lng;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      throw new GeocodingError(`${LABEL} returned a result without coordinates`);
    }

    return { latitude, longitude, displayName: toDisplayName(result, zip) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new GeocodingError(`${LABEL} request failed: ${describeCause(error)}`, {
      cause: error,
    });
  }
}
