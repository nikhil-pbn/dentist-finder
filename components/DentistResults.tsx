"use client";

/**
 * Result presentation: the summary line, the two exports, and the two layouts.
 *
 * It receives an already-fetched response - no component below the container
 * calls the API.
 */
import { buildCsvFileName, dentistsToCsv, downloadCsv } from "@/lib/csv";
import { buildXlsxFileName, dentistsToXlsx, downloadXlsx } from "@/lib/xlsx";
import type { DentistSearchResponse } from "@/lib/types";
import DentistCard from "@/components/DentistCard";
import DentistTable from "@/components/DentistTable";

const EXPORT_BUTTON_CLASS =
  "rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900";

export default function DentistResults({
  result,
  isStale,
}: {
  result: DentistSearchResponse;
  /** True while a newer search is running, so the user knows this is the old set. */
  isStale: boolean;
}) {
  const { query, location, count, dentists } = result;

  // Both exports run against the results already in memory - deliberately no
  // second API call - and share one column definition, so the two files always
  // describe the same thing.
  function handleCsvExport() {
    downloadCsv(
      buildCsvFileName(query.zip, query.radiusMeters),
      dentistsToCsv(dentists),
    );
  }

  function handleExcelExport() {
    downloadXlsx(
      buildXlsxFileName(query.zip, query.radiusMeters),
      dentistsToXlsx(dentists),
    );
  }

  return (
    <section
      aria-labelledby="results-heading"
      className={isStale ? "opacity-50 transition-opacity" : "transition-opacity"}
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="results-heading"
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {/* The real number found, never the number requested. */}
            {count} {count === 1 ? "dentist" : "dentists"} found
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            ZIP {query.zip} &middot; {query.radiusMeters / 1000} km radius &middot;
            {query.limit === null ? " no result limit" : ` up to ${query.limit} results`}
            {query.requireWebsite ? " · with a website" : ""}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            Centred on {location.displayName}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExcelExport}
            className={EXPORT_BUTTON_CLASS}
          >
            Export Excel
          </button>
          <button
            type="button"
            onClick={handleCsvExport}
            className={EXPORT_BUTTON_CLASS}
          >
            Export CSV
          </button>
        </div>
      </div>

      <DentistTable dentists={dentists} />

      <ul className="flex flex-col gap-3 md:hidden">
        {dentists.map((dentist, index) => (
          <DentistCard key={dentist.id} dentist={dentist} position={index + 1} />
        ))}
      </ul>

      {/* Kept free of provider names: the data source is named once, in the
          footer, so this component stays presentation-only. */}
      <p className="mt-4 text-xs leading-5 text-zinc-500 dark:text-zinc-500">
        These are the dentists the data source knows about within the selected
        radius &mdash; not a complete register. Some practices may be missing,
        and contact details may be incomplete or out of date.
      </p>
    </section>
  );
}
