import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS_METERS,
  DEFAULT_REQUIRE_WEBSITE,
  DEFAULT_RESULT_LIMIT,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
} from "@/lib/constants";
import { InvalidParameterError, InvalidZipError } from "@/lib/errors";
import {
  getZipValidationError,
  isValidUsZip,
  normalizeZip,
  parseRadiusMeters,
  parseRequireWebsite,
  parseResultLimit,
  parseSearchQuery,
  parseZip,
  readSearchQuery,
} from "@/lib/validation";

describe("ZIP validation", () => {
  it.each(["92618", "10001", "90210", "60601", "33101", "00501"])(
    "accepts the valid ZIP %s",
    (zip) => {
      expect(isValidUsZip(zip)).toBe(true);
    },
  );

  it("accepts ZIP+4 and reduces it to the base code", () => {
    expect(isValidUsZip("92618-1234")).toBe(true);
    expect(normalizeZip("92618-1234")).toBe("92618");
  });

  it.each(["abc", "123", "123456", "", "   ", "9261a", "92618-12", "1234-5678"])(
    "rejects the invalid ZIP %j",
    (zip) => {
      expect(isValidUsZip(zip)).toBe(false);
    },
  );

  it("trims surrounding whitespace", () => {
    expect(isValidUsZip("  92618  ")).toBe(true);
    expect(normalizeZip(" 92618 ")).toBe("92618");
  });

  it("reports an empty input separately from a malformed one", () => {
    expect(getZipValidationError("")).toBe("Please enter a ZIP code.");
    expect(getZipValidationError("abc")).toBe("Please enter a valid US ZIP code.");
    expect(getZipValidationError("92618")).toBeNull();
  });

  it("throws InvalidZipError for missing or malformed values", () => {
    expect(() => parseZip(undefined)).toThrow(InvalidZipError);
    expect(() => parseZip("")).toThrow(InvalidZipError);
    expect(() => parseZip("123")).toThrow(InvalidZipError);
    expect(() => parseZip(92618)).toThrow(InvalidZipError);
  });

  it("keeps technical detail out of the user-facing message", () => {
    try {
      parseZip("<script>");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidZipError);
      expect((error as InvalidZipError).publicMessage).toBe(
        "Please enter a valid US ZIP code.",
      );
    }
  });
});

describe("result limit validation", () => {
  it.each([20, 30, 50])("accepts the allowed limit %i", (limit) => {
    expect(parseResultLimit(limit)).toBe(limit);
    expect(parseResultLimit(String(limit))).toBe(limit);
  });

  it.each([10, 100, 0, -1, 21, 49, 1000])(
    "rejects the disallowed limit %i",
    (limit) => {
      expect(() => parseResultLimit(limit)).toThrow(InvalidParameterError);
    },
  );

  it("rejects non-numeric input", () => {
    expect(() => parseResultLimit("many")).toThrow(InvalidParameterError);
    expect(() => parseResultLimit("20; DROP TABLE")).toThrow(InvalidParameterError);
  });

  it("falls back to the default when omitted", () => {
    expect(parseResultLimit(undefined)).toBe(DEFAULT_RESULT_LIMIT);
    expect(parseResultLimit("")).toBe(DEFAULT_RESULT_LIMIT);
  });

  it("treats a missing parameter as the default, never as unlimited", () => {
    // URLSearchParams.get() returns null for an absent parameter, so this must
    // not be read as "no limit" - that would uncap every unparameterised call.
    expect(parseResultLimit(null)).toBe(DEFAULT_RESULT_LIMIT);
    expect(parseSearchQuery(new URLSearchParams({ zip: "92618" })).limit).toBe(
      DEFAULT_RESULT_LIMIT,
    );
  });
});

describe("unlimited results", () => {
  it.each(["all", "ALL", " all "])("reads %j as no limit", (raw) => {
    expect(parseResultLimit(raw)).toBeNull();
  });

  it("round-trips through the query string", () => {
    const params = new URLSearchParams({ zip: "92618", limit: "all" });
    expect(parseSearchQuery(params).limit).toBeNull();
  });

  it("still refuses an arbitrary large number", () => {
    // Unlimited has to be asked for by name; it is not reachable by guessing a
    // big enough number.
    expect(() => parseResultLimit(99999)).toThrow(InvalidParameterError);
    expect(() => parseResultLimit("1000000")).toThrow(InvalidParameterError);
  });

  it("names the sentinel in the error message", () => {
    try {
      parseResultLimit("heaps");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as InvalidParameterError).publicMessage).toContain('"all"');
    }
  });

  it("survives a hand-edited URL", () => {
    const params = new URLSearchParams({ zip: "92618", limit: "all" });
    expect(readSearchQuery(params).query.limit).toBeNull();
  });
});

describe("radius validation", () => {
  it.each([5000, 10000, 15000, 25000, 50000])(
    "accepts the allowed radius %i",
    (radius) => {
      expect(parseRadiusMeters(radius)).toBe(radius);
      expect(parseRadiusMeters(String(radius))).toBe(radius);
    },
  );

  it("accepts the minimum and maximum", () => {
    expect(parseRadiusMeters(MIN_RADIUS_METERS)).toBe(5000);
    expect(parseRadiusMeters(MAX_RADIUS_METERS)).toBe(50000);
  });

  it("rejects values below the minimum and above the maximum", () => {
    expect(() => parseRadiusMeters(MIN_RADIUS_METERS - 1)).toThrow(
      InvalidParameterError,
    );
    expect(() => parseRadiusMeters(MAX_RADIUS_METERS + 1)).toThrow(
      InvalidParameterError,
    );
    expect(() => parseRadiusMeters(1_000_000)).toThrow(InvalidParameterError);
    expect(() => parseRadiusMeters(-5000)).toThrow(InvalidParameterError);
    expect(() => parseRadiusMeters(0)).toThrow(InvalidParameterError);
  });

  it("rejects an in-range value that is not one of the offered radii", () => {
    expect(() => parseRadiusMeters(12000)).toThrow(InvalidParameterError);
  });

  it("falls back to the default when omitted", () => {
    expect(parseRadiusMeters(undefined)).toBe(DEFAULT_RADIUS_METERS);
  });
});

describe("website filter validation", () => {
  it("defaults to requiring a website", () => {
    expect(DEFAULT_REQUIRE_WEBSITE).toBe(true);
    expect(parseRequireWebsite(undefined)).toBe(true);
    expect(parseRequireWebsite(null)).toBe(true);
    expect(parseRequireWebsite("")).toBe(true);
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("reads %j as on", (raw) => {
    expect(parseRequireWebsite(raw)).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off"])("reads %j as off", (raw) => {
    expect(parseRequireWebsite(raw)).toBe(false);
  });

  it("accepts real booleans", () => {
    expect(parseRequireWebsite(true)).toBe(true);
    expect(parseRequireWebsite(false)).toBe(false);
  });

  it("rejects an ambiguous value rather than guessing", () => {
    // Guessing here would silently widen a search the caller meant to narrow.
    expect(() => parseRequireWebsite("maybe")).toThrow(InvalidParameterError);
    expect(() => parseRequireWebsite("2")).toThrow(InvalidParameterError);
  });
});

describe("parseSearchQuery", () => {
  it("builds a validated query from request parameters", () => {
    const params = new URLSearchParams({
      zip: "92618",
      limit: "50",
      radius: "25000",
      requireWebsite: "0",
    });
    expect(parseSearchQuery(params)).toEqual({
      zip: "92618",
      limit: 50,
      radiusMeters: 25000,
      requireWebsite: false,
    });
  });

  it("applies defaults for omitted optional parameters", () => {
    const params = new URLSearchParams({ zip: "10001" });
    expect(parseSearchQuery(params)).toEqual({
      zip: "10001",
      limit: DEFAULT_RESULT_LIMIT,
      radiusMeters: DEFAULT_RADIUS_METERS,
      requireWebsite: DEFAULT_REQUIRE_WEBSITE,
    });
  });

  it("rejects a client asking for an arbitrary result count", () => {
    const params = new URLSearchParams({ zip: "92618", limit: "500" });
    expect(() => parseSearchQuery(params)).toThrow(InvalidParameterError);
  });
});

describe("readSearchQuery (URL state, non-throwing)", () => {
  it("reads a complete shared link", () => {
    const params = new URLSearchParams({
      zip: "60601",
      limit: "30",
      radius: "5000",
      requireWebsite: "1",
    });
    expect(readSearchQuery(params)).toEqual({
      query: {
        zip: "60601",
        limit: 30,
        radiusMeters: 5000,
        requireWebsite: true,
      },
      hasValidZip: true,
    });
  });

  it("falls back to defaults instead of throwing on a hand-edited URL", () => {
    const params = new URLSearchParams({
      zip: "nope",
      limit: "7",
      radius: "999999",
      requireWebsite: "maybe",
    });
    expect(readSearchQuery(params)).toEqual({
      query: {
        zip: "",
        limit: DEFAULT_RESULT_LIMIT,
        radiusMeters: DEFAULT_RADIUS_METERS,
        requireWebsite: DEFAULT_REQUIRE_WEBSITE,
      },
      hasValidZip: false,
    });
  });

  it("reports no ZIP for an empty URL", () => {
    expect(readSearchQuery(new URLSearchParams()).hasValidZip).toBe(false);
  });
});
