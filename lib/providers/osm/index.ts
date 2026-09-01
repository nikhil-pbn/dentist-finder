/**
 * OpenStreetMap implementation of `DentistSearchProvider`.
 *
 * Composes the two OSM services behind one interface:
 *   ZIP -> Nominatim -> coordinates -> Overpass -> normalised dentists.
 *
 * Caching lives here rather than in the HTTP clients so that both public
 * endpoints are protected by the same policy, and so a provider swap takes its
 * cache with it. See README ("Caching") for TTLs and their rationale.
 */
import {
  GEOCODE_CACHE_MAX_ENTRIES,
  GEOCODE_CACHE_TTL_MS,
  GEOCODE_MISS_CACHE_TTL_MS,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
} from "@/lib/constants";
import { TtlCache } from "@/lib/cache";
import type { OsmConfig } from "@/lib/config";
import { ZipNotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Dentist, GeoLocation } from "@/lib/types";
import type {
  DentistSearchProvider,
  SearchDentistsParams,
} from "@/lib/providers/types";
import { geocodeUsZip } from "@/lib/providers/osm/nominatim";
import { normalizeElements } from "@/lib/providers/osm/normalize";
import { fetchDentistElements } from "@/lib/providers/osm/overpass";

/** `null` records a confirmed "this ZIP does not exist", not a failed lookup. */
type CachedLocation = GeoLocation | null;

/**
 * Applies the requested cap. A `null` limit returns the whole set - the cached
 * list is already the complete answer for this point and radius, so this costs
 * nothing extra upstream.
 */
function applyLimit(dentists: Dentist[], limit: number | null): Dentist[] {
  return limit === null ? [...dentists] : dentists.slice(0, limit);
}

export class OsmDentistSearchProvider implements DentistSearchProvider {
  readonly id = "osm" as const;

  private readonly geocodeCache = new TtlCache<CachedLocation>(
    GEOCODE_CACHE_TTL_MS,
    GEOCODE_CACHE_MAX_ENTRIES,
  );

  private readonly searchCache = new TtlCache<Dentist[]>(
    SEARCH_CACHE_TTL_MS,
    SEARCH_CACHE_MAX_ENTRIES,
  );

  constructor(private readonly config: OsmConfig) {}

  /**
   * ZIP centroids essentially never move, so a hit is cached for a day and a
   * miss for an hour - long enough that repeating a search costs Nominatim
   * nothing, short enough that a newly added postcode appears the same day.
   */
  async geocodeZip(zip: string): Promise<GeoLocation> {
    const cached = this.geocodeCache.get(zip);
    if (cached !== undefined) {
      if (cached === null) throw new ZipNotFoundError(zip);
      return cached;
    }

    const location = await geocodeUsZip(zip, this.config);
    this.geocodeCache.set(
      zip,
      location,
      location ? GEOCODE_CACHE_TTL_MS : GEOCODE_MISS_CACHE_TTL_MS,
    );

    if (!location) throw new ZipNotFoundError(zip);
    return location;
  }

  /**
   * The cache key deliberately excludes `limit`: the full normalised result set
   * for a point and radius is stored once, so switching between 20/30/50 for
   * the same search does not touch Overpass again.
   */
  async searchDentists({
    latitude,
    longitude,
    radiusMeters,
    limit,
    requireWebsite,
  }: SearchDentistsParams): Promise<Dentist[]> {
    const origin = { latitude, longitude };
    // `requireWebsite` is part of the key because it changes the query sent
    // upstream, so the two variants are genuinely different result sets.
    const cacheKey = [
      latitude.toFixed(4),
      longitude.toFixed(4),
      radiusMeters,
      requireWebsite ? "web" : "all",
    ].join(",");

    const cached = this.searchCache.get(cacheKey);
    if (cached) return applyLimit(cached, limit);

    const elements = await fetchDentistElements(
      latitude,
      longitude,
      radiusMeters,
      requireWebsite,
      this.config,
    );
    const dentists = normalizeElements(elements, origin, { requireWebsite });

    logger.info("osm_search_completed", {
      radiusMeters,
      requireWebsite,
      elements: elements.length,
      normalized: dentists.length,
    });

    this.searchCache.set(cacheKey, dentists);

    // Fewer results than requested is a correct answer, never padded.
    return applyLimit(dentists, limit);
  }
}
