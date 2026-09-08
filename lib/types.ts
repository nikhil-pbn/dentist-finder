/**
 * Provider-independent domain model.
 *
 * These are the ONLY shapes the API route, the React components, and the CSV
 * export are allowed to know about. Provider specific shapes (Overpass
 * elements, Nominatim places, Google Places results, ...) stay inside their
 * provider folder and are mapped into this model there.
 */
import type {
  ProviderId,
  RadiusMeters,
  ResultLimitOption,
} from "@/lib/constants";
import type { PMSJob } from "@/lib/pms/types";

/** A geocoded point, as returned by a provider's ZIP lookup. */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** Human readable label for the resolved area, e.g. "Irvine, CA 92618". */
  displayName: string;
}

/**
 * A single dentist business.
 *
 * Every field a provider may not know is `T | null` — never a fabricated
 * placeholder. Nothing is optional: a provider that cannot supply a field must
 * say so explicitly with `null`, so a forgotten mapping is a build error rather
 * than a silently absent column.
 */
export interface Dentist {
  /** Stable, globally unique: `${source}:${sourceId}`. */
  id: string;
  name: string | null;
  /** Exactly as the source gave it. Google includes the country here. */
  address: string | null;
  /**
   * Display form of `address` with the trailing country removed, so Google's
   * "123 Main St, Irvine, CA 92618, USA" reads as "123 Main St, Irvine, CA
   * 92618". Derived, never re-composed from parts. Under OSM the address is
   * already country-free and this mirrors it.
   */
  shortAddress: string | null;
  /** E.164-style where the source has it, e.g. "+1 949-555-1234". */
  phone: string | null;
  website: string | null;
  email: string | null;
  /*
   * Always present, whatever the CSV export happens to include: an element
   * without coordinates is dropped by the provider, and distance sorting,
   * de-duplication and map links all depend on these.
   */
  latitude: number;
  longitude: number;
  openingHours: string | null;
  /**
   * Whether the practice is open at the moment the provider answered.
   *
   * `null` means "not known", which is always the case under OSM: an
   * `opening_hours` tag is a grammar, not a boolean, and guessing at it would
   * be inventing a fact. Time-sensitive by nature — see the note on the search
   * cache TTL in the README.
   */
  currentOpen: boolean | null;
  /** Built by the provider, so the UI never branches on `source`. */
  mapUrl: string | null;
  /** Great-circle distance from the searched ZIP centre, or null if unknown. */
  distanceKm: number | null;
  source: ProviderId;
  sourceId: string | null;

  /* Provider-dependent enrichment. OSM has none of it and says so with null. */
  rating: number | null;
  /** Number of reviews behind `rating`, not the reviews themselves. */
  reviews: number | null;
  businessStatus: string | null;
  categories: string[] | null;

  /**
   * The practice-management or patient-engagement vendor whose URLs appear on
   * `website` - "Denticon", or "Weave, Denticon" when several - or null when
   * none was found or no scan has run. Providers always set null; the PMS
   * detector fills it, and the table, the file exports and the sheet all read
   * it from here.
   *
   * Null is not evidence of "no PMS": it says only that the public website
   * showed no known vendor URL.
   */
  pms: string | null;
}

/** A validated search request. Only ever produced by `lib/validation.ts`. */
export interface SearchQuery {
  /** Normalised 5-digit ZIP used for geocoding. */
  zip: string;
  /** `null` means no cap: return every match inside the radius. */
  limit: ResultLimitOption;
  radiusMeters: RadiusMeters;
  /** When true, only results that have a usable website are returned. */
  requireWebsite: boolean;
}

/** Successful `/api/dentists` payload. */
export interface DentistSearchResponse {
  success: true;
  query: SearchQuery;
  location: GeoLocation;
  count: number;
  dentists: Dentist[];
}

/**
 * Failed `/api/dentists` payload.
 *
 * `error` is always safe to show a user. `detail` carries the operator-facing
 * reason and is populated **only outside production, and only for
 * configuration errors** - the class of failure where the person looking at the
 * screen is the person who must fix it. It never contains a secret.
 */
/** Successful `/api/dentists/save` payload. */
export interface SheetSaveResponse {
  success: true;
  /** The tab the rows went into: the provider's own id. */
  tab: string;
  /** Practices the tab had never seen, appended. */
  added: number;
  /** Practices already in the tab whose row changed. */
  updated: number;
  /** Practices already in the tab with nothing new to write. */
  unchanged: number;
  spreadsheetUrl: string;
}

export type SheetSaveApiResponse =
  | SheetSaveResponse
  | DentistSearchErrorResponse;

export interface DentistSearchErrorResponse {
  success: false;
  error: string;
  code: string;
  detail?: string;
}

export type DentistSearchApiResponse =
  | DentistSearchResponse
  | DentistSearchErrorResponse;

/** Successful `POST /api/pms/detect` payload. */
export interface PmsDetectStartResponse {
  success: true;
  jobId: string;
  /** True when a scan of the same search was already running and was reused. */
  reused: boolean;
  job: PMSJob;
}

export type PmsDetectStartApiResponse =
  | PmsDetectStartResponse
  | DentistSearchErrorResponse;

/** Successful `GET /api/pms/jobs/[jobId]` payload. */
export interface PmsJobResponse {
  success: true;
  job: PMSJob;
}

export type PmsJobApiResponse = PmsJobResponse | DentistSearchErrorResponse;
