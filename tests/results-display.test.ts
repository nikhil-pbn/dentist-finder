/**
 * Tests for the one presentation decision that is not purely cosmetic: whether
 * the ratings columns appear.
 *
 * The rule has to be data-driven rather than `source === "google"`, or the
 * table starts branching on the provider - the exact coupling the abstraction
 * exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { hasRatings } from "@/components/DentistFields";
import { makeDentist } from "./factories";

const osmResult = makeDentist({ id: "osm:node/1", name: "No Ratings Here" });
const googleResult = makeDentist({
  id: "google:ChIJ1",
  source: "google",
  name: "Irvine Dental Group",
  rating: 4.8,
  reviews: 247,
});

describe("hasRatings", () => {
  it("is false for a result set that carries none, as OSM's never do", () => {
    expect(hasRatings([osmResult, makeDentist({ id: "osm:node/2" })])).toBe(false);
  });

  it("is true as soon as one result has a rating", () => {
    expect(hasRatings([osmResult, googleResult])).toBe(true);
  });

  it("is true for a review count without a rating", () => {
    // A brand-new listing can have neither; a rating and a count can also
    // arrive independently. Either one is worth a column.
    expect(hasRatings([makeDentist({ rating: null, reviews: 3 })])).toBe(true);
    expect(hasRatings([makeDentist({ rating: 4.1, reviews: null })])).toBe(true);
  });

  it("is false for no results at all", () => {
    expect(hasRatings([])).toBe(false);
  });

  it("does not look at the provider id", () => {
    // A Google result with no rating yet must not force an empty column, and
    // an OSM result that somehow had one would get it.
    expect(hasRatings([makeDentist({ source: "google" })])).toBe(false);
    expect(hasRatings([makeDentist({ source: "osm", rating: 4.5 })])).toBe(true);
  });
});
