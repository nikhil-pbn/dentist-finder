/**
 * Surgical row-appending inside an existing .xlsx workbook.
 *
 * The Sheets API refuses to write cells into a Drive-hosted Office file, so the
 * only way to add rows to *that* document, at *that* link, is to rewrite the
 * file itself. This does the smallest possible rewrite: every ZIP entry is
 * carried over untouched except the one worksheet being appended to, and inside
 * that worksheet only new `<row>` elements are inserted before `</sheetData>`.
 *
 * Formatting, formulas, other tabs, shared strings and every other part survive
 * byte for byte, because they are never parsed - only copied.
 *
 * Server-only: it uses `node:zlib`. The browser-side writer in `lib/xlsx.ts`
 * shares none of this.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SearchError } from "@/lib/errors";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

// Compression methods. Anything not deflated is stored, and copied verbatim.
const DEFLATED = 8;

export interface ZipMember {
  name: string;
  /** Uncompressed contents. */
  data: Buffer;
  /** The method the entry arrived with, reused on the way out. */
  method: number;
}

/* -------------------------------------------------------------------------- */
/* ZIP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reads an archive via its central directory rather than by walking local
 * headers: the central directory always carries correct sizes, where a local
 * header may defer them to a data descriptor.
 */
export function readZip(archive: Buffer): ZipMember[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  const members: ZipMember[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_HEADER) {
      throw new SearchError("Corrupt workbook: central directory entry missing");
    }

    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new SearchError(`Corrupt workbook: bad local header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);

    members.push({
      name,
      method,
      data: method === DEFLATED ? inflateRawSync(raw) : Buffer.from(raw),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return members;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // It sits at the very end, after a comment of up to 64 KB.
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new SearchError("Corrupt workbook: not a ZIP archive");
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Buffer): number {
  if (!crcTable) {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    crcTable = table;
  }

  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes the members back out, deflating whatever arrived deflated. */
export function writeZip(members: readonly ZipMember[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const payload =
      member.method === DEFLATED ? deflateRawSync(member.data) : member.data;
    const crc = crc32(member.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(member.method, 8);
    local.writeUInt16LE(0, 10); // Time.
    local.writeUInt16LE(0x0021, 12); // Date: 1980-01-01.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    body.push(local, name, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_HEADER, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(member.method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(member.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 38); // External attributes.
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...body, centralBytes, end]);
}

/* -------------------------------------------------------------------------- */
/* Worksheet editing                                                          */
/* -------------------------------------------------------------------------- */

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

/**
 * Finds the worksheet part backing a named tab.
 *
 * `workbook.xml` names the tabs and carries a relationship id; the rels file
 * turns that into a path. Guessing "sheet1.xml is the first tab" is wrong often
 * enough to matter - deleting and re-adding a tab leaves the numbering shuffled.
 */
export function findSheetPath(
  members: readonly ZipMember[],
  tabName: string,
): string | null {
  const workbook = members.find((member) => member.name === "xl/workbook.xml");
  const rels = members.find(
    (member) => member.name === "xl/_rels/workbook.xml.rels",
  );
  if (!workbook || !rels) return null;

  const workbookXml = workbook.data.toString("utf8");
  const sheetTag = new RegExp(
    `<sheet[^>]*name="${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/?>`,
    "i",
  ).exec(workbookXml);
  if (!sheetTag) return null;

  const relationshipId = /r:id="([^"]+)"/.exec(sheetTag[0])?.[1];
  if (!relationshipId) return null;

  const relsXml = rels.data.toString("utf8");
  const target = new RegExp(
    `<Relationship[^>]*Id="${relationshipId}"[^>]*Target="([^"]+)"`,
    "i",
  ).exec(relsXml)?.[1];
  if (!target) return null;

  const normalized = target.replace(/^\/?xl\//, "").replace(/^\//, "");
  return `xl/${normalized}`;
}

/** The tab names a workbook actually has, for error messages. */
export function listTabNames(members: readonly ZipMember[]): string[] {
  const workbook = members.find((member) => member.name === "xl/workbook.xml");
  if (!workbook) return [];
  const xml = workbook.data.toString("utf8");
  return [...xml.matchAll(/<sheet[^>]*name="([^"]*)"/gi)].map((match) => match[1]);
}

export type CellValue = string | number | null | undefined;

function cellXml(reference: string, value: CellValue): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    String(value),
  )}</t></is></c>`;
}

/**
 * Appends rows to a worksheet's XML, after the last row it already has.
 *
 * Inline strings are used rather than the shared-string table, so the workbook's
 * existing `sharedStrings.xml` never has to be rewritten - one less part that
 * can be corrupted, and the two representations coexist happily in one sheet.
 */
export function appendRowsToSheetXml(
  sheetXml: string,
  rows: readonly CellValue[][],
): string {
  if (rows.length === 0) return sheetXml;

  const lastRow = [...sheetXml.matchAll(/<row[^>]*\sr="(\d+)"/g)].reduce(
    (highest, match) => Math.max(highest, Number(match[1])),
    0,
  );

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const added = rows
    .map((row, index) => {
      const rowNumber = lastRow + 1 + index;
      const cells = row
        .map((value, column) => cellXml(`${columnLetter(column)}${rowNumber}`, value))
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  const updated = insertIntoSheetData(sheetXml, added);

  // A stale <dimension> makes some readers ignore the new rows.
  return updated.replace(
    /<dimension\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/,
    (match, startCol: string, startRow: string, endCol: string) => {
      const lastColumn = columnLetter(Math.max(width - 1, 0));
      const widest = endCol.length >= lastColumn.length ? endCol : lastColumn;
      return `<dimension ref="${startCol}${startRow}:${widest}${lastRow + rows.length}"/>`;
    },
  );
}

function insertIntoSheetData(sheetXml: string, rowsXml: string): string {
  if (sheetXml.includes("</sheetData>")) {
    return sheetXml.replace("</sheetData>", `${rowsXml}</sheetData>`);
  }
  // An untouched sheet can carry a self-closing, empty element.
  const empty = /<sheetData\s*\/>/.exec(sheetXml);
  if (empty) {
    return sheetXml.replace(empty[0], `<sheetData>${rowsXml}</sheetData>`);
  }
  throw new SearchError("Corrupt workbook: worksheet has no sheetData element");
}

/**
 * Appends rows to one tab of a workbook, returning the new file.
 *
 * @throws SearchError when the workbook has no such tab, naming the ones it has.
 */
export function appendRowsToWorkbook(
  workbook: Buffer,
  tabName: string,
  rows: readonly CellValue[][],
  /** Written first when the tab is still empty. Never rewrites an existing one. */
  headers?: readonly string[],
): Buffer {
  const members = readZip(workbook);
  const sheetPath = findSheetPath(members, tabName);

  if (!sheetPath) {
    const available = listTabNames(members);
    throw new SearchError(
      `The workbook has no tab named "${tabName}". Tabs found: ${
        available.join(", ") || "none"
      }. Add a tab with that exact name, or use a native Google Sheet, where the tab is created automatically.`,
    );
  }

  const sheet = members.find((member) => member.name === sheetPath);
  if (!sheet) {
    throw new SearchError(`Corrupt workbook: ${sheetPath} is missing`);
  }

  const sheetXml = sheet.data.toString("utf8");
  const isEmpty = !/<row[^>]*\sr="\d+"/.test(sheetXml);
  const withHeader =
    isEmpty && headers?.length ? [[...headers], ...rows] : rows;

  const updated = appendRowsToSheetXml(sheetXml, withHeader);

  return writeZip(
    members.map((member) =>
      member.name === sheetPath
        ? { ...member, data: Buffer.from(updated, "utf8") }
        : member,
    ),
  );
}
