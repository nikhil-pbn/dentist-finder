/**
 * XLSX writer tests.
 *
 * The archive is parsed back by a reader written independently of the writer,
 * rather than by reusing the writer's own offsets - otherwise a mistake in the
 * ZIP layout would agree with itself and pass.
 *
 * That still only proves this reader and that writer agree. The independent
 * check is unzipping a generated workbook with a real ZIP implementation; see
 * "Verifying the Excel export" in the README.
 */
import { describe, expect, it } from "vitest";
import {
  buildXlsxFileName,
  columnLetter,
  crc32,
  dentistsToXlsx,
  escapeXml,
  sheetXml,
  zipStore,
} from "@/lib/xlsx";
import type { Dentist } from "@/lib/types";
import { makeDentist } from "./factories";

const OSM: Dentist = makeDentist({
  id: "osm:node/1",
  name: "Irvine Family Dental",
  address: "123 Main St, Irvine, CA 92618",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-0100",
  website: "https://example.com/",
  email: "hello@example.com",
  mapUrl: "https://www.openstreetmap.org/node/1",
  source: "osm",
  sourceId: "node/1",
});

const GOOGLE: Dentist = makeDentist({
  id: "google:ChIJtest1",
  name: "Irvine Dental Group",
  address: "123 Main St, Irvine, CA 92618, USA",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-1234",
  website: "https://www.irvinedentalgroup.com",
  currentOpen: true,
  mapUrl: "https://www.google.com/maps/place/?q=place_id:ChIJtest1",
  source: "google",
  sourceId: "ChIJtest1",
  rating: 4.8,
  reviews: 247,
  businessStatus: "OPERATIONAL",
});

/* -------------------------------------------------------------------------- */
/* An independent reader for stored (uncompressed) ZIP archives.              */
/* -------------------------------------------------------------------------- */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;

function readEntries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();

  let offset = 0;
  while (offset + 4 <= archive.length && view.getUint32(offset, true) === LOCAL_HEADER) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(archive.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(name, decoder.decode(archive.subarray(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }

  return entries;
}

/** The byte offset the end-of-central-directory record points at. */
function centralDirectoryOffset(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  return view.getUint32(archive.length - 22 + 16, true);
}

function sheetOf(dentists: readonly Dentist[]): string {
  const sheet = readEntries(dentistsToXlsx(dentists)).get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("workbook has no worksheet");
  return sheet;
}

/* -------------------------------------------------------------------------- */

describe("columnLetter", () => {
  it("counts in the base-26 scheme spreadsheets use", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    // The carry has no zero digit, which is where a naive base-26 goes wrong.
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
  });
});

describe("escapeXml", () => {
  it("escapes the characters that would break the document", () => {
    expect(escapeXml('Smith & Sons <"Dental">')).toBe(
      "Smith &amp; Sons &lt;&quot;Dental&quot;&gt;",
    );
  });

  it("drops control characters XML cannot represent at all", () => {
    // One stray byte in one practice name would otherwise make the whole
    // workbook unreadable rather than just that cell.
    // Built from char codes: the characters themselves are invisible in a
    // source file, and a literal NUL would make this file binary.
    expect(escapeXml(`Bad${String.fromCharCode(0)}Name`)).toBe("BadName");
    expect(escapeXml(`Bad${String.fromCharCode(11)}Name`)).toBe("BadName");
    expect(escapeXml(`Bad${String.fromCharCode(31)}Name`)).toBe("BadName");
  });

  it("keeps tabs and newlines, which are legal", () => {
    expect(escapeXml("Line 1\nLine 2\tEnd")).toBe("Line 1\nLine 2\tEnd");
  });
});

describe("crc32", () => {
  it("matches the standard check value", () => {
    // The published CRC-32 check value for "123456789".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("zipStore", () => {
  const archive = zipStore([
    { name: "a.txt", data: new TextEncoder().encode("hello") },
    { name: "dir/b.txt", data: new TextEncoder().encode("world") },
  ]);

  it("writes an archive that reads back entry for entry", () => {
    const entries = readEntries(archive);
    expect([...entries.keys()]).toEqual(["a.txt", "dir/b.txt"]);
    expect(entries.get("a.txt")).toBe("hello");
    expect(entries.get("dir/b.txt")).toBe("world");
  });

  it("points its end record at a real central directory", () => {
    // The offset every unzip implementation seeks to first. Getting it wrong
    // produces a file that looks fine byte-for-byte until something opens it.
    const offset = centralDirectoryOffset(archive);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(offset, true)).toBe(CENTRAL_HEADER);
  });

  it("is deterministic, so the same results produce the same bytes", () => {
    const again = zipStore([
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "dir/b.txt", data: new TextEncoder().encode("world") },
    ]);
    expect([...again]).toEqual([...archive]);
  });

  it("writes an empty archive without an entry", () => {
    expect(readEntries(zipStore([])).size).toBe(0);
  });
});

describe("sheetXml", () => {
  it("freezes the header row", () => {
    expect(sheetXml(["Name"], [10], [])).toContain('state="frozen"');
  });

  it("omits an empty cell rather than writing a placeholder", () => {
    const xml = sheetXml(["Name", "Phone"], [10, 10], [["Only a name", null]]);
    expect(xml).toContain('r="A2"');
    expect(xml).not.toContain('r="B2"');
  });
});

describe("dentistsToXlsx", () => {
  it("contains every part a workbook needs", () => {
    const entries = readEntries(dentistsToXlsx([GOOGLE]));
    expect([...entries.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("names the sheet", () => {
    const workbook = readEntries(dentistsToXlsx([GOOGLE])).get("xl/workbook.xml");
    expect(workbook).toContain('name="Dentists"');
  });

  it("writes the header row and the values beneath it", () => {
    const sheet = sheetOf([GOOGLE]);
    expect(sheet).toContain("<t xml:space=\"preserve\">Name</t>");
    expect(sheet).toContain("<t xml:space=\"preserve\">Irvine Dental Group</t>");
    expect(sheet).toContain(
      "<t xml:space=\"preserve\">123 Main St, Irvine, CA 92618</t>",
    );
  });

  it("stores a rating as a number, so it can be sorted and averaged", () => {
    const sheet = sheetOf([GOOGLE]);
    expect(sheet).toContain("<v>4.8</v>");
    expect(sheet).toContain("<v>247</v>");
    // Not as text, which is what a CSV import would have produced.
    expect(sheet).not.toContain('<t xml:space="preserve">4.8</t>');
  });

  it("keeps a phone number as text, so it is not read as an equation", () => {
    expect(sheetOf([GOOGLE])).toContain(
      "<t xml:space=\"preserve\">+1 949-555-1234</t>",
    );
  });

  it("uses the same columns the CSV does", () => {
    // An OSM set: email in, Google's four out.
    const sheet = sheetOf([OSM]);
    expect(sheet).toContain("<t xml:space=\"preserve\">Email</t>");
    expect(sheet).not.toContain("<t xml:space=\"preserve\">Rating</t>");
    expect(sheet).not.toContain("<t xml:space=\"preserve\">Business Status</t>");
  });

  it("gives a Google set no Email column", () => {
    expect(sheetOf([GOOGLE])).not.toContain("<t xml:space=\"preserve\">Email</t>");
  });

  it("escapes a name that would otherwise break the XML", () => {
    const sheet = sheetOf([{ ...OSM, name: 'Smith & "Sam" <Dental>' }]);
    expect(sheet).toContain("Smith &amp; &quot;Sam&quot; &lt;Dental&gt;");
    // The raw form must not survive anywhere in the document.
    expect(sheet).not.toContain("<Dental>");
  });

  it("writes a header-only workbook for an empty result set", () => {
    const sheet = sheetOf([]);
    expect(sheet).toContain('<row r="1">');
    expect(sheet).not.toContain('<row r="2">');
  });
});

describe("buildXlsxFileName", () => {
  it("names the file after the search", () => {
    expect(buildXlsxFileName("92618", 15000)).toBe("dentists-92618-15km.xlsx");
  });
});
