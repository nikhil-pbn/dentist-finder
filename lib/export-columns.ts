/**
 * The columns an export carries, shared by the CSV and Excel writers.
 *
 * One definition serves both: a column declares its header and how to read its
 * cell in the same place, so the two files can never disagree about what is in
 * them, and a header can never drift out of step with the values beneath it.
 */
import type { ProviderId } from "@/lib/constants";
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

/**
 * What the export knows beyond the results themselves.
 *
 * The searched ZIP is not a property of any dentist - a search for 92618
 * legitimately returns practices in 92604 and 92630 - so it travels here rather
 * than being written onto the model.
 */
export interface ExportContext {
  /** The ZIP typed into the form, exactly as it was searched. */
  zip: string;
}

export interface ExportColumn {
  header: string;
  value: (dentist: Dentist, context: ExportContext) => ExportValue;
  /**
   * Optional columns appear only when at least one result has something to put
   * in them. The rest are the columns every provider can fill.
   */
  optional?: true;
  /**
   * Which providers can ever fill this column.
   *
   * File exports do not consult this - they look at the data. It exists for the
   * Google Sheets destination, where a tab's columns have to be fixed before
   * any search runs: a sheet whose columns shifted per append would put ratings
   * under "Email" the first time a search returned no reviews.
   */
  providers?: readonly ProviderId[];
  /**
   * Marks the PMS column. It sits last and is the only one that may be added
   * to a sheet tab whose header already exists.
   */
  group?: "pms";
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
  {
    header: "Email",
    value: (d) => d.email,
    optional: true,
    providers: ["osm"],
    width: 28,
  },
  { header: "Website", value: (d) => d.website, width: 36 },
  {
    header: "Rating",
    value: (d) => d.rating,
    optional: true,
    providers: ["google"],
    width: 8,
  },
  {
    header: "Reviews",
    value: (d) => d.reviews,
    optional: true,
    providers: ["google"],
    width: 9,
  },
  {
    header: "Open Now",
    value: (d) => formatOpenNow(d.currentOpen),
    optional: true,
    providers: ["google"],
    width: 10,
  },
  {
    header: "Business Status",
    value: (d) => d.businessStatus,
    optional: true,
    providers: ["google"],
    width: 18,
  },
  { header: "Map URL", value: (d) => d.mapUrl, width: 44 },
  /*
   * Last, because it is the same value on every row of one export - useful
   * for telling searches apart in a sheet that collects many, but not what
   * anyone reads first.
   *
   * "Search ZIP", not "ZIP": it is the ZIP that was searched, which is often
   * not the practice's own. A 92618 search returns Lake Forest 92630 among
   * others, and a column called "ZIP" beside those addresses would be read
   * as a claim about the practice.
   */
  { header: "Search ZIP", value: (_dentist, context) => context.zip, width: 11 },
  /*
   * PMS detection, after every dentist column. Last for a practical reason: an
   * existing sheet tab already has its header written, and the only change
   * that never disturbs it is adding a column to the right. Always present, so
   * a file or a sheet has the column whether or not a scan has run; a dentist
   * with no vendor found gets an empty cell.
   */
  { header: "PMS", value: (d) => d.pms, group: "pms", width: 20 },
];

/** How many columns precede the PMS group: the part of a header that is fixed. */
export function fixedColumnCount(columns: readonly ExportColumn[]): number {
  const first = columns.findIndex((column) => column.group === "pms");
  return first === -1 ? columns.length : first;
}

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
  context: ExportContext,
): readonly ExportColumn[] {
  return ALL_COLUMNS.filter((column) => {
    if (!column.optional) return true;
    return dentists.some((dentist) => hasValue(column.value(dentist, context)));
  });
}

/**
 * The fixed column set for one provider's sheet tab.
 *
 * Unlike a file export, a sheet is appended to over time, so its columns cannot
 * follow whatever a single search happened to return - the header is written
 * once and every later append has to line up under it. So this asks what a
 * provider *can* supply rather than what today's results did.
 */
export function sheetColumnsFor(provider: ProviderId): readonly ExportColumn[] {
  return ALL_COLUMNS.filter(
    (column) => !column.optional || column.providers?.includes(provider),
  );
}
