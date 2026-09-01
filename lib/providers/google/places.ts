/**
 * Google Places (New) Text Search client.
 *
 * Text Search rather than Nearby Search: Nearby returns at most 20 results and
 * offers no pagination, so it could never satisfy a request for 30, 50 or
 * "all". Text Search pages 20 at a time up to a hard ceiling of 60.
 *
 * Its `locationRestriction` accepts only a rectangle, so a circle is supplied
 * as `locationBias` and the exact radius is enforced by the caller, which
 * already computes distances for sorting.
 *
 * Place shapes never leave this file and `normalize.ts`.
 */
import {
  GOOGLE_MAX_PAGES,
  GOOGLE_PAGE_SIZE,
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_PLACES_SEARCH_TEXT_URL,
  GOOGLE_TIMEOUT_MS,
} from "@/lib/constants";
import { AppError, ConfigurationError, SearchError } from "@/lib/errors";
import {
  describeCause,
  HttpStatusError,
  parseJson,
  requestText,
} from "@/lib/providers/http";

export interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
  currentOpeningHours?: { openNow?: boolean };
}

interface SearchTextResponse {
  places?: GooglePlace[];
  nextPageToken?: string;
}

const LABEL = "Google Places";

/**
 * Distinguishes "your key or project is wrong" from "the service wobbled".
 *
 * Google does not use 401 for a bad key: an invalid key comes back as HTTP 400
 * with `API_KEY_INVALID`, and a disabled API or a key restriction as 403. All
 * of them are operator problems that retrying cannot fix, so they surface as a
 * ConfigurationError with an actionable message.
 */
const KEY_PROBLEM = /api[ _]?key|api_key_invalid|permission_denied|not authorized|has not been used/i;

function isConfigurationFailure(error: HttpStatusError): boolean {
  if (error.status === 401 || error.status === 403) return true;
  return error.status === 400 && KEY_PROBLEM.test(error.bodySnippet);
}

/**
 * Fetches dentists near a point, following pagination until `wanted` results
 * are collected or Google runs out.
 *
 * `wanted` is a hint, not a guarantee: Google's own ceiling is 60, and the
 * caller still filters by exact radius afterwards.
 */
export async function searchDentistPlaces(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  wanted: number,
  apiKey: string,
): Promise<GooglePlace[]> {
  const places: GooglePlace[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < GOOGLE_MAX_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      textQuery: "dentist",
      includedType: "dentist",
      strictTypeFiltering: true,
      languageCode: "en",
      regionCode: "US",
      pageSize: GOOGLE_PAGE_SIZE,
      locationBias: {
        circle: {
          center: { latitude, longitude },
          radius: radiusMeters,
        },
      },
    };
    // Every other parameter must stay identical when paging.
    if (pageToken) body.pageToken = pageToken;

    let payload: SearchTextResponse;
    try {
      const text = await requestText(GOOGLE_PLACES_SEARCH_TEXT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // The key travels in a header here, never in the URL.
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
        timeoutMs: GOOGLE_TIMEOUT_MS,
        label: LABEL,
      });
      payload = parseJson<SearchTextResponse>(text, LABEL);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof HttpStatusError && isConfigurationFailure(error)) {
        throw new ConfigurationError(
          `${LABEL} rejected the request with HTTP ${error.status}: ${error.bodySnippet}. Check that GOOGLE_MAPS_API_KEY is valid, that the Places API (New) is enabled for the project, and that any key restrictions allow server-side use.`,
        );
      }
      throw new SearchError(`${LABEL} request failed: ${describeCause(error)}`, {
        cause: error,
      });
    }

    if (Array.isArray(payload.places)) places.push(...payload.places);

    pageToken = payload.nextPageToken;
    // Stop as soon as there is nothing more to fetch, or enough to answer with.
    if (!pageToken || places.length >= wanted) break;
  }

  return places;
}
