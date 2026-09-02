/**
 * PMS detection types.
 *
 * No server-only imports, so the API routes, the job runner and the Client
 * Components can all use them. The value that reaches the spreadsheet and the
 * file exports is `Dentist.pms`, a plain `string | null`; the rest of a
 * `PmsScan` exists for the table, so a result can be checked by eye.
 */

/** One vendor named by one URL. */
export interface PmsMatch {
  name: string;
  /** The link, form, iframe, script or redirect URL that named it. */
  url: string;
}

/** What scanning one website found. */
export interface PmsScan {
  /** Vendor name, comma-separated when several were found, or null. */
  pms: string | null;
  /** For the table: which URL named each vendor. Empty when `pms` is null. */
  matches: PmsMatch[];
  /** For the table: why there is no name, e.g. the site could not be fetched. */
  note: string | null;
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export interface PMSJobItem {
  dentistId: string;
  website: string | null;
  /** Null until this dentist has been scanned. */
  scan: PmsScan | null;
}

export interface PMSJob {
  id: string;
  status: "RUNNING" | "DONE";
  total: number;
  processed: number;
  /** Dentists whose scan named at least one vendor. */
  detected: number;
  items: PMSJobItem[];
}
