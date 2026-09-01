/**
 * Google provider tests.
 *
 * `fetch` is stubbed throughout: the suite must never call Google, both because
 * tests should not depend on the network and because every real Places request
 * is billed to whoever runs them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_MAX_RESULTS } from "@/lib/constants";
import { ConfigurationError, ZipNotFoundError } from "@/lib/errors";
import { GoogleDentistSearchProvider } from "@/lib/providers/google";
import { placeToDentist, normalizePlaces } from "@/lib/providers/google/normalize";
import type { GooglePlace } from "@/lib/providers/google/places";

const fetchMock = vi.fn();
const API_KEY = "test-key-not-real";
const CENTRE = { latitude: 33.6793, longitude: -117.7366 };

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function provider() {
  return new GoogleDentistSearchProvider({ apiKey: API_KEY });
}

/** A place roughly 300 m from CENTRE, as the Places API returns one. */
function place(overrides: Partial<GooglePlace> = {}): GooglePlace {
  return {
    id: "ChIJtest1",
    displayName: { text: "Irvine Dental Group" },
    formattedAddress: "123 Main St, Irvine, CA 92618, USA",
    location: { latitude: 33.6820, longitude: -117.7366 },
    nationalPhoneNumber: "(949) 555-1234",
    internationalPhoneNumber: "+1 949-555-1234",
    websiteUri: "https://www.irvinedentalgroup.com",
    googleMapsUri: "https://maps.google.com/?cid=1",
    rating: 4.8,
    userRatingCount: 247,
    businessStatus: "OPERATIONAL",
    types: ["dentist", "health"],
    currentOpeningHours: { openNow: true },
    ...overrides,
  };
}

describe("geocoding", () => {
  it("resolves a ZIP and trims the trailing country", async () => {
    fetchMock.mockResolvedValue(
      json({
        status: "OK",
        results: [
          {
            formatted_address: "Irvine, CA 92618, USA",
            geometry: { location: { lat: 33.6793, lng: -117.7366 } },
          },
        ],
      }),
    );

    await expect(provider().geocodeZip("92618")).resolves.toEqual({
      latitude: 33.6793,
      longitude: -117.7366,
      displayName: "Irvine, CA 92618",
    });
  });

  it("uses an exact postal-code component filter, not a free-text guess", async () => {
    fetchMock.mockResolvedValue(
      json({
        status: "OK",
        results: [{ geometry: { location: { lat: 1, lng: 2 } } }],
      }),
    );
    await provider().geocodeZip("92618");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("components=postal_code%3A92618%7Ccountry%3AUS");
  });

  it("reports an unknown ZIP as not found", async () => {
    fetchMock.mockResolvedValue(json({ status: "ZERO_RESULTS", results: [] }));
    await expect(provider().geocodeZip("00000")).rejects.toThrow(ZipNotFoundError);
  });

  it("turns REQUEST_DENIED into an actionable configuration error", async () => {
    fetchMock.mockResolvedValue(
      json({ status: "REQUEST_DENIED", error_message: "API key invalid" }),
    );
    await expect(provider().geocodeZip("92618")).rejects.toThrow(
      ConfigurationError,
    );
  });

  it("caches a resolved ZIP instead of paying for it twice", async () => {
    fetchMock.mockResolvedValue(
      json({
        status: "OK",
        results: [{ geometry: { location: { lat: 1, lng: 2 } } }],
      }),
    );
    const google = provider();
    await google.geocodeZip("92618");
    await google.geocodeZip("92618");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("place normalisation", () => {
  const dentist = placeToDentist(place(), CENTRE);

  it("produces the documented result shape", () => {
    // The whole contract in one assertion: rename a field and this fails.
    expect(dentist).toMatchObject({
      name: "Irvine Dental Group",
      shortAddress: "123 Main St, Irvine, CA 92618",
      phone: "+1 949-555-1234",
      // Canonicalised by `new URL(...)`, exactly as the OSM provider does it,
      // which is where the trailing slash on a bare origin comes from.
      website: "https://www.irvinedentalgroup.com/",
      rating: 4.8,
      reviews: 247,
      mapUrl: "https://www.google.com/maps/place/?q=place_id:ChIJtest1",
      currentOpen: true,
      businessStatus: "OPERATIONAL",
    });
  });

  it("keeps the source address verbatim alongside the short one", () => {
    // The country is trimmed for display, not discarded from the record.
    expect(dentist?.address).toBe("123 Main St, Irvine, CA 92618, USA");
    expect(dentist?.shortAddress).toBe("123 Main St, Irvine, CA 92618");
  });

  it("prefers the international phone number, which dials from anywhere", () => {
    expect(dentist?.phone).toBe("+1 949-555-1234");
    expect(
      placeToDentist({ ...place(), internationalPhoneNumber: undefined }, CENTRE)
        ?.phone,
    ).toBe("(949) 555-1234");
  });

  it("links by place id rather than CID, so a rename cannot break it", () => {
    expect(dentist?.mapUrl).toBe(
      "https://www.google.com/maps/place/?q=place_id:ChIJtest1",
    );
  });

  it("prefers current opening hours over the regular schedule", () => {
    // Holiday hours live on currentOpeningHours; the regular schedule would
    // claim the practice is open on a day it is actually closed.
    const conflicting = placeToDentist(
      {
        ...place(),
        currentOpeningHours: { openNow: false },
        regularOpeningHours: { openNow: true },
      },
      CENTRE,
    );
    expect(conflicting?.currentOpen).toBe(false);
  });

  it("reports an unstated open state as unknown, not as closed", () => {
    const silent = placeToDentist(
      { ...place(), currentOpeningHours: undefined },
      CENTRE,
    );
    expect(silent?.currentOpen).toBeNull();
  });

  it("leaves email null, because Places has no email field", () => {
    // Never derived from the website domain or guessed at.
    expect(dentist?.email).toBeNull();
  });

  it("computes distance from the search centre", () => {
    expect(dentist?.distanceKm).toBeGreaterThan(0);
    expect(dentist?.distanceKm).toBeLessThan(1);
  });

  it("returns null for a place with no coordinates or no id", () => {
    expect(placeToDentist({ ...place(), location: undefined }, CENTRE)).toBeNull();
    expect(placeToDentist({ ...place(), id: undefined }, CENTRE)).toBeNull();
  });

  it("drops a website that is not an http(s) URL", () => {
    expect(placeToDentist({ ...place(), websiteUri: "ftp://x.example" }, CENTRE)?.website).toBeNull();
  });

  it("renders missing optional fields as null rather than inventing them", () => {
    const sparse = placeToDentist(
      {
        id: "ChIJbare",
        location: { latitude: 33.68, longitude: -117.74 },
      },
      CENTRE,
    );
    expect(sparse).toMatchObject({
      name: null,
      address: null,
      shortAddress: null,
      phone: null,
      website: null,
      email: null,
      rating: null,
      reviews: null,
      currentOpen: null,
      businessStatus: null,
    });
  });
});

describe("radius handling", () => {
  it("drops places outside the radius, since Google only biases to the circle", () => {
    const far = place({
      id: "ChIJfar",
      // ~30 km north of the centre.
      location: { latitude: 33.95, longitude: -117.7366 },
    });

    const results = normalizePlaces([place(), far], CENTRE, {
      radiusMeters: 5000,
      requireWebsite: false,
    });
    expect(results.map((d) => d.id)).toEqual(["google:ChIJtest1"]);
  });

  it("orders results nearest first", () => {
    const near = place({ id: "a", location: { latitude: 33.6800, longitude: -117.7366 } });
    const mid = place({ id: "b", location: { latitude: 33.7000, longitude: -117.7366 } });
    const results = normalizePlaces([mid, near], CENTRE, {
      radiusMeters: 50000,
      requireWebsite: false,
    });
    expect(results.map((d) => d.id)).toEqual(["google:a", "google:b"]);
  });

  it("applies the website filter, which Places cannot do server-side", () => {
    const noSite = place({ id: "nosite", websiteUri: undefined });
    expect(
      normalizePlaces([place(), noSite], CENTRE, {
        radiusMeters: 50000,
        requireWebsite: true,
      }).map((d) => d.id),
    ).toEqual(["google:ChIJtest1"]);
  });
});

describe("configuration failures", () => {
  it("passes Google's own explanation through, not just a status", async () => {
    // The billing case is invisible without it: the key is valid and the API is
    // enabled, so only Google's message says what is actually wrong.
    fetchMock.mockResolvedValue(
      json({
        status: "REQUEST_DENIED",
        error_message: "You must enable Billing on the Google Cloud Project",
      }),
    );

    await expect(provider().geocodeZip("92618")).rejects.toThrow(
      /enable Billing/,
    );
  });

  it("keeps the actionable checklist in the message", async () => {
    fetchMock.mockResolvedValue(json({ status: "REQUEST_DENIED" }));
    await expect(provider().geocodeZip("92618")).rejects.toThrow(
      /Geocoding API is enabled/,
    );
  });
});

describe("searching", () => {
  function pageOf(count: number, offset: number, nextPageToken?: string) {
    return json({
      places: Array.from({ length: count }, (_, i) =>
        place({
          id: `ChIJ${offset + i}`,
          location: { latitude: 33.6800 + (offset + i) * 0.0005, longitude: -117.7366 },
        }),
      ),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  it("follows pagination to gather more than one page", async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(20, 0, "token-2"))
      .mockResolvedValueOnce(pageOf(20, 20, "token-3"))
      .mockResolvedValueOnce(pageOf(20, 40));

    const results = await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 50000,
      limit: null,
      requireWebsite: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(GOOGLE_MAX_RESULTS);
  });

  it("stops at Google's ceiling of 60, so 'no limit' is bounded", async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(20, 0, "t2"))
      .mockResolvedValueOnce(pageOf(20, 20, "t3"))
      // Google would keep offering tokens; we must not keep paying for them.
      .mockResolvedValueOnce(pageOf(20, 40, "t4"))
      .mockResolvedValue(pageOf(20, 60, "t5"));

    const results = await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 50000,
      limit: null,
      requireWebsite: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.length).toBeLessThanOrEqual(GOOGLE_MAX_RESULTS);
  });

  it("passes the key in a header and never in the URL", async () => {
    fetchMock.mockResolvedValue(pageOf(1, 0));
    await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 15000,
      limit: 20,
      requireWebsite: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe(API_KEY);
  });

  it("fetches only one page for a small unfiltered request", async () => {
    // Each page is billed separately, so a 20-result search must not pay for 60.
    fetchMock.mockResolvedValue(pageOf(20, 0, "token-2"));
    await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 15000,
      limit: 20,
      requireWebsite: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches headroom when the website filter will drop records", async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(20, 0, "token-2"))
      .mockResolvedValueOnce(pageOf(20, 20));
    await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 50000,
      limit: 20,
      requireWebsite: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps at the requested limit", async () => {
    fetchMock.mockResolvedValue(pageOf(20, 0));
    const results = await provider().searchDentists({
      ...CENTRE,
      radiusMeters: 50000,
      limit: 5,
      requireWebsite: false,
    });
    expect(results).toHaveLength(5);
  });

  it("recognises an invalid key, which Google reports as HTTP 400", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
          },
        },
        400,
      ),
    );

    await expect(
      provider().searchDentists({
        ...CENTRE,
        radiusMeters: 15000,
        limit: 20,
        requireWebsite: false,
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it("caches a search so switching limits does not re-bill", async () => {
    fetchMock.mockResolvedValue(pageOf(20, 0));
    const google = provider();
    const params = { ...CENTRE, radiusMeters: 15000, requireWebsite: false };

    await google.searchDentists({ ...params, limit: 20 });
    await google.searchDentists({ ...params, limit: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
