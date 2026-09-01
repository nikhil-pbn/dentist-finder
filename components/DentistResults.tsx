"use client";

/**
 * Result presentation: the summary line, the exports, and the two layouts.
 *
 * The file exports run entirely in the browser against results already in
 * memory. Saving to the spreadsheet is the one action here that reaches the
 * server, because the credentials for it must never reach the browser.
 */
import { useState } from "react";
import { DentistSearchRequestError, saveToSheet } from "@/lib/api-client";
import { buildCsvFileName, dentistsToCsv, downloadCsv } from "@/lib/csv";
import { buildXlsxFileName, dentistsToXlsx, downloadXlsx } from "@/lib/xlsx";
import type { DentistSearchResponse } from "@/lib/types";
import DentistCard from "@/components/DentistCard";
import DentistTable from "@/components/DentistTable";

const EXPORT_BUTTON_CLASS =
  "rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900";

/** Nothing is claimed to have been saved until the server says it was. */
type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; rows: number; tab: string; url: string }
  | { status: "error"; message: string };

export default function DentistResults({
  result,
  isStale,
  sheetsEnabled,
}: {
  result: DentistSearchResponse;
  /** True while a newer search is running, so the user knows this is the old set. */
  isStale: boolean;
  /** False when the server has no Sheets credentials; the button is then hidden. */
  sheetsEnabled: boolean;
}) {
  const { query, location, count, dentists } = result;
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  // Both exports run against the results already in memory - deliberately no
  // second API call - and share one column definition, so the two files always
  // describe the same thing.
  // The searched ZIP is a column in every export, so a file or a sheet holding
  // several searches still records which one each row came from.
  const exportContext = { zip: query.zip };

  function handleCsvExport() {
    downloadCsv(
      buildCsvFileName(query.zip, query.radiusMeters),
      dentistsToCsv(dentists, exportContext),
    );
  }

  function handleExcelExport() {
    downloadXlsx(
      buildXlsxFileName(query.zip, query.radiusMeters),
      dentistsToXlsx(dentists, exportContext),
    );
  }

  async function handleSheetSave() {
    setSave({ status: "saving" });
    try {
      // The query is sent, not the rows: the server re-runs the search and
      // appends what the provider actually returned.
      const appended = await saveToSheet(query);
      setSave({
        status: "saved",
        rows: appended.appendedRows,
        tab: appended.tab,
        url: appended.spreadsheetUrl,
      });
    } catch (error) {
      setSave({
        status: "error",
        message:
          error instanceof DentistSearchRequestError
            ? error.message
            : "Could not save to the spreadsheet. Please try again.",
      });
    }
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

        <div className="flex flex-wrap gap-2">
          {sheetsEnabled ? (
            <button
              type="button"
              onClick={() => void handleSheetSave()}
              disabled={save.status === "saving"}
              className={`${EXPORT_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {save.status === "saving" ? "Saving..." : "Save to spreadsheet"}
            </button>
          ) : null}
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

      {/* Announced politely, so the outcome of a save is not silent for a
          screen reader. Reports the row count the server confirmed. */}
      <div aria-live="polite" className="mb-4 empty:mb-0">
        {save.status === "saved" ? (
          <p className="text-sm text-teal-700 dark:text-teal-400">
            Added {save.rows} {save.rows === 1 ? "row" : "rows"} to the{" "}
            <span className="font-medium">{save.tab}</span> tab.{" "}
            <a
              href={save.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm underline decoration-teal-600/40 underline-offset-2 hover:decoration-teal-600"
            >
              Open the spreadsheet
            </a>
          </p>
        ) : null}
        {save.status === "error" ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {save.message}
          </p>
        ) : null}
      </div>

      <DentistTable dentists={dentists} />

      <ul className="flex flex-col gap-3 md:hidden">
        {dentists.map((dentist, index) => (
          <DentistCard key={dentist.id} dentist={dentist} position={index + 1} />
        ))}
      </ul>
    </section>
  );
}
