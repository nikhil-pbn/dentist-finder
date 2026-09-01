/**
 * Google implementation of `DentistSearchProvider`.
 *
 * Composes the two Google services behind the same interface the OSM provider
 * satisfies: ZIP -> Geocoding -> coordinates -> Places Text Search -> dentists.
 *
 * Nothing above this folder changed to enable it. The API route, components,
 * CSV export and domain model are identical for both providers; selecting this
 * one is `MAP_PROVIDER=google` plus a key.
 *
 * Two honest differences from the OSM provider, documented in the README:
 *   - Places has no email field, so `email` is always null here.
 *   - Places returns at most 60 results, so "no limit" means "up to 60".
 */
import {
  GEOCODE_CACHE_MAX_ENTRIES,
  GEOCODE_CACHE_TTL_MS,
  GEOCODE_MISS_CACHE_TTL_MS,
  GOOGLE_MAX_RESULTS,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
} from "@/lib/constants";
import { TtlCache } from "@/lib/cache";
import type { GoogleConfig } from "@/lib/config";
import { ConfigurationError, ZipNotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Dentist, GeoLocation } from "@/lib/types";
import type {
  DentistSearchProvider,
  SearchDentistsParams,
} from "@/lib/providers/types";
import { geocodeUsZip } from "@/lib/providers/google/geocoding";
import { normalizePlaces } from "@/lib/providers/google/normalize";
import { searchDentistPlaces } from "@/lib/providers/google/places";

type CachedLocation = GeoLocation | null;

function applyLimit(dentists: Dentist[], limit: number | null): Dentist[] {
  return limit === null ? [...dentists] : dentists.slice(0, limit);
}

export class GoogleDentistSearchProvider implements DentistSearchProvider {
  readonly id = "google" as const;

  private readonly geocodeCache = new TtlCache<CachedLocation>(
    GEOCODE_CACHE_TTL_MS,
    GEOCODE_CACHE_MAX_ENTRIES,
  );

  private readonly searchCache = new TtlCache<Dentist[]>(
    SEARCH_CACHE_TTL_MS,
    SEARCH_CACHE_MAX_ENTRIES,
  );

  constructor(private readonly config: GoogleConfig) {}

  /**
   * `loadConfig` already refuses to start with `MAP_PROVIDER=google` and no
   * key, so this is a belt-and-braces guard that also narrows the type.
   */
  private requireApiKey(): string {
    if (!this.config.apiKey) {
      throw new ConfigurationError(
        "Google provider selected but GOOGLE_MAPS_API_KEY is not configured.",
      );
    }
    return this.config.apiKey;
  }

  async geocodeZip(zip: string): Promise<GeoLocation> {
    const cached = this.geocodeCache.get(zip);
    if (cached !== undefined) {
      if (cached === null) throw new ZipNotFoundError(zip);
      return cached;
    }

    const location = await geocodeUsZip(zip, this.requireApiKey());
    this.geocodeCache.set(
      zip,
      location,
      location ? GEOCODE_CACHE_TTL_MS : GEOCODE_MISS_CACHE_TTL_MS,
    );

    if (!location) throw new ZipNotFoundError(zip);
    return location;
  }

  async searchDentists({
    latitude,
    longitude,
    radiusMeters,
    limit,
    requireWebsite,
  }: SearchDentistsParams): Promise<Dentist[]> {
    const origin = { latitude, longitude };
    const cacheKey = [
      latitude.toFixed(4),
      longitude.toFixed(4),
      radiusMeters,
      requireWebsite ? "web" : "all",
    ].join(",");

    const cached = this.searchCache.get(cacheKey);
    if (cached) return applyLimit(cached, limit);

    /*
     * Every page is a separately billed Places request, so fetch only as far as
     * the caller could actually need.
     *
     * Unlike Overpass, the website filter cannot be pushed into the query -
     * Places has no such parameter - so it is applied after mapping, and a
     * filtered search needs headroom for the records that will be dropped.
     */
    const wanted =
      limit === null
        ? GOOGLE_MAX_RESULTS
        : Math.min(GOOGLE_MAX_RESULTS, requireWebsite ? limit * 2 : limit);

    const places = await searchDentistPlaces(
      latitude,
      longitude,
      radiusMeters,
      wanted,
      this.requireApiKey(),
    );

    const dentists = normalizePlaces(places, origin, {
      radiusMeters,
      requireWebsite,
    });

    logger.info("google_search_completed", {
      radiusMeters,
      requireWebsite,
      wanted,
      places: places.length,
      normalized: dentists.length,
      // True when Google's own ceiling, not the data, bounded the answer.
      hitGoogleCeiling: places.length >= GOOGLE_MAX_RESULTS,
    });

    this.searchCache.set(cacheKey, dentists);

    return applyLimit(dentists, limit);
  }
}
