/**
 * Provider-level tests for result capping and caching.
 *
 * Overpass is stubbed so these assert our own logic - how many results come
 * back and how often the upstream is asked - without touching a public
 * endpoint or depending on what OSM happens to contain today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchDentistElements = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/osm/overpass", () => ({ fetchDentistElements }));

import type { OsmConfig } from "@/lib/config";
import { OsmDentistSearchProvider } from "@/lib/providers/osm";
import type { OverpassElement } from "@/lib/providers/osm/overpass";

const CONFIG: OsmConfig = {
  nominatimBaseUrl: "https://nominatim.example",
  overpassUrls: ["https://overpass.example/api/interpreter"],
  userAgent: "DentistFinder/1.0 (test)",
};

const CENTRE = { latitude: 33.67, longitude: -117.75 };

/** `count` distinct dentists, each a little further from the centre. */
function makeElements(count: number): OverpassElement[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "node" as const,
    id: 1000 + index,
    lat: CENTRE.latitude + index * 0.001,
    lon: CENTRE.longitude,
    tags: {
      amenity: "dentist",
      name: `Dental Practice ${index}`,
      website: `https://example.com/${index}`,
    },
  }));
}

function search(limit: number | null) {
  return new OsmDentistSearchProvider(CONFIG).searchDentists({
    ...CENTRE,
    radiusMeters: 15000,
    limit,
    requireWebsite: false,
  });
}

beforeEach(() => {
  fetchDentistElements.mockReset();
});

describe("result capping", () => {
  it("caps at the requested limit", async () => {
    fetchDentistElements.mockResolvedValue(makeElements(60));
    expect(await search(20)).toHaveLength(20);
    expect(await search(50)).toHaveLength(50);
  });

  it("returns every result when the limit is null", async () => {
    // The point of the "All (no limit)" option: more than the old ceiling.
    fetchDentistElements.mockResolvedValue(makeElements(137));
    const results = await search(null);
    expect(results).toHaveLength(137);
    expect(new Set(results.map((d) => d.id)).size).toBe(137);
  });

  it("returns what exists rather than padding to the limit", async () => {
    fetchDentistElements.mockResolvedValue(makeElements(7));
    expect(await search(50)).toHaveLength(7);
    expect(await search(null)).toHaveLength(7);
  });

  it("returns an empty list, not an error, when nothing is found", async () => {
    fetchDentistElements.mockResolvedValue([]);
    expect(await search(null)).toEqual([]);
  });

  it("keeps nearest-first order when uncapped", async () => {
    fetchDentistElements.mockResolvedValue(makeElements(60));
    const distances = (await search(null)).map((d) => d.distanceKm ?? 0);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });
});

describe("search caching", () => {
  it("asks Overpass once for a point and radius, whatever the limit", async () => {
    fetchDentistElements.mockResolvedValue(makeElements(60));
    const provider = new OsmDentistSearchProvider(CONFIG);
    const params = { ...CENTRE, radiusMeters: 15000, requireWebsite: false };

    expect(await provider.searchDentists({ ...params, limit: 20 })).toHaveLength(20);
    // Served from cache, and the wider request still sees the full set.
    expect(await provider.searchDentists({ ...params, limit: null })).toHaveLength(60);
    expect(await provider.searchDentists({ ...params, limit: 30 })).toHaveLength(30);

    expect(fetchDentistElements).toHaveBeenCalledTimes(1);
  });

  it("does not serve a filtered search from an unfiltered cache entry", async () => {
    fetchDentistElements.mockResolvedValue(makeElements(10));
    const provider = new OsmDentistSearchProvider(CONFIG);
    const params = { ...CENTRE, radiusMeters: 15000, limit: null };

    await provider.searchDentists({ ...params, requireWebsite: false });
    await provider.searchDentists({ ...params, requireWebsite: true });

    // Different upstream queries, so they must not share a cache entry.
    expect(fetchDentistElements).toHaveBeenCalledTimes(2);
  });

  it("passes the website filter down to the upstream query", async () => {
    fetchDentistElements.mockResolvedValue([]);
    await new OsmDentistSearchProvider(CONFIG).searchDentists({
      ...CENTRE,
      radiusMeters: 25000,
      limit: null,
      requireWebsite: true,
    });

    expect(fetchDentistElements).toHaveBeenCalledWith(
      CENTRE.latitude,
      CENTRE.longitude,
      25000,
      true,
      CONFIG,
    );
  });
});
