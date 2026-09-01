/**
 * Application-wide constants.
 *
 * Every "magic number" in the app (allowed limits, radii, timeouts, cache TTLs,
 * provider identifiers) lives here so behaviour can be reasoned about and tested
 * from a single place.
 */

/** Identifiers of every search provider the application knows about. */
export const PROVIDER_IDS = ["osm", "google"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEFAULT_PROVIDER_ID: ProviderId = "osm";

/** Preset result counts a user can request. Enforced on client and server. */
export const ALLOWED_RESULT_LIMITS = [20, 30, 50] as const;

export type ResultLimit = (typeof ALLOWED_RESULT_LIMITS)[number];

/**
 * A requested result count, where `null` means "no cap - return everything
 * found in the radius".
 *
 * Unlimited is safe to offer because the limit has never driven upstream cost:
 * the Overpass query is identical whatever the limit, and the full result set
 * for a point and radius is fetched and cached either way. The limit only
 * decides how much of that cached list is handed back, so the real bound on
 * work is MAX_RADIUS_METERS, not this value.
 */
export type ResultLimitOption = ResultLimit | null;

export const DEFAULT_RESULT_LIMIT: ResultLimitOption = 20;

/** The `limit` query-parameter value that means "no cap". */
export const UNLIMITED_LIMIT_PARAM = "all";

/** Search radii (in meters) a user is allowed to request. */
export const ALLOWED_RADIUS_METERS = [5000, 10000, 15000, 25000, 50000] as const;

export type RadiusMeters = (typeof ALLOWED_RADIUS_METERS)[number];

export const DEFAULT_RADIUS_METERS: RadiusMeters = 15000;

export const MIN_RADIUS_METERS = ALLOWED_RADIUS_METERS[0];
export const MAX_RADIUS_METERS =
  ALLOWED_RADIUS_METERS[ALLOWED_RADIUS_METERS.length - 1];

/**
 * OSM keys that can carry a business website, in preference order.
 *
 * Shared by the Overpass query filter and the normaliser so the set the server
 * asks for and the set the app reads can never drift apart.
 */
export const WEBSITE_TAG_KEYS = ["website", "contact:website", "url"] as const;

/**
 * Whether a result must have a website to be returned.
 *
 * Default on: a practice with no website is of little use to someone trying to
 * reach it, and filtering at the source means "50 results" is 50 usable ones.
 * Callers can opt out with `requireWebsite=0`.
 */
export const DEFAULT_REQUIRE_WEBSITE = true;

/** US ZIP code: five digits, optionally followed by a four digit ZIP+4 suffix. */
export const US_ZIP_REGEX = /^\d{5}(?:-\d{4})?$/;

/** Per-attempt outbound HTTP timeouts. Providers must never hang indefinitely. */
export const NOMINATIM_TIMEOUT_MS = 10_000;
export const OVERPASS_TIMEOUT_MS = 22_000;

/**
 * Server-side timeout embedded in the Overpass query itself. Kept below
 * OVERPASS_TIMEOUT_MS so Overpass can answer with a proper error before our
 * own AbortSignal fires.
 */
export const OVERPASS_QUERY_TIMEOUT_SECONDS = 20;

/**
 * Nominatim's usage policy allows at most one request per second. Outbound
 * geocoding requests are serialised with at least this much space between them.
 */
export const NOMINATIM_MIN_REQUEST_INTERVAL_MS = 1_100;

/** Cache tuning. See README ("Caching") for the rationale. */
export const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const GEOCODE_MISS_CACHE_TTL_MS = 60 * 60 * 1_000;
export const GEOCODE_CACHE_MAX_ENTRIES = 500;
export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1_000;
export const SEARCH_CACHE_MAX_ENTRIES = 200;

/** Very small in-process request budget, per client IP. See README. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 20;

/**
 * Two OSM objects are only ever considered the same business when they share a
 * name AND sit within this distance of each other (e.g. a POI node mapped
 * inside its own building way).
 */
export const DEDUPE_MAX_DISTANCE_METERS = 50;

/**
 * Limited, backoff-based retries against public endpoints. Never a retry storm.
 *
 * The public Overpass endpoint fails intermittently under load - measured at
 * roughly one request in three, as a 504 or a dropped connection - and a repeat
 * of the identical query usually succeeds. Two attempts left too many searches
 * failing outright, so a third is allowed, bounded by a wall-clock budget for
 * the whole operation so that retrying can never leave a user waiting for
 * minutes. A 429 is different in kind: it is the server explicitly saying "you
 * are over quota", so it is retried at most once, honouring `Retry-After`.
 */
export const PROVIDER_MAX_ATTEMPTS = 3;
export const PROVIDER_MAX_ATTEMPTS_AFTER_429 = 2;
export const PROVIDER_RETRY_BASE_DELAY_MS = 1_500;
export const PROVIDER_MAX_RETRY_DELAY_MS = 4_000;

/** Wall-clock ceiling for one upstream operation, retries and backoff included. */
export const PROVIDER_TOTAL_BUDGET_MS = 50_000;

/** Never start another attempt with less budget left than this. */
export const PROVIDER_MIN_ATTEMPT_MS = 4_000;

/* --- Google provider ------------------------------------------------------ */

export const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * Places API (New) Text Search. Chosen over Nearby Search because Nearby
 * returns at most 20 results with no pagination, which could not satisfy a
 * request for 30, 50 or "all".
 */
export const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";

export const GOOGLE_TIMEOUT_MS = 10_000;

/** Places returns at most 20 per page and 3 pages, so 60 is Google's ceiling. */
export const GOOGLE_PAGE_SIZE = 20;
export const GOOGLE_MAX_PAGES = 3;
export const GOOGLE_MAX_RESULTS = GOOGLE_PAGE_SIZE * GOOGLE_MAX_PAGES;

/**
 * Fields requested from Places. The mask is mandatory and also determines the
 * billing SKU, so it asks for exactly what the Dentist model uses and no more.
 */
export const GOOGLE_PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.types",
  "places.regularOpeningHours.weekdayDescriptions",
  // `currentOpeningHours` honours holiday and special hours where
  // `regularOpeningHours` does not, so it is preferred for "open now".
  // Both sit in the same billing tier as the rating and phone fields above,
  // so neither adds an SKU.
  "places.currentOpeningHours.openNow",
  "places.regularOpeningHours.openNow",
  "nextPageToken",
].join(",");

/** Public endpoints used by the OSM provider. Overridable via configuration. */
export const DEFAULT_NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Nominatim requires a descriptive, application-specific User-Agent. A generic
 * one (or a browser one) is grounds for being blocked.
 */
export const DEFAULT_OSM_USER_AGENT =
  "DentistFinder/1.0 (https://github.com/dentist-finder)";
