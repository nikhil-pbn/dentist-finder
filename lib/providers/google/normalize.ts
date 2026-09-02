/**
 * Maps Google Places results onto the normalised `Dentist` model.
 *
 * The same rules the OSM normaliser follows apply here: nothing is invented, a
 * field Google does not supply becomes `null`, and only records that are
 * unusable (no coordinates) are dropped.
 *
 * Google supplies things OSM cannot - `rating`, `reviews`, `businessStatus`
 * and a live "open now" - and lacks one OSM sometimes has: there is no email
 * field in the Places API, so `email` is always null under this provider.
 */
import { distanceInMeters, roundKm, type Coordinates } from "@/lib/distance";
import type { Dentist } from "@/lib/types";
import type { GooglePlace } from "@/lib/providers/google/places";

/** Only http(s) survives, matching how the OSM provider treats a website. */
function normalizeWebsite(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Drops Google's trailing country from a formatted address.
 *
 * Only the country is removed, and only from the end - the rest of the string
 * is Google's verbatim, never re-composed from address components, so nothing
 * can be silently dropped or reordered.
 */
function toShortAddress(address: string | null): string | null {
  if (!address) return null;
  const short = address.replace(/,\s*(USA|United States(?: of America)?)\s*$/i, "").trim();
  return short.length > 0 ? short : address;
}

/**
 * The place-id permalink form, which is stable across renames and relocations
 * in a way a coordinate or CID link is not.
 */
function toMapUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}

/** Converts one place, or `null` when it has no id or no usable coordinates. */
export function placeToDentist(
  place: GooglePlace,
  origin: Coordinates | null,
): Dentist | null {
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const sourceId = place.id?.trim();
  if (!sourceId) return null;

  const coordinates = { latitude, longitude };
  const address = firstNonEmpty(place.formattedAddress);

  /*
   * `currentOpeningHours` accounts for holiday and special hours; the regular
   * schedule is the fallback. Absent from the response means "Google did not
   * say", which stays null rather than becoming a confident "closed".
   */
  const openNow =
    place.currentOpeningHours?.openNow ?? place.regularOpeningHours?.openNow;

  return {
    id: `google:${sourceId}`,
    name: firstNonEmpty(place.displayName?.text),
    address,
    shortAddress: toShortAddress(address),
    // International first: "+1 949-555-1234" dials correctly from anywhere,
    // where the national form only works inside the country.
    phone: firstNonEmpty(place.internationalPhoneNumber, place.nationalPhoneNumber),
    website: normalizeWebsite(place.websiteUri),
    // The Places API exposes no email address. Never guessed at from a domain.
    email: null,
    latitude,
    longitude,
    openingHours:
      place.regularOpeningHours?.weekdayDescriptions?.join("; ").trim() || null,
    currentOpen: typeof openNow === "boolean" ? openNow : null,
    // Built from the place id rather than taken from `googleMapsUri`, so the
    // link is the documented permalink form and survives a rename.
    mapUrl: toMapUrl(sourceId),
    distanceKm: origin
      ? roundKm(distanceInMeters(origin, coordinates) / 1000)
      : null,
    source: "google",
    sourceId,
    rating: typeof place.rating === "number" ? place.rating : null,
    reviews:
      typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    businessStatus: firstNonEmpty(place.businessStatus),
    categories: place.types?.length ? place.types : null,
    // Filled by the PMS detector, never by a search provider.
    pms: null,
  };
}

/** Identity is the place id; Google does not return the same place twice. */
function dedupe(dentists: readonly Dentist[]): Dentist[] {
  const byId = new Map<string, Dentist>();
  for (const dentist of dentists) {
    if (!byId.has(dentist.id)) byId.set(dentist.id, dentist);
  }
  return [...byId.values()];
}

/**
 * Full pipeline: places in, ordered dentists out.
 *
 * The radius filter is applied here because Text Search takes a circle as a
 * *bias* rather than a restriction, so Google may return places beyond it. A
 * user asking for 5 km must not be shown something 30 km away.
 */
export function normalizePlaces(
  places: readonly GooglePlace[],
  origin: Coordinates,
  { radiusMeters, requireWebsite }: { radiusMeters: number; requireWebsite: boolean },
): Dentist[] {
  const dentists = places
    .map((place) => placeToDentist(place, origin))
    .filter((dentist): dentist is Dentist => dentist !== null)
    .filter(
      (dentist) => distanceInMeters(origin, dentist) <= radiusMeters,
    )
    .filter((dentist) => !requireWebsite || dentist.website !== null);

  // Nearest first, exactly as the OSM provider orders its results.
  return dedupe(dentists).sort((a, b) => {
    const aDistance = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const bDistance = b.distanceKm ?? Number.POSITIVE_INFINITY;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id);
  });
}
