import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { ConfigurationError } from "@/lib/errors";
import { getDentistSearchProvider, resetProviderRegistry } from "@/lib/providers";
import { GoogleDentistSearchProvider } from "@/lib/providers/google";
import { OsmDentistSearchProvider } from "@/lib/providers/osm";

beforeEach(() => {
  resetProviderRegistry();
});

describe("provider selection", () => {
  it("returns the OSM provider for MAP_PROVIDER=osm", () => {
    const provider = getDentistSearchProvider(loadConfig({ MAP_PROVIDER: "osm" }));
    expect(provider).toBeInstanceOf(OsmDentistSearchProvider);
    expect(provider.id).toBe("osm");
  });

  it("defaults to OSM when MAP_PROVIDER is unset", () => {
    expect(getDentistSearchProvider(loadConfig({}))).toBeInstanceOf(
      OsmDentistSearchProvider,
    );
  });

  it("returns the Google provider for MAP_PROVIDER=google", () => {
    const provider = getDentistSearchProvider(
      loadConfig({ MAP_PROVIDER: "google", GOOGLE_MAPS_API_KEY: "test-key" }),
    );
    expect(provider).toBeInstanceOf(GoogleDentistSearchProvider);
    expect(provider.id).toBe("google");
  });

  it("is case-insensitive about the provider name", () => {
    expect(loadConfig({ MAP_PROVIDER: "OSM" }).mapProvider).toBe("osm");
  });

  it("rejects an unknown provider name", () => {
    expect(() => loadConfig({ MAP_PROVIDER: "yelp" })).toThrow(ConfigurationError);
  });

  it("memoises the instance so its caches survive between requests", () => {
    const config = loadConfig({ MAP_PROVIDER: "osm" });
    expect(getDentistSearchProvider(config)).toBe(getDentistSearchProvider(config));
  });
});

describe("Google configuration", () => {
  it("fails with a clear message when the API key is missing", () => {
    expect(() => loadConfig({ MAP_PROVIDER: "google" })).toThrow(
      "Google provider selected but GOOGLE_MAPS_API_KEY is not configured.",
    );
    expect(() => loadConfig({ MAP_PROVIDER: "google" })).toThrow(ConfigurationError);
  });

  it("does not require a Google key while OSM is selected", () => {
    expect(loadConfig({ MAP_PROVIDER: "osm" }).google.apiKey).toBeNull();
  });

  it("still refuses to run without a key", async () => {
    // loadConfig catches this first, but the provider must not assume that.
    const provider = new GoogleDentistSearchProvider({ apiKey: null });
    await expect(provider.geocodeZip("92618")).rejects.toThrow(
      /GOOGLE_MAPS_API_KEY is not configured/,
    );
  });
});

describe("configuration defaults", () => {
  it("uses the public OSM endpoints and an identifying User-Agent", () => {
    const { osm } = loadConfig({});
    expect(osm.nominatimBaseUrl).toBe("https://nominatim.openstreetmap.org");
    expect(osm.overpassUrls).toEqual(["https://overpass-api.de/api/interpreter"]);
    expect(osm.userAgent).toMatch(/^DentistFinder\//);
  });

  it("allows self-hosted endpoints to be configured", () => {
    const { osm } = loadConfig({
      NOMINATIM_BASE_URL: "https://nominatim.internal/",
      OVERPASS_URL: "https://overpass.internal/api/interpreter",
      OSM_USER_AGENT: "DentistFinder/1.0 (ops@example.com)",
    });
    // Trailing slashes are stripped so URL joining stays predictable.
    expect(osm.nominatimBaseUrl).toBe("https://nominatim.internal");
    expect(osm.overpassUrls).toEqual(["https://overpass.internal/api/interpreter"]);
    expect(osm.userAgent).toBe("DentistFinder/1.0 (ops@example.com)");
  });

  it("reads a comma-separated list of Overpass endpoints in preference order", () => {
    const { osm } = loadConfig({
      OVERPASS_URL:
        "https://overpass-api.de/api/interpreter, https://mirror.example/api/interpreter",
    });
    expect(osm.overpassUrls).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://mirror.example/api/interpreter",
    ]);
  });

  it("validates every endpoint in the list, not just the first", () => {
    expect(() =>
      loadConfig({
        OVERPASS_URL: "https://overpass-api.de/api/interpreter,not-a-url",
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects a list that contains no usable URL", () => {
    expect(() => loadConfig({ OVERPASS_URL: " , , " })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects a malformed endpoint URL", () => {
    expect(() => loadConfig({ OVERPASS_URL: "not a url" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ NOMINATIM_BASE_URL: "ftp://example.com" })).toThrow(
      ConfigurationError,
    );
  });

  it("treats blank environment values as unset", () => {
    expect(loadConfig({ MAP_PROVIDER: "   " }).mapProvider).toBe("osm");
    expect(loadConfig({ GOOGLE_MAPS_API_KEY: "" }).google.apiKey).toBeNull();
  });
});
