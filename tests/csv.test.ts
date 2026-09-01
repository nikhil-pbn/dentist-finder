import { describe, expect, it } from "vitest";
import { buildCsvFileName, dentistsToCsv, escapeCsvField } from "@/lib/csv";
import { formatOpenNow, selectExportColumns } from "@/lib/export-columns";
import type { Dentist } from "@/lib/types";
import { makeDentist } from "./factories";

/** The ZIP that was searched. It is a column, not a property of any result. */
const CONTEXT = { zip: "92618" };

/*
 * A populated record. Coordinates, distance, opening hours and provenance stay
 * on the model without appearing in the export - the provider needs them.
 */
const BASE: Dentist = makeDentist({
  id: "osm:node/1",
  name: "Irvine Family Dental",
  address: "123 Main St, Irvine, CA 92618",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-0100",
  website: "https://example.com/",
  email: "example@email.com",
  latitude: 33.6705,
  longitude: -117.7505,
  mapUrl: "https://www.openstreetmap.org/node/1",
  distanceKm: 0.42,
  source: "osm",
  sourceId: "node/1",
});

/*
 * The same practice as Google returns it: rating, review count, a live open
 * flag and a business status, and no email, because Places has no such field.
 */
const GOOGLE: Dentist = makeDentist({
  id: "google:ChIJtest1",
  name: "Irvine Dental Group",
  address: "123 Main St, Irvine, CA 92618, USA",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-1234",
  website: "https://www.irvinedentalgroup.com",
  email: null,
  currentOpen: true,
  mapUrl: "https://www.google.com/maps/place/?q=place_id:ChIJtest1",
  source: "google",
  sourceId: "ChIJtest1",
  rating: 4.8,
  reviews: 247,
  businessStatus: "OPERATIONAL",
});

/** Splits an export into its rows, dropping the trailing terminator. */
function rowsOf(dentists: readonly Dentist[]): string[] {
  return dentistsToCsv(dentists, CONTEXT).trimEnd().split("\r\n");
}

describe("escapeCsvField", () => {
  it("leaves plain values untouched", () => {
    expect(escapeCsvField("Dental")).toBe("Dental");
    expect(escapeCsvField(42)).toBe("42");
  });

  it("renders null and undefined as an empty cell", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("quotes values containing a comma", () => {
    expect(escapeCsvField("123 Main St, Irvine")).toBe('"123 Main St, Irvine"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('The "Best" Dental')).toBe('"The ""Best"" Dental"');
  });

  it("quotes values containing newlines", () => {
    expect(escapeCsvField("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
    expect(escapeCsvField("Line 1\r\nLine 2")).toBe('"Line 1\r\nLine 2"');
  });
});

describe("dentistsToCsv", () => {
  it("writes a header row followed by one row per result", () => {
    const rows = rowsOf([BASE]);
    expect(rows).toHaveLength(2);
    // An OSM record, so no rating, review, open-state or status columns.
    expect(rows[0]).toBe("Name,Address,Phone,Email,Website,Map URL,Search ZIP");
    // Only the address needs quoting - the escaping is minimal, not blanket.
    expect(rows[1]).toBe(
      'Irvine Family Dental,"123 Main St, Irvine, CA 92618",+1 949-555-0100,example@email.com,https://example.com/,https://www.openstreetmap.org/node/1,92618',
    );
  });

  it("keeps rows aligned when fields are missing", () => {
    const sparse: Dentist = {
      ...BASE,
      name: null,
      address: null,
      shortAddress: null,
      phone: null,
      email: null,
      website: null,
      distanceKm: null,
    };
    const [header, row] = rowsOf([sparse]);
    // Email follows the data out; the always-present columns stay, just empty.
    expect(header).toBe("Name,Address,Phone,Website,Map URL,Search ZIP");
    expect(row.split(",")).toHaveLength(6);
    expect(row).toBe(",,,,https://www.openstreetmap.org/node/1,92618");
  });

  it("survives a name that would otherwise break the file", () => {
    const nasty: Dentist = {
      ...BASE,
      name: 'Smith, "Sam" & Co.\nSuite 2',
    };
    const csv = dentistsToCsv([nasty], CONTEXT);
    expect(csv).toContain('"Smith, ""Sam"" & Co.\nSuite 2"');
    // The header row is still intact and terminated.
    expect(csv.split("\r\n")[0].startsWith("Name,Address")).toBe(true);
  });

  it("writes the email address when the source has one", () => {
    const withEmail: Dentist = { ...BASE, email: "hello@example.com" };
    expect(rowsOf([withEmail])[1]).toContain(",hello@example.com,");
  });

  it("gives every row exactly as many values as there are headers", () => {
    /*
     * Regression: the column list was once trimmed without trimming the row
     * builder, so every row silently misaligned against its header. Header and
     * cells now come from a single column definition, which is what makes that
     * class of bug unrepresentable - this pins it across every column set the
     * selector can produce. Comma-free fixtures, so a naive split counts
     * fields correctly.
     */
    const populated: Dentist = {
      ...BASE,
      address: "1 Main St",
      shortAddress: "1 Main St",
    };
    const empty: Dentist = {
      ...BASE,
      name: null,
      address: null,
      shortAddress: null,
      phone: null,
      email: null,
      website: null,
      mapUrl: null,
    };
    const google: Dentist = {
      ...GOOGLE,
      address: "1 Main St",
      shortAddress: "1 Main St",
    };

    for (const dentists of [[populated], [empty], [populated, empty], [google]]) {
      const rows = rowsOf(dentists);
      const headers = rows[0].split(",").length;
      for (const row of rows.slice(1)) {
        expect(row.split(",")).toHaveLength(headers);
      }
    }
  });

  it("excludes the fields the export deliberately leaves out", () => {
    const csv = dentistsToCsv([BASE], CONTEXT);
    expect(csv).not.toContain("33.6705");
    expect(csv).not.toContain("-117.7505");
    expect(csv).not.toContain("0.42");
    // `sourceId` is not a column. Checked as a whole field rather than as a
    // substring, because "node/1" is also the tail of the map URL.
    const fields = rowsOf([BASE])[1].split(",");
    expect(fields).not.toContain("node/1");
    for (const header of ["Latitude", "Longitude", "Distance", "Source", "Opening Hours"]) {
      expect(csv).not.toContain(header);
    }
  });

  it("emits only a header for an empty result set", () => {
    const rows = rowsOf([]);
    expect(rows).toHaveLength(1);
    // With nothing to describe, the columns both providers can always fill.
    expect(rows[0]).toBe("Name,Address,Phone,Website,Map URL,Search ZIP");
  });
});

describe("columns follow the data, not the model", () => {
  it("gives an OSM export no Google columns", () => {
    const header = rowsOf([BASE])[0];
    for (const googleOnly of ["Rating", "Reviews", "Open Now", "Business Status"]) {
      expect(header).not.toContain(googleOnly);
    }
    expect(header).toContain("Email");
  });

  it("gives a Google export no Email column", () => {
    // Places has no email field, so the column would be empty in every row.
    const header = rowsOf([GOOGLE])[0];
    expect(header).not.toContain("Email");
    expect(header).toBe(
      "Name,Address,Phone,Website,Rating,Reviews,Open Now,Business Status,Map URL,Search ZIP",
    );
  });

  it("exports the Google values under those columns", () => {
    expect(rowsOf([GOOGLE])[1]).toBe(
      'Irvine Dental Group,"123 Main St, Irvine, CA 92618",+1 949-555-1234,https://www.irvinedentalgroup.com,4.8,247,Yes,OPERATIONAL,https://www.google.com/maps/place/?q=place_id:ChIJtest1,92618',
    );
  });

  it("exports the country-trimmed address, not the raw one", () => {
    // `address` still holds Google's verbatim string; the export shows the
    // display form, so the two must not both end up in the file.
    expect(dentistsToCsv([GOOGLE], CONTEXT)).not.toContain("USA");
  });

  it("keeps a column that only some of the rows can fill", () => {
    // A mixed set must not lose the email that one of its rows does have.
    const header = rowsOf([BASE, GOOGLE])[0];
    expect(header).toContain("Email");
    expect(header).toContain("Rating");
  });

  it("treats a rating of zero as data, not as a blank", () => {
    const unrated: Dentist = { ...GOOGLE, rating: 0, reviews: 0 };
    const [header, row] = rowsOf([unrated]);
    expect(header).toContain("Rating");
    expect(header).toContain("Reviews");
    expect(row).toContain(",0,0,");
  });

  it("never decides by provider id", () => {
    // An OSM record that somehow carried a rating would still get the column;
    // a Google record without one would not.
    expect(rowsOf([makeDentist({ source: "osm", rating: 4.5 })])[0]).toContain(
      "Rating",
    );
    expect(
      rowsOf([makeDentist({ source: "google", email: "a@b.com" })])[0],
    ).toContain("Email");
    expect(rowsOf([makeDentist({ source: "google" })])[0]).not.toContain(
      "Rating",
    );
  });

  it("selectExportColumns reports the same set the file uses", () => {
    const headers = selectExportColumns([GOOGLE], CONTEXT).map((column) => column.header);
    expect(rowsOf([GOOGLE])[0]).toBe(headers.join(","));
  });
});

describe("the Search ZIP column", () => {
  /** Built from char codes, so no escape can be mangled in transit. */
  const ROW_BREAK = String.fromCharCode(13, 10);
  const rowsWith = (dentists: readonly Dentist[], context: { zip: string }) =>
    dentistsToCsv(dentists, context).trimEnd().split(ROW_BREAK);

  it("closes every export with the ZIP that was searched", () => {
    const [header, row] = rowsOf([BASE]);
    expect(header.endsWith(",Search ZIP")).toBe(true);
    expect(row.endsWith(",92618")).toBe(true);
  });

  it("reports the searched ZIP, not the practice's own", () => {
    /*
     * A 92618 search legitimately returns Lake Forest 92630. The column says
     * which search produced the row, which is why it is not called "ZIP" and
     * is not read off the address.
     */
    const elsewhere = makeDentist({
      id: "osm:node/9",
      name: "OC Splendid Smiles",
      shortAddress: "24531 Trabuco Road, Lake Forest, CA 92630",
      mapUrl: "https://www.openstreetmap.org/node/9",
    });
    const row = rowsWith([elsewhere], { zip: "92618" })[1];

    expect(row.endsWith(",92618")).toBe(true);
    expect(row).toContain("92630");
  });

  it("is present even for an empty result set", () => {
    expect(rowsOf([])[0].endsWith(",Search ZIP")).toBe(true);
  });

  it("keeps a leading zero, which a number would lose", () => {
    // 02134 is a real ZIP. Written as a number it becomes 2134.
    const row = rowsWith([BASE], { zip: "02134" })[1];
    expect(row.endsWith(",02134")).toBe(true);
  });
});

describe("formatOpenNow", () => {
  it("renders the two known states", () => {
    expect(formatOpenNow(true)).toBe("Yes");
    expect(formatOpenNow(false)).toBe("No");
  });

  it("renders unknown as empty, never as No", () => {
    // Under OSM every row is unknown. A column of "No" would say every
    // practice is closed, which is a claim the data does not support.
    expect(formatOpenNow(null)).toBe("");
  });

  it("drops the column entirely when no row knows its open state", () => {
    const csv = dentistsToCsv([BASE], CONTEXT);
    expect(csv).not.toContain("Open Now");
    expect(csv).not.toContain(",No,");
  });

  it("keeps the column, and a No, when a row is known to be closed", () => {
    const closed: Dentist = { ...GOOGLE, currentOpen: false };
    const [header, row] = rowsOf([closed]);
    expect(header).toContain("Open Now");
    expect(row).toContain(",No,");
  });
});

describe("buildCsvFileName", () => {
  it("names the file after the search", () => {
    expect(buildCsvFileName("92618", 15000)).toBe("dentists-92618-15km.csv");
  });
});
