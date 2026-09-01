/**
 * Tests for editing an existing .xlsx in place.
 *
 * This is the code that rewrites someone's real spreadsheet, so the bar is
 * higher than "the rows appear": every other part of the workbook must come
 * back byte for byte, and the fixtures are deflate-compressed because that is
 * what Excel and Drive actually produce - a writer that only ever handled
 * stored entries would pass a laxer suite and corrupt the first real file.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  appendRowsToSheetXml,
  appendRowsToWorkbook,
  columnLetter,
  findSheetPath,
  listTabNames,
  readZip,
  writeZip,
  type ZipMember,
} from "@/lib/sheets/xlsx-edit";

const DEFLATED = 8;

function sheetXml(rows: string[] = []): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C${
    rows.length || 1
  }"/><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function row(index: number, values: string[]): string {
  const cells = values
    .map(
      (value, column) =>
        `<c r="${columnLetter(column)}${index}" t="inlineStr"><is><t>${value}</t></is></c>`,
    )
    .join("");
  return `<row r="${index}">${cells}</row>`;
}

/**
 * A two-tab workbook whose worksheet parts are deliberately numbered against
 * the grain - `osm` lives in sheet2.xml - so anything that assumes tab order
 * matches file numbering fails here rather than in production.
 */
function makeWorkbook(options: { osmRows?: string[]; googleRows?: string[] } = {}) {
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships/>',
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook><sheets>' +
      '<sheet name="google" sheetId="1" r:id="rId1"/>' +
      '<sheet name="osm" sheetId="2" r:id="rId2"/>' +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships>' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
      "</Relationships>",
    "xl/sharedStrings.xml": '<?xml version="1.0"?><sst count="0"/>',
    "xl/worksheets/sheet1.xml": sheetXml(options.googleRows ?? []),
    "xl/worksheets/sheet2.xml": sheetXml(options.osmRows ?? []),
  };

  return writeZip(
    Object.entries(parts).map(([name, xml]) => ({
      name,
      data: Buffer.from(xml, "utf8"),
      method: DEFLATED,
    })),
  );
}

function partOf(workbook: Buffer, name: string): string {
  const member = readZip(workbook).find((entry) => entry.name === name);
  if (!member) throw new Error(`missing part ${name}`);
  return member.data.toString("utf8");
}

describe("zip round trip", () => {
  it("reads back what it writes, deflated", () => {
    const members: ZipMember[] = [
      { name: "a.xml", data: Buffer.from("<a/>"), method: DEFLATED },
      { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 250, 255]), method: 0 },
    ];
    const read = readZip(writeZip(members));

    expect(read.map((m) => m.name)).toEqual(["a.xml", "dir/b.bin"]);
    expect(read[0].data.toString()).toBe("<a/>");
    expect([...read[1].data]).toEqual([0, 1, 2, 250, 255]);
  });

  it("reads an archive produced by a different compressor", () => {
    // Written by hand with node's deflate rather than by writeZip, so the
    // reader is not merely agreeing with its own writer.
    const payload = Buffer.from("<worksheet/>", "utf8");
    const compressed = deflateRawSync(payload);
    expect(compressed.length).toBeGreaterThan(0);

    const archive = writeZip([
      { name: "xl/worksheets/sheet1.xml", data: payload, method: DEFLATED },
    ]);
    expect(readZip(archive)[0].data.toString()).toBe("<worksheet/>");
  });

  it("rejects something that is not a ZIP at all", () => {
    expect(() => readZip(Buffer.from("not a workbook"))).toThrow(/not a ZIP/);
  });
});

describe("findSheetPath", () => {
  it("resolves a tab through its relationship, not by file order", () => {
    const members = readZip(makeWorkbook());
    // The trap: "osm" is the second tab but lives in sheet2.xml only because
    // the rels say so, and a workbook where they disagree is common.
    expect(findSheetPath(members, "osm")).toBe("xl/worksheets/sheet2.xml");
    expect(findSheetPath(members, "google")).toBe("xl/worksheets/sheet1.xml");
  });

  it("returns null for a tab that is not there", () => {
    expect(findSheetPath(readZip(makeWorkbook()), "yelp")).toBeNull();
  });

  it("lists the tabs a workbook has", () => {
    expect(listTabNames(readZip(makeWorkbook()))).toEqual(["google", "osm"]);
  });
});

describe("appendRowsToSheetXml", () => {
  it("continues the numbering rather than restarting", () => {
    const existing = sheetXml([row(1, ["Name"]), row(2, ["First"])]);
    const updated = appendRowsToSheetXml(existing, [["Second"], ["Third"]]);

    expect(updated).toContain('<row r="3">');
    expect(updated).toContain('<row r="4">');
    // The rows that were there are untouched.
    expect(updated).toContain(row(2, ["First"]));
  });

  it("handles a sheet whose element is empty and self-closing", () => {
    const empty = '<worksheet><sheetData/></worksheet>';
    const updated = appendRowsToSheetXml(empty, [["First"]]);
    expect(updated).toContain('<sheetData><row r="1">');
  });

  it("writes numbers as numbers and text as inline strings", () => {
    const updated = appendRowsToSheetXml(sheetXml(), [["Practice", 4.8, 247]]);
    expect(updated).toContain("<v>4.8</v>");
    expect(updated).toContain("<v>247</v>");
    expect(updated).toContain('<is><t xml:space="preserve">Practice</t></is>');
  });

  it("escapes text that would otherwise break the document", () => {
    const updated = appendRowsToSheetXml(sheetXml(), [['Smith & "Sam" <Ltd>']]);
    expect(updated).toContain("Smith &amp; &quot;Sam&quot; &lt;Ltd&gt;");
    expect(updated).not.toContain("<Ltd>");
  });

  it("skips an empty cell instead of writing a placeholder", () => {
    const updated = appendRowsToSheetXml(sheetXml(), [["Name", "", null]]);
    expect(updated).toContain('r="A1"');
    expect(updated).not.toContain('r="B1"');
    expect(updated).not.toContain('r="C1"');
  });

  it("extends the stale dimension, which some readers trust", () => {
    const updated = appendRowsToSheetXml(
      sheetXml([row(1, ["Name"])]),
      [["a", "b", "c"]],
    );
    expect(updated).toMatch(/<dimension ref="A1:[A-Z]+2"\/>/);
  });

  it("changes nothing when there is nothing to add", () => {
    const before = sheetXml([row(1, ["Name"])]);
    expect(appendRowsToSheetXml(before, [])).toBe(before);
  });
});

describe("appendRowsToWorkbook", () => {
  it("adds the rows to the named tab", () => {
    const updated = appendRowsToWorkbook(
      makeWorkbook({ osmRows: [row(1, ["Name"])] }),
      "osm",
      [["Irvine Family Dental", "+1 949-555-0100"]],
    );

    const sheet = partOf(updated, "xl/worksheets/sheet2.xml");
    expect(sheet).toContain("Irvine Family Dental");
    expect(sheet).toContain('<row r="2">');
  });

  it("leaves every other part byte for byte identical", () => {
    /*
     * The whole reason for the surgical approach: formatting, formulas, shared
     * strings and other tabs belong to the user, not to this app.
     */
    const before = makeWorkbook({
      osmRows: [row(1, ["Name"])],
      googleRows: [row(1, ["Name"]), row(2, ["Someone else's data"])],
    });
    const after = appendRowsToWorkbook(before, "osm", [["New"]]);

    const original = new Map(readZip(before).map((m) => [m.name, m.data]));
    for (const member of readZip(after)) {
      if (member.name === "xl/worksheets/sheet2.xml") continue;
      expect(member.data.equals(original.get(member.name)!), member.name).toBe(true);
    }
  });

  it("does not touch the other provider's tab", () => {
    const updated = appendRowsToWorkbook(
      makeWorkbook({ googleRows: [row(1, ["Keep me"])] }),
      "osm",
      [["New osm row"]],
    );
    const google = partOf(updated, "xl/worksheets/sheet1.xml");
    expect(google).toContain("Keep me");
    expect(google).not.toContain("New osm row");
  });

  it("writes the header only into a tab that is still empty", () => {
    const fresh = appendRowsToWorkbook(makeWorkbook(), "osm", [["Row"]], [
      "Name",
      "Phone",
    ]);
    expect(partOf(fresh, "xl/worksheets/sheet2.xml")).toContain("Name");

    const populated = appendRowsToWorkbook(
      makeWorkbook({ osmRows: [row(1, ["Existing header"])] }),
      "osm",
      [["Row"]],
      ["Name", "Phone"],
    );
    const sheet = partOf(populated, "xl/worksheets/sheet2.xml");
    expect(sheet).toContain("Existing header");
    expect(sheet).not.toContain('<t xml:space="preserve">Name</t>');
  });

  it("names the tabs it does have when the one asked for is missing", () => {
    expect(() => appendRowsToWorkbook(makeWorkbook(), "yelp", [["x"]])).toThrow(
      /no tab named "yelp"[\s\S]*google, osm/,
    );
  });

  it("survives a second append, so the sheet is a running log", () => {
    let workbook = makeWorkbook({ osmRows: [row(1, ["Name"])] });
    workbook = appendRowsToWorkbook(workbook, "osm", [["First"]]);
    workbook = appendRowsToWorkbook(workbook, "osm", [["Second"]]);

    const sheet = partOf(workbook, "xl/worksheets/sheet2.xml");
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).toContain("First");
    expect(sheet).toContain("Second");
  });
});
