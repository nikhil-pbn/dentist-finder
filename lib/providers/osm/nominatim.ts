/**
 * Nominatim client - ZIP code geocoding for the OSM provider.
 *
 * Usage policy compliance (https://operations.osmfoundation.org/policies/nominatim/):
 *   - an identifying, application specific `User-Agent` on every request;
 *   - at most one request per second, enforced by the queue below;
 *   - results are cached by the provider so a repeated ZIP is not re-asked;
 *   - no bulk, parallel or automated ZIP enumeration anywhere in this app.
 *
 * Nominatim's response shapes never leave this file.
 */
import {
  NOMINATIM_MIN_REQUEST_INTERVAL_MS,
  NOMINATIM_TIMEOUT_MS,
} from "@/lib/constants";
import { AppError, GeocodingError } from "@/lib/errors";
import type { GeoLocation } from "@/lib/types";
import { describeCause, parseJson, requestText } from "@/lib/providers/http";
import type { OsmConfig } from "@/lib/config";

/** Only the fields we actually read; Nominatim returns considerably more. */
interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  postcode?: string;
  "ISO3166-2-lvl4"?: string;
}

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
}

const LABEL = "Nominatim";

/*
 * Outbound requests are serialised through this promise chain so that two
 * concurrent user searches can never produce two simultaneous Nominatim hits.
 */
let queueTail: Promise<void> = Promise.resolve();
let nextSlotAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveRequestSlot(): Promise<void> {
  const slot = queueTail.then(async () => {
    const waitMs = nextSlotAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    nextSlotAt = Date.now() + NOMINATIM_MIN_REQUEST_INTERVAL_MS;
  });
  // Keep the chain alive even if a caller's request later rejects.
  queueTail = slot.then(
    () => undefined,
    () => undefined,
  );
  return slot;
}

/** "US-CA" -> "CA"; anything else falls back to the full state name. */
function stateLabel(address: NominatimAddress): string | undefined {
  const iso = address["ISO3166-2-lvl4"];
  if (iso?.startsWith("US-") && iso.length === 5) return iso.slice(3);
  return address.state;
}

/**
 * Builds a compact label such as "Irvine, CA 92618" from the structured
 * address, falling back to Nominatim's own long `display_name`.
 */
function toDisplayName(place: NominatimPlace, zip: string): string {
  const address = place.address;
  if (!address) return place.display_name?.trim() || zip;

  const locality =
    address.city ??
    address.town ??
    address.village ??
    address.hamlet ??
    address.municipality ??
    address.county;
  const state = stateLabel(address);
  const postcode = address.postcode ?? zip;

  const head = [locality, state].filter(Boolean).join(", ");
  const label = [head, postcode].filter(Boolean).join(" ").trim();

  return label.length > 0 ? label : place.display_name?.trim() || zip;
}

/**
 * Structured ZIP lookup. Returns `null` when the ZIP simply does not exist,
 * which the caller distinguishes from an upstream failure (and caches).
 *
 * @throws GeocodingError on transport, status or parse failure.
 * @throws ProviderTimeoutError when Nominatim is too slow.
 */
export async function geocodeUsZip(
  zip: string,
  config: OsmConfig,
): Promise<GeoLocation | null> {
  const url = new URL("/search", config.nominatimBaseUrl);
  url.searchParams.set("postalcode", zip);
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");

  await reserveRequestSlot();

  try {
    const body = await requestText(url.toString(), {
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        "Accept-Language": "en",
      },
      timeoutMs: NOMINATIM_TIMEOUT_MS,
      label: LABEL,
    });

    const places = parseJson<unknown>(body, LABEL);
    if (!Array.isArray(places)) {
      throw new GeocodingError(`${LABEL} returned a non-array payload`);
    }

    const place = places[0] as NominatimPlace | undefined;
    if (!place) return null;

    const latitude = Number(place.lat);
    const longitude = Number(place.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new GeocodingError(
        `${LABEL} returned a place without usable coordinates`,
      );
    }

    return { latitude, longitude, displayName: toDisplayName(place, zip) };
  } catch (error) {
    // Domain errors (timeouts, the throws above) already carry a safe public
    // message. Everything else - DNS failure, socket reset, malformed JSON -
    // becomes a GeocodingError so the technical detail stays server-side.
    if (error instanceof AppError) throw error;
    throw new GeocodingError(`${LABEL} request failed: ${describeCause(error)}`, {
      cause: error,
    });
  }
}
