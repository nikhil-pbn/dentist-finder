/**
 * RFC 4180 CSV serialisation for the export button.
 *
 * Runs on the client against results already in memory, so exporting never
 * triggers another API call. The columns come from `export-columns.ts`, shared
 * with the Excel writer.
 */
import { triggerDownload } from "@/lib/download";
import { selectExportColumns } from "@/lib/export-columns";
import type { Dentist } from "@/lib/types";

const ROW_SEPARATOR = "\r\n";

/**
 * Quotes a single field. A value is wrapped in double quotes when it contains a
 * comma, a quote, or a line break; embedded quotes are doubled.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.length === 0) return "";
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(escapeCsvField).join(",");
}

/**
 * Serialises the currently displayed results, with only the columns this set
 * can actually fill. A value the source did not have becomes an empty cell -
 * never "N/A" or "0", which could be mistaken for data it did have.
 *
 * `Open Now` is a snapshot of when the results were fetched, not of when the
 * file is opened.
 */
export function dentistsToCsv(dentists: readonly Dentist[]): string {
  const columns = selectExportColumns(dentists);
  const rows = [
    toCsvRow(columns.map((column) => column.header)),
    ...dentists.map((dentist) =>
      toCsvRow(columns.map((column) => column.value(dentist))),
    ),
  ];
  return rows.join(ROW_SEPARATOR) + ROW_SEPARATOR;
}

export function buildCsvFileName(zip: string, radiusMeters: number): string {
  return `dentists-${zip}-${radiusMeters / 1000}km.csv`;
}

/**
 * Triggers a browser download of the given CSV text.
 * A UTF-8 BOM is prepended so spreadsheet apps detect the encoding correctly.
 */
export function downloadCsv(fileName: string, csv: string): void {
  triggerDownload(
    fileName,
    new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" }),
  );
}
