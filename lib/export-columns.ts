/**
 * The columns an export carries, shared by the CSV and Excel writers.
 *
 * One definition serves both: a column declares its header and how to read its
 * cell in the same place, so the two files can never disagree about what is in
 * them, and a header can never drift out of step with the values beneath it.
 */
import type { Dentist } from "@/lib/types";

/**
 * Renders a tri-state boolean for a spreadsheet.
 *
 * Unknown stays an empty cell rather than becoming "No" - a column of "No"
 * would read as "all of them are closed", which is not what the source said.
 */
export function formatOpenNow(value: boolean | null): string {
  if (value === null) return "";
  return value ? "Yes" : "No";
}

/**
 * A cell value. The `number` case matters to the Excel writer, which stores it
 * as a number rather than as text, so a rating can be sorted and averaged.
 */
export type ExportValue = string | number | null | undefined;

export interface ExportColumn {
  header: string;
  value: (dentist: Dentist) => ExportValue;
  /**
   * Optional columns appear only when at least one result has something to put
   * in them. The rest are the columns every provider can fill.
   */
  optional?: true;
  /** Rendered width in characters, used for the Excel column widths. */
  width: number;
}

/*
 * Every column an export can produce, in order.
 *
 * Coordinates, distance, the full opening-hours schedule and provenance stay on
 * the `Dentist` model - the provider needs them for distance sorting,
 * de-duplication and map links - they are simply not part of the export.
 */
const ALL_COLUMNS: readonly ExportColumn[] = [
  { header: "Name", value: (d) => d.name, width: 34 },
  // The display form, matching what the table and cards show.
  { header: "Address", value: (d) => d.shortAddress ?? d.address, width: 40 },
  { header: "Phone", value: (d) => d.phone, width: 18 },
  { header: "Email", value: (d) => d.email, optional: true, width: 28 },
  { header: "Website", value: (d) => d.website, width: 36 },
  { header: "Rating", value: (d) => d.rating, optional: true, width: 8 },
  { header: "Reviews", value: (d) => d.reviews, optional: true, width: 9 },
  {
    header: "Open Now",
    value: (d) => formatOpenNow(d.currentOpen),
    optional: true,
    width: 10,
  },
  {
    header: "Business Status",
    value: (d) => d.businessStatus,
    optional: true,
    width: 18,
  },
  { header: "Map URL", value: (d) => d.mapUrl, width: 44 },
];

export function hasValue(value: ExportValue): boolean {
  if (value === null || value === undefined) return false;
  // A rating of 0 is data; only genuinely blank cells count as absent.
  return String(value).trim().length > 0;
}

/**
 * Chooses the columns for a given result set.
 *
 * An OSM export carries no Rating, Reviews, Open Now or Business Status
 * columns, because OSM has none of them; a Google export carries no Email
 * column, because the Places API has no email field. The file describes what
 * was actually found rather than what the model can hold.
 *
 * Decided by the data, never by `dentist.source` - the same rule the table
 * uses - so a future provider needs no change here, and a mixed result set
 * keeps every column that any row can fill.
 */
export function selectExportColumns(
  dentists: readonly Dentist[],
): readonly ExportColumn[] {
  return ALL_COLUMNS.filter(
    (column) =>
      !column.optional ||
      dentists.some((dentist) => hasValue(column.value(dentist))),
  );
}
