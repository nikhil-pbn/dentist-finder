/**
 * Minimal XLSX writer, so results open in Excel, Numbers or Google Sheets as a
 * real spreadsheet rather than as text a CSV import has to guess at.
 *
 * Why hand-written rather than a library: an .xlsx file is a ZIP of a handful of
 * small XML parts, and the subset needed for one sheet of text and numbers is
 * short enough to read in full. That keeps the app's runtime dependency count
 * at zero, and keeps a spreadsheet-parsing library - historically a rich source
 * of CVEs - out of a bundle that ships to every visitor.
 *
 * Entries are stored uncompressed. The whole point of the deflate step is size,
 * and these files are a few kilobytes; STORED keeps this module free of a
 * compressor without changing what Excel sees.
 *
 * What it deliberately does NOT do: formulas, multiple sheets, merged cells,
 * dates, or a shared-string table. Anything beyond one flat sheet belongs in a
 * library, not here.
 */
import { triggerDownload } from "@/lib/download";
import {
  selectExportColumns,
  type ExportContext,
} from "@/lib/export-columns";
import type { Dentist } from "@/lib/types";

const SHEET_NAME = "Dentists";

/** The header row's style index in `styles.xml` below: the bold one. */
const BOLD_STYLE = 1;

/*
 * A fixed 1980-01-01 timestamp, the earliest the ZIP format can express.
 * Deterministic output means the same results always produce the same bytes,
 * which is what makes this testable at all.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/* -------------------------------------------------------------------------- */
/* XML                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Escapes text for an XML text node or attribute.
 *
 * Control characters are dropped rather than escaped: XML 1.0 cannot represent
 * them at all, and a single stray byte in one practice name would otherwise
 * make the whole workbook unreadable.
 */
export function escapeXml(value: string): string {
  return value
    // Literal escapes, not raw bytes: these characters are invisible in
    // source and easy to mangle in transit.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index: number): string {
  let remaining = index + 1;
  let letters = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

function cellXml(
  reference: string,
  value: string | number | null | undefined,
  style?: number,
): string {
  const styleAttr = style === undefined ? "" : ` s="${style}"`;
  // An empty cell is omitted entirely, which is valid and smaller than a
  // placeholder - and cannot be mistaken for a value the source supplied.
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "number") {
    // A non-finite number has no XLSX representation; fall through to text
    // rather than write something Excel will reject.
    if (Number.isFinite(value)) {
      return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
    }
  }

  const text = escapeXml(String(value));
  return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/**
 * Builds the worksheet, with the header row frozen so it stays visible while
 * scrolling a long result set.
 */
export function sheetXml(
  headers: readonly string[],
  widths: readonly number[],
  rows: readonly ReadonlyArray<string | number | null | undefined>[],
): string {
  const cols = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");

  const headerCells = headers
    .map((header, index) => cellXml(`${columnLetter(index)}1`, header, BOLD_STYLE))
    .join("");

  const bodyRows = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 2; // Row 1 is the header.
      const cells = row
        .map((value, index) => cellXml(`${columnLetter(index)}${rowNumber}`, value))
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/* Two fonts (normal, bold) and the two fills Excel expects to find. */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

/* -------------------------------------------------------------------------- */
/* ZIP                                                                        */
/* -------------------------------------------------------------------------- */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/** Standard CRC-32, which every ZIP entry header has to carry. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Writes a ZIP archive with every entry stored uncompressed.
 *
 * Layout: each entry's local header and data, then the central directory, then
 * the end-of-central-directory record pointing at it.
 */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), // Version needed to extract.
      ...u16(0), // No flags: names are ASCII and sizes are known up front.
      ...u16(0), // Stored, not deflated.
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size), // Compressed size, equal to the real one when stored.
      ...u32(size),
      ...u16(name.length),
      ...u16(0), // No extra field.
    ]);
    body.push(localHeader, name, entry.data);

    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20), // Version made by.
        ...u16(20), // Version needed to extract.
        ...u16(0),
        ...u16(0),
        ...u16(DOS_TIME),
        ...u16(DOS_DATE),
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(name.length),
        ...u16(0), // Extra field length.
        ...u16(0), // Comment length.
        ...u16(0), // Disk number start.
        ...u16(0), // Internal attributes.
        ...u32(0), // External attributes.
        ...u32(offset), // Where this entry's local header sits.
      ]),
      name,
    );

    offset += localHeader.length + name.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const endOfCentralDirectory = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0), // This disk.
    ...u16(0), // Disk holding the central directory.
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0), // Comment length.
  ]);

  return concat([...body, ...central, endOfCentralDirectory]);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Serialises the currently displayed results as an .xlsx workbook.
 *
 * The columns are `selectExportColumns`, exactly the ones the CSV uses, so the
 * two downloads always describe the same thing. Ratings and review counts are
 * written as numbers rather than text, so they sort and average in the
 * spreadsheet; everything else stays text, which keeps a phone number from
 * being reinterpreted as an equation.
 */
export function dentistsToXlsx(
  dentists: readonly Dentist[],
  context: ExportContext,
): Uint8Array {
  const columns = selectExportColumns(dentists, context);
  const encoder = new TextEncoder();

  const sheet = sheetXml(
    columns.map((column) => column.header),
    columns.map((column) => column.width),
    dentists.map((dentist) => columns.map((column) => column.value(dentist, context))),
  );

  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS_XML) },
    { name: "xl/workbook.xml", data: encoder.encode(WORKBOOK_XML) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS_XML) },
    { name: "xl/styles.xml", data: encoder.encode(STYLES_XML) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) },
  ]);
}

export function buildXlsxFileName(zip: string, radiusMeters: number): string {
  return `dentists-${zip}-${radiusMeters / 1000}km.xlsx`;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function downloadXlsx(fileName: string, workbook: Uint8Array): void {
  // Copied into a fresh ArrayBuffer so the Blob owns its own bytes.
  triggerDownload(
    fileName,
    new Blob([workbook.slice().buffer], { type: XLSX_MIME }),
  );
}
