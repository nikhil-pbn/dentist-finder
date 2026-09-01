import { describe, expect, it } from "vitest";
import { makeDentist } from "./factories";
import { WEBSITE_TAG_KEYS } from "@/lib/constants";
import type { Coordinates } from "@/lib/distance";
import type { Dentist } from "@/lib/types";
import {
  buildAddress,
  dedupeDentists,
  elementToDentist,
  normalizeElements,
  normalizeWebsite,
  sortDentists,
} from "@/lib/providers/osm/normalize";
import { buildOverpassQuery } from "@/lib/providers/osm/overpass";
import type { OverpassElement } from "@/lib/providers/osm/overpass";

/** Irvine, CA - the ZIP used throughout the examples. */
const ORIGIN: Coordinates = { latitude: 33.67, longitude: -117.75 };

const COMPLETE_NODE: OverpassElement = {
  type: "node",
  id: 1234,
  lat: 33.6705,
  lon: -117.7505,
  tags: {
    amenity: "dentist",
    name: "Irvine Family Dental",
    "addr:housenumber": "123",
    "addr:street": "Main St",
    "addr:city": "Irvine",
    "addr:state": "CA",
    "addr:postcode": "92618",
    phone: "+1 949-555-0100",
    website: "https://example.com/irvine",
    email: "hello@example.com",
    opening_hours: "Mo-Fr 09:00-17:00",
  },
};

describe("elementToDentist - complete record", () => {
  const dentist = elementToDentist(COMPLETE_NODE, ORIGIN);

  it("maps every supplied field", () => {
    expect(dentist).toMatchObject({
      id: "osm:node/1234",
      name: "Irvine Family Dental",
      address: "123 Main St, Irvine, CA 92618",
      phone: "+1 949-555-0100",
      website: "https://example.com/irvine",
      email: "hello@example.com",
      openingHours: "Mo-Fr 09:00-17:00",
      latitude: 33.6705,
      longitude: -117.7505,
      source: "osm",
      sourceId: "node/1234",
    });
  });

  it("provides a map URL so the UI never builds one itself", () => {
    expect(dentist?.mapUrl).toBe("https://www.openstreetmap.org/node/1234");
  });

  it("computes the distance from the search centre", () => {
    expect(dentist?.distanceKm).toBeCloseTo(0.08, 1);
  });

  it("leaves provider-specific enrichment null rather than inventing it", () => {
    expect(dentist?.rating).toBeNull();
    expect(dentist?.reviews).toBeNull();
    expect(dentist?.businessStatus).toBeNull();
    expect(dentist?.categories).toBeNull();
  });

  it("mirrors the address into shortAddress, which OSM needs no trimming for", () => {
    // Built from addr:* tags, so it never carries a country to strip.
    expect(dentist?.shortAddress).toBe(dentist?.address);
    expect(dentist?.shortAddress).not.toMatch(/USA|United States/i);
  });

  it("reports the open state as unknown rather than parsing opening_hours", () => {
    // The tag is present on this fixture; turning "Mo-Fr 09:00-17:00" into a
    // boolean would mean guessing at a grammar and a timezone.
    expect(dentist?.openingHours).toBe("Mo-Fr 09:00-17:00");
    expect(dentist?.currentOpen).toBeNull();
  });
});

describe("elementToDentist - missing fields", () => {
  function withoutTags(...removed: string[]): Dentist {
    const tags = { ...COMPLETE_NODE.tags };
    for (const key of removed) delete tags[key];
    const dentist = elementToDentist({ ...COMPLETE_NODE, tags }, ORIGIN);
    expect(dentist).not.toBeNull();
    return dentist as Dentist;
  }

  it("returns null for a missing website and never invents one", () => {
    expect(withoutTags("website").website).toBeNull();
  });

  it("returns null for a missing phone", () => {
    expect(withoutTags("phone").phone).toBeNull();
  });

  it("returns null for a missing address", () => {
    const dentist = withoutTags(
      "addr:housenumber",
      "addr:street",
      "addr:city",
      "addr:state",
      "addr:postcode",
    );
    expect(dentist.address).toBeNull();
  });

  it("keeps an unnamed practice rather than dropping it", () => {
    const dentist = withoutTags("name");
    expect(dentist.name).toBeNull();
    expect(dentist.id).toBe("osm:node/1234");
  });

  it("handles an element with no tags at all", () => {
    const dentist = elementToDentist(
      { type: "node", id: 7, lat: 33.6, lon: -117.7 },
      ORIGIN,
    );
    expect(dentist).toMatchObject({
      name: null,
      address: null,
      phone: null,
      website: null,
      email: null,
      openingHours: null,
    });
  });

  it("drops an element with no usable coordinates", () => {
    expect(
      elementToDentist({ type: "way", id: 9, tags: { name: "No geometry" } }, ORIGIN),
    ).toBeNull();
  });

  it("reads alternative contact tags", () => {
    const dentist = elementToDentist(
      {
        type: "node",
        id: 11,
        lat: 33.6,
        lon: -117.7,
        tags: {
          operator: "Chain Dental",
          "contact:phone": "+1 949-555-0199",
          "contact:website": "example.org",
          "contact:email": "info@example.org",
          "addr:full": "500 Some Road, Irvine CA",
        },
      },
      ORIGIN,
    );
    expect(dentist).toMatchObject({
      name: "Chain Dental",
      phone: "+1 949-555-0199",
      website: "https://example.org/",
      email: "info@example.org",
      address: "500 Some Road, Irvine CA",
    });
  });
});

describe("elementToDentist - ways and relations", () => {
  it("uses `center` for a way", () => {
    const dentist = elementToDentist(
      {
        type: "way",
        id: 555,
        center: { lat: 33.68, lon: -117.76 },
        tags: { name: "Dental Building" },
      },
      ORIGIN,
    );
    expect(dentist).toMatchObject({
      id: "osm:way/555",
      sourceId: "way/555",
      latitude: 33.68,
      longitude: -117.76,
      mapUrl: "https://www.openstreetmap.org/way/555",
    });
    expect(dentist?.distanceKm).toBeGreaterThan(0);
  });

  it("uses `center` for a relation", () => {
    const dentist = elementToDentist(
      {
        type: "relation",
        id: 777,
        center: { lat: 33.7, lon: -117.8 },
        tags: { name: "Medical Campus Dentistry" },
      },
      ORIGIN,
    );
    expect(dentist).toMatchObject({
      id: "osm:relation/777",
      sourceId: "relation/777",
      latitude: 33.7,
      longitude: -117.8,
      mapUrl: "https://www.openstreetmap.org/relation/777",
    });
  });
});

describe("buildAddress", () => {
  it("joins the parts it has", () => {
    expect(
      buildAddress({
        "addr:housenumber": "1",
        "addr:street": "A St",
        "addr:city": "Irvine",
        "addr:state": "CA",
        "addr:postcode": "92618",
      }),
    ).toBe("1 A St, Irvine, CA 92618");
  });

  it("skips missing components instead of rendering blanks", () => {
    expect(buildAddress({ "addr:city": "Irvine", "addr:state": "CA" })).toBe(
      "Irvine, CA",
    );
    expect(buildAddress({ "addr:street": "A St" })).toBe("A St");
  });

  it("never produces the strings undefined or null", () => {
    const address = buildAddress({ "addr:housenumber": "12" }) ?? "";
    expect(address).not.toMatch(/undefined|null/);
    expect(address).toBe("12");
  });

  it("falls back to addr:full", () => {
    expect(buildAddress({ "addr:full": "12 Elm Street, Springfield" })).toBe(
      "12 Elm Street, Springfield",
    );
  });

  it("returns null when there is nothing to show", () => {
    expect(buildAddress({})).toBeNull();
    expect(buildAddress({ "addr:street": "   " })).toBeNull();
  });
});

describe("normalizeWebsite", () => {
  it("keeps valid http(s) URLs", () => {
    expect(normalizeWebsite("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeWebsite("http://example.com/")).toBe("http://example.com/");
  });

  it("upgrades a bare domain", () => {
    expect(normalizeWebsite("example.com")).toBe("https://example.com/");
  });

  it("discards values that are not usable links", () => {
    expect(normalizeWebsite(null)).toBeNull();
    expect(normalizeWebsite("none")).toBeNull();
    expect(normalizeWebsite("tel:+19495550100")).toBeNull();
    expect(normalizeWebsite("javascript:alert(1)")).toBeNull();
  });
});

describe("deduplication", () => {
  function dentistAt(
    overrides: Partial<Dentist> & Pick<Dentist, "id" | "latitude" | "longitude">,
  ): Dentist {
    return makeDentist({
      distanceKm: 1,
      sourceId: overrides.id.replace("osm:", ""),
      ...overrides,
    });
  }

  it("collapses repeated identities", () => {
    const a = dentistAt({ id: "osm:node/1", latitude: 33.6, longitude: -117.7 });
    expect(dedupeDentists([a, { ...a }])).toHaveLength(1);
  });

  it("merges a node and its building way when name and location agree", () => {
    const node = dentistAt({
      id: "osm:node/1",
      latitude: 33.6,
      longitude: -117.7,
      name: "Smile Dental",
      phone: "+1 949-555-0100",
    });
    const way = dentistAt({
      id: "osm:way/2",
      latitude: 33.60005,
      longitude: -117.70005,
      name: "smile dental",
    });

    const result = dedupeDentists([node, way]);
    expect(result).toHaveLength(1);
    // The richer record survives.
    expect(result[0].id).toBe("osm:node/1");
  });

  it("keeps same-named practices that are far apart", () => {
    const near = dentistAt({
      id: "osm:node/1",
      latitude: 33.6,
      longitude: -117.7,
      name: "Bright Dental",
    });
    const far = dentistAt({
      id: "osm:node/2",
      latitude: 33.8,
      longitude: -117.9,
      name: "Bright Dental",
    });
    expect(dedupeDentists([near, far])).toHaveLength(2);
  });

  it("never merges unnamed records at the same spot", () => {
    const first = dentistAt({ id: "osm:node/1", latitude: 33.6, longitude: -117.7 });
    const second = dentistAt({ id: "osm:node/2", latitude: 33.6, longitude: -117.7 });
    expect(dedupeDentists([first, second])).toHaveLength(2);
  });
});

describe("sorting", () => {
  const base = makeDentist();

  it("orders by distance, nearest first", () => {
    const sorted = sortDentists([
      { ...base, id: "osm:node/3", sourceId: "node/3", name: "C", distanceKm: 9 },
      { ...base, id: "osm:node/1", sourceId: "node/1", name: "A", distanceKm: 1 },
      { ...base, id: "osm:node/2", sourceId: "node/2", name: "B", distanceKm: 5 },
    ]);
    expect(sorted.map((d) => d.name)).toEqual(["A", "B", "C"]);
  });

  it("breaks ties with the more complete record, without reordering by distance", () => {
    const sparse = {
      ...base,
      id: "osm:node/1",
      sourceId: "node/1",
      name: null,
      distanceKm: 2,
    };
    const rich = {
      ...base,
      id: "osm:node/2",
      sourceId: "node/2",
      name: "Full Record",
      website: "https://example.com",
      phone: "+1 949-555-0100",
      address: "1 A St",
      distanceKm: 2,
    };
    expect(sortDentists([sparse, rich]).map((d) => d.id)).toEqual([
      "osm:node/2",
      "osm:node/1",
    ]);
  });

  it("does not push a nearby practice below a distant one for lacking data", () => {
    const nearBare = {
      ...base,
      id: "osm:node/1",
      sourceId: "node/1",
      name: null,
      distanceKm: 1,
    };
    const farRich = {
      ...base,
      id: "osm:node/2",
      sourceId: "node/2",
      name: "Far but complete",
      website: "https://example.com",
      distanceKm: 40,
    };
    expect(sortDentists([farRich, nearBare])[0].id).toBe("osm:node/1");
  });

  it("is deterministic for identical inputs", () => {
    const items = [
      { ...base, id: "osm:node/2", sourceId: "node/2", name: "Same", distanceKm: 3 },
      { ...base, id: "osm:node/1", sourceId: "node/1", name: "Same", distanceKm: 3 },
    ];
    expect(sortDentists(items).map((d) => d.id)).toEqual(
      sortDentists([...items].reverse()).map((d) => d.id),
    );
  });
});

describe("normalizeElements", () => {
  it("maps, drops unusable elements and orders the rest", () => {
    const result = normalizeElements(
      [
        { type: "way", id: 3, tags: { name: "No coordinates" } },
        {
          type: "node",
          id: 2,
          lat: 33.9,
          lon: -117.9,
          tags: { name: "Far Dental" },
        },
        COMPLETE_NODE,
      ],
      ORIGIN,
      { requireWebsite: false },
    );
    expect(result.map((d) => d.name)).toEqual(["Irvine Family Dental", "Far Dental"]);
  });

  it("returns an empty list for no elements, never a fabricated one", () => {
    expect(normalizeElements([], ORIGIN, { requireWebsite: false })).toEqual([]);
  });

  it("keeps only results with a website when the filter is on", () => {
    const elements: OverpassElement[] = [
      COMPLETE_NODE,
      {
        type: "node",
        id: 42,
        lat: 33.671,
        lon: -117.751,
        tags: { name: "No Website Dental" },
      },
    ];

    expect(
      normalizeElements(elements, ORIGIN, { requireWebsite: false }).map(
        (d) => d.name,
      ),
    ).toEqual(["Irvine Family Dental", "No Website Dental"]);

    const filtered = normalizeElements(elements, ORIGIN, {
      requireWebsite: true,
    });
    expect(filtered.map((d) => d.name)).toEqual(["Irvine Family Dental"]);
    expect(filtered.every((d) => d.website !== null)).toBe(true);
  });

  it("drops a website tag that is not a usable link, even though Overpass matched it", () => {
    // `website=none` satisfies the server-side key check but is not a link, so
    // the guarantee that every returned record has a website must hold here.
    const junk: OverpassElement = {
      type: "node",
      id: 43,
      lat: 33.671,
      lon: -117.751,
      tags: { name: "Junk Website Dental", website: "none" },
    };
    expect(normalizeElements([junk], ORIGIN, { requireWebsite: true })).toEqual(
      [],
    );
    expect(
      normalizeElements([junk], ORIGIN, { requireWebsite: false }),
    ).toHaveLength(1);
  });
});

describe("buildOverpassQuery", () => {
  const query = buildOverpassQuery(33.67, -117.75, 15000, false);

  it("queries dentists across nodes, ways and relations", () => {
    expect(query).toContain('node["amenity"="dentist"](around:15000,33.67,-117.75)');
    expect(query).toContain('way["amenity"="dentist"](around:15000,33.67,-117.75)');
    expect(query).toContain(
      'relation["amenity"="dentist"](around:15000,33.67,-117.75)',
    );
  });

  it("asks for centres so ways and relations carry coordinates", () => {
    expect(query.trimEnd().endsWith("out center;")).toBe(true);
  });

  it("carries a server-side timeout", () => {
    expect(query).toMatch(/^\[out:json\]\[timeout:\d+\];/);
  });

  it("adds no tag filter when the website filter is off", () => {
    expect(query).not.toContain("~");
  });

  it("filters on website tags upstream when the filter is on", () => {
    const filtered = buildOverpassQuery(33.67, -117.75, 15000, true);
    const expected = '[~"^(website|contact:website|url)$"~"."]';

    // Applied to every element type, so nothing slips through by geometry.
    for (const kind of ["node", "way", "relation"]) {
      expect(filtered).toContain(`${kind}["amenity"="dentist"]${expected}(around:`);
    }
  });

  it("keeps the website keys in step with the normaliser", () => {
    const filtered = buildOverpassQuery(33.67, -117.75, 15000, true);
    for (const key of WEBSITE_TAG_KEYS) expect(filtered).toContain(key);
  });
});
