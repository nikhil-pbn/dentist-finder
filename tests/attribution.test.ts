/**
 * Attribution tests.
 *
 * The footer is the one place a provider swap could silently produce a false
 * statement - crediting OpenStreetMap for data that came from Google - so the
 * credit is pinned per provider here.
 */
import { describe, expect, it } from "vitest";
import { getProviderIdForDisplay } from "@/lib/config";
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS } from "@/lib/constants";
import { PROVIDER_ATTRIBUTION } from "@/lib/providers/attribution";

function render(id: (typeof PROVIDER_IDS)[number]): string {
  const { prefix, link, suffix } = PROVIDER_ATTRIBUTION[id];
  return `${prefix}${link.label}${suffix}`;
}

describe("provider attribution", () => {
  it("covers every provider, so adding one cannot skip its credit", () => {
    for (const id of PROVIDER_IDS) {
      const attribution = PROVIDER_ATTRIBUTION[id];
      expect(attribution, id).toBeDefined();
      expect(attribution.link.label.length, id).toBeGreaterThan(0);
      expect(attribution.link.href, id).toMatch(/^https:\/\//);
    }
  });

  it("gives OSM the ODbL credit the licence asks for", () => {
    const text = render("osm");
    expect(text).toContain("OpenStreetMap contributors");
    expect(text).toContain("Open Database License");
    expect(PROVIDER_ATTRIBUTION.osm.link.href).toBe(
      "https://www.openstreetmap.org/copyright",
    );
  });

  it("gives Google the 'Powered by Google' credit its policy requires", () => {
    expect(render("google")).toContain("Powered by Google");
  });

  it("never credits the other provider's source", () => {
    // The actual bug this guards: a Google-backed page still saying "Map data
    // (c) OpenStreetMap contributors".
    expect(render("google")).not.toMatch(/openstreetmap|overpass|nominatim/i);
    expect(render("osm")).not.toMatch(/google/i);
  });
});

describe("getProviderIdForDisplay", () => {
  it("reports the configured provider", () => {
    expect(getProviderIdForDisplay({ MAP_PROVIDER: "google" })).toBe("google");
    expect(getProviderIdForDisplay({ MAP_PROVIDER: "osm" })).toBe("osm");
  });

  it("does not need an API key, unlike loadConfig", () => {
    // The footer must render for a half-configured environment; the search is
    // what reports the missing key.
    expect(() =>
      getProviderIdForDisplay({ MAP_PROVIDER: "google" }),
    ).not.toThrow();
  });

  it("falls back to the default instead of blanking the page on a typo", () => {
    expect(getProviderIdForDisplay({ MAP_PROVIDER: "gogle" })).toBe(
      DEFAULT_PROVIDER_ID,
    );
    expect(getProviderIdForDisplay({})).toBe(DEFAULT_PROVIDER_ID);
  });
});
