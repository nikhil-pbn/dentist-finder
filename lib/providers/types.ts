/**
 * The provider contract.
 *
 * Everything above this line (API route, components, CSV export) depends only
 * on this interface and on the normalised model in `lib/types.ts`. Everything
 * below it - Nominatim, Overpass, and one day Google Places - lives inside a
 * provider folder and is invisible to the rest of the application.
 *
 * Adding a provider means implementing this interface and registering it in
 * `lib/providers/index.ts`. No other file should need to change.
 */
import type { ProviderId } from "@/lib/constants";
import type { Dentist, GeoLocation } from "@/lib/types";

export interface SearchDentistsParams {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /**
   * Upper bound on the number of results, or `null` for no cap. Providers
   * return fewer than requested when fewer exist, and never pad to reach it.
   */
  limit: number | null;
  /**
   * When true, only results with a usable website are returned.
   *
   * Providers should push this down to the upstream query where they can, so
   * that `limit` counts results the caller can actually use rather than being
   * spent on records that are about to be discarded. Either way the returned
   * list must satisfy it: every `Dentist` has a non-null `website`.
   */
  requireWebsite: boolean;
}

export interface DentistSearchProvider {
  /** Identifies the implementation; also stamped onto every `Dentist.source`. */
  readonly id: ProviderId;

  /**
   * Resolves a 5-digit US ZIP code to a point.
   * @throws ZipNotFoundError when the ZIP does not exist.
   * @throws GeocodingError / ProviderTimeoutError on upstream failure.
   */
  geocodeZip(zip: string): Promise<GeoLocation>;

  /**
   * Returns at most `limit` dentists, already normalised, de-duplicated and
   * sorted. Never fabricates or pads results.
   * @throws SearchError / ProviderTimeoutError on upstream failure.
   */
  searchDentists(params: SearchDentistsParams): Promise<Dentist[]>;
}
