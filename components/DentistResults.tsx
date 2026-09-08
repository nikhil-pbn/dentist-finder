"use client";

/**
 * Result presentation: the summary line, the exports, the PMS scan, and the
 * two layouts.
 *
 * The file exports run entirely in the browser against results already in
 * memory. Saving to the spreadsheet and scanning for a PMS are the two actions
 * here that reach the server: the first because the credentials for it must
 * never reach the browser, the second because the crawling happens there.
 *
 * PMS names arrive progressively and are laid over the search results, so the
 * table, the cards and both file exports always show the same thing.
 */
import { useCallback, useMemo, useState } from "react";
import { DentistSearchRequestError, saveToSheet } from "@/lib/api-client";
import { buildCsvFileName, dentistsToCsv, downloadCsv } from "@/lib/csv";
import { buildXlsxFileName, dentistsToXlsx, downloadXlsx } from "@/lib/xlsx";
import type { PmsScan } from "@/lib/pms/types";
import type { DentistSearchResponse } from "@/lib/types";
import DentistCard from "@/components/DentistCard";
import DentistTable from "@/components/DentistTable";
import PmsDetectionPanel from "@/components/PmsDetectionPanel";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

/** Rows per page. Matches the smallest result limit, so a default search fits on one page. */
const PAGE_SIZE = 20;

/** First, last, the current page and its neighbours; "ellipsis" marks a gap. */
function pageItems(current: number, total: number): (number | "ellipsis")[] {
  const pages = [...new Set([1, total, current - 1, current, current + 1])]
    .filter((n) => n >= 1 && n <= total)
    .sort((a, b) => a - b);
  const items: (number | "ellipsis")[] = [];
  pages.forEach((n, i) => {
    if (i > 0 && n - pages[i - 1] > 1) items.push("ellipsis");
    items.push(n);
  });
  return items;
}

const EXPORT_BUTTON_CLASS =
  "rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900";

/** Nothing is claimed to have been saved until the server says it was. */
type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | {
      status: "saved";
      added: number;
      updated: number;
      unchanged: number;
      tab: string;
      url: string;
    }
  | { status: "error"; message: string };

export default function DentistResults({
  result,
  isStale,
  sheetsEnabled,
  onPmsRunningChange,
}: {
  result: DentistSearchResponse;
  /** True while a newer search is running, so the user knows this is the old set. */
  isStale: boolean;
  /** False when the server has no Sheets credentials; the button is then hidden. */
  sheetsEnabled: boolean;
  /** Lets the search form lock while a scan runs. */
  onPmsRunningChange: (running: boolean) => void;
}) {
  const { query, location, count, dentists: found } = result;
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [pmsScans, setPmsScans] = useState<Record<string, PmsScan>>({});
  const [pmsRunning, setPmsRunning] = useState(false);

  const handlePmsRunning = useCallback(
    (running: boolean) => {
      setPmsRunning(running);
      onPmsRunningChange(running);
    },
    [onPmsRunningChange],
  );

  const handlePmsResults = useCallback((scans: Record<string, PmsScan>) => {
    setPmsScans((current) => ({ ...current, ...scans }));
  }, []);

  /*
   * Scan results sit on top of the search results: only the name is written
   * onto the dentist, which is all the exports read.
   */
  const dentists = useMemo(
    () =>
      found.map((dentist) => {
        const scan = pmsScans[dentist.id];
        return scan ? { ...dentist, pms: scan.pms } : dentist;
      }),
    [found, pmsScans],
  );

  // Paged for reading only: the exports, the save and the PMS scan always cover
  // every result. A new search remounts this component, so the page resets.
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(dentists.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = dentists.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const firstRow = (currentPage - 1) * PAGE_SIZE + 1;
  const lastRow = firstRow + visible.length - 1;
  const goTo = (n: number): void => setPage(Math.min(Math.max(1, n), pageCount));

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
      // The query is sent, not the rows: the server re-runs the search, adds
      // the PMS names from its own scan of that search, and appends the result.
      const saved = await saveToSheet(query);
      setSave({
        status: "saved",
        added: saved.added,
        updated: saved.updated,
        unchanged: saved.unchanged,
        tab: saved.tab,
        url: saved.spreadsheetUrl,
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
              disabled={pmsRunning || save.status === "saving"}
              className={EXPORT_BUTTON_CLASS}
            >
              {save.status === "saving" ? "Saving..." : "Save to spreadsheet"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleExcelExport}
            disabled={pmsRunning}
            className={EXPORT_BUTTON_CLASS}
          >
            Export Excel
          </button>
          <button
            type="button"
            onClick={handleCsvExport}
            disabled={pmsRunning}
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
            {save.added + save.updated === 0
              ? `Already up to date: all ${save.unchanged} rows were in the `
              : `Added ${save.added}, updated ${save.updated}, unchanged ${save.unchanged} in the `}
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

      <div className="mb-4">
        <PmsDetectionPanel
          query={query}
          disabled={isStale}
          onResults={handlePmsResults}
          onRunningChange={handlePmsRunning}
        />
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {visible.map((dentist) => (
          <DentistCard
            key={dentist.id}
            dentist={dentist}
            pmsScan={pmsScans[dentist.id]}
          />
        ))}
      </ul>

      {/*
       * Only the table may grow past the page column: up to 100rem, centred on
       * the viewport, never narrower than the column. The pager travels with it.
       */}
      <div className="relative left-1/2 w-[max(100%,min(calc(100vw-4.5rem),100rem))] -translate-x-1/2">
        <DentistTable dentists={visible} pmsScans={pmsScans} />

        {pageCount > 1 ? (
          <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Showing {firstRow}&ndash;{lastRow} of {dentists.length}
            </p>
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    aria-disabled={currentPage === 1}
                    className={currentPage === 1 ? "pointer-events-none opacity-50" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      goTo(currentPage - 1);
                    }}
                  />
                </PaginationItem>
                {pageItems(currentPage, pageCount).map((item, index) =>
                  item === "ellipsis" ? (
                    <PaginationItem key={`gap-${index}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        href="#"
                        isActive={item === currentPage}
                        onClick={(event) => {
                          event.preventDefault();
                          goTo(item);
                        }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    aria-disabled={currentPage === pageCount}
                    className={currentPage === pageCount ? "pointer-events-none opacity-50" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      goTo(currentPage + 1);
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        ) : null}
      </div>
    </section>
  );
}
