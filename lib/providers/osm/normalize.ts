/**
 * Maps raw Overpass elements onto the normalised `Dentist` model, then
 * de-duplicates and orders them.
 *
 * Rules that this module exists to enforce:
 *   - nothing is ever invented: a tag OSM does not have becomes `null`;
 *   - a record is never dropped for being incomplete (an unnamed dentist is
 *     still a real dentist), only for being unusable (no coordinates at all);
 *   - two OSM objects are merged only on strong evidence.
 */
import { DEDUPE_MAX_DISTANCE_METERS } from "@/lib/constants";
import { distanceInMeters, roundKm, type Coordinates } from "@/lib/distance";
import type { Dentist } from "@/lib/types";
import type { OverpassElement } from "@/lib/providers/osm/overpass";

type Tags = Record<string, string>;

function tag(tags: Tags, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Ways and relations have no coordinates of their own; `out center` gives them
 * a representative point. Elements with neither are unusable and are dropped.
 */
function coordinatesOf(element: OverpassElement): Coordinates | null {
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/**
 * Builds a readable address from `addr:*` tags, falling back to `addr:full`.
 * Missing components are skipped rather than rendered as empty text.
 */
export function buildAddress(tags: Tags): string | null {
  const houseNumber = tag(tags, "addr:housenumber");
  const street = tag(tags, "addr:street", "addr:place");
  const line = [houseNumber, street].filter(Boolean).join(" ").trim();

  const city = tag(tags, "addr:city", "addr:town", "addr:suburb");
  const state = tag(tags, "addr:state");
  const postcode = tag(tags, "addr:postcode");

  const region = [state, postcode].filter(Boolean).join(" ").trim();
  const parts = [line, city, region].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  if (parts.length > 0) return parts.join(", ");
  return tag(tags, "addr:full");
}

/**
 * Accepts only http(s) URLs. A bare `example.com` is upgraded to `https://`;
 * anything else (phone numbers, "none", free text) is discarded rather than
 * rendered as a broken link.
 */
export function normalizeWebsite(value: string | null): string | null {
  if (!value) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  return url.toString();
}

/**
 * How useful a record is. Used only to break distance ties and to choose a
 * survivor when two OSM objects describe the same business.
 */
export function completenessScore(dentist: Dentist): number {
  return (
    (dentist.name ? 8 : 0) +
    (dentist.website ? 4 : 0) +
    (dentist.phone ? 2 : 0) +
    (dentist.address ? 1 : 0)
  );
}

/**
 * Converts one Overpass element into a `Dentist`, or `null` when it carries no
 * usable coordinates.
 */
export function elementToDentist(
  element: OverpassElement,
  origin: Coordinates | null,
): Dentist | null {
  const coordinates = coordinatesOf(element);
  if (!coordinates) return null;

  const tags: Tags = element.tags ?? {};
  const sourceId = `${element.type}/${element.id}`;
  const address = buildAddress(tags);

  return {
    id: `osm:${sourceId}`,
    // `operator` and `brand` are OSM's own fields for a business name when
    // `name` is absent - a documented fallback, not an invention.
    name: tag(tags, "name", "official_name", "operator", "brand"),
    address,
    // OSM addresses are assembled from `addr:*` tags and carry no country, so
    // the short form is the address itself rather than a second rendering.
    shortAddress: address,
    phone: tag(tags, "phone", "contact:phone", "contact:mobile", "phone:mobile"),
    website: normalizeWebsite(tag(tags, "website", "contact:website", "url")),
    email: tag(tags, "email", "contact:email"),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    openingHours: tag(tags, "opening_hours"),
    /*
     * OSM's `opening_hours` is a grammar ("Mo-Fr 09:00-17:00; PH off"), not a
     * flag. Evaluating it correctly needs a full parser and the practice's own
     * timezone; evaluating it approximately would mean telling someone a closed
     * surgery is open. So this stays unknown under OSM.
     */
    currentOpen: null,
    // The provider owns the map URL, so the UI never branches on `source`.
    mapUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    distanceKm: origin
      ? roundKm(distanceInMeters(origin, coordinates) / 1000)
      : null,
    source: "osm",
    sourceId,
    // OSM supplies none of these; a richer provider may.
    rating: null,
    reviews: null,
    businessStatus: null,
    categories: null,
  };
}

/** Lower-cased, punctuation-free name, used only for duplicate detection. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Picks the better of two records describing the same business: richer data
 * first, then the closer one, then the lower id so the outcome is stable.
 */
function preferred(a: Dentist, b: Dentist): Dentist {
  const scoreDelta = completenessScore(b) - completenessScore(a);
  if (scoreDelta !== 0) return scoreDelta > 0 ? b : a;

  const aDistance = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const bDistance = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) return aDistance < bDistance ? a : b;

  return a.id <= b.id ? a : b;
}

/**
 * Removes duplicates conservatively.
 *
 * Identity is `source + sourceId`. Beyond that, two records are treated as one
 * business only when they share a name *and* sit within
 * `DEDUPE_MAX_DISTANCE_METERS` of each other - the common case of a POI node
 * mapped inside its own building way. Unnamed records are never merged: two
 * different practices in one medical centre must not collapse into one.
 */
export function dedupeDentists(dentists: readonly Dentist[]): Dentist[] {
  const byId = new Map<string, Dentist>();
  for (const dentist of dentists) {
    const existing = byId.get(dentist.id);
    byId.set(dentist.id, existing ? preferred(existing, dentist) : dentist);
  }

  const survivors: Dentist[] = [];
  for (const dentist of byId.values()) {
    if (!dentist.name) {
      survivors.push(dentist);
      continue;
    }

    const key = nameKey(dentist.name);
    const duplicateIndex = survivors.findIndex(
      (candidate) =>
        candidate.name !== null &&
        nameKey(candidate.name) === key &&
        distanceInMeters(candidate, dentist) <= DEDUPE_MAX_DISTANCE_METERS,
    );

    if (duplicateIndex === -1) {
      survivors.push(dentist);
    } else {
      survivors[duplicateIndex] = preferred(survivors[duplicateIndex], dentist);
    }
  }

  return survivors;
}

/**
 * Deterministic default order: nearest first.
 *
 * Distance is the primary key because the search itself is radius-based - a
 * user searching 5 km expects the closest practices at the top. Completeness
 * only breaks ties, so a well-tagged record wins over a bare one at the same
 * spot, but a nearby practice is never pushed down for lacking a website.
 * Name and id make the ordering total, so equal inputs always sort identically.
 */
export function sortDentists(dentists: readonly Dentist[]): Dentist[] {
  return [...dentists].sort((a, b) => {
    const aDistance = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const bDistance = b.distanceKm ?? Number.POSITIVE_INFINITY;
    if (aDistance !== bDistance) return aDistance - bDistance;

    const scoreDelta = completenessScore(b) - completenessScore(a);
    if (scoreDelta !== 0) return scoreDelta;

    const nameDelta = (a.name ?? "").localeCompare(b.name ?? "");
    if (nameDelta !== 0) return nameDelta;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Full pipeline: elements in, ordered and de-duplicated dentists out.
 *
 * `requireWebsite` is already applied upstream in the Overpass query, so this
 * pass normally removes nothing. It stays as the guarantee that the interface
 * promises, because a tag can exist and still not be a usable link -
 * `website=none` passes the server-side key check but `normalizeWebsite`
 * rejects it, and the caller must never receive a result it filtered out.
 */
export function normalizeElements(
  elements: readonly OverpassElement[],
  origin: Coordinates,
  { requireWebsite }: { requireWebsite: boolean },
): Dentist[] {
  const dentists = elements
    .map((element) => elementToDentist(element, origin))
    .filter((dentist): dentist is Dentist => dentist !== null)
    .filter((dentist) => !requireWebsite || dentist.website !== null);

  return sortDentists(dedupeDentists(dentists));
}
