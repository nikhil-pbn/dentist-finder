/**
 * Shared test fixtures.
 *
 * `Dentist` has no optional fields on purpose - a provider that cannot supply
 * something has to say `null` rather than omit it - so a test interested in two
 * fields would otherwise still have to spell out all twenty. This builds a
 * complete, deliberately empty record and lets each test override only what it
 * is actually about.
 *
 * It also means adding a field to the model breaks compilation here, in one
 * place, instead of in every fixture.
 */
import type { Dentist } from "@/lib/types";

export function makeDentist(overrides: Partial<Dentist> = {}): Dentist {
  return {
    id: "osm:node/1",
    name: null,
    address: null,
    shortAddress: null,
    phone: null,
    website: null,
    email: null,
    latitude: 0,
    longitude: 0,
    openingHours: null,
    currentOpen: null,
    mapUrl: null,
    distanceKm: null,
    source: "osm",
    sourceId: "node/1",
    rating: null,
    reviews: null,
    businessStatus: null,
    categories: null,
    pms: null,
    ...overrides,
  };
}
