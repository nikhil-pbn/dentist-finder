"use client";

/**
 * Search container: owns the request lifecycle and decides which state the page
 * shows. The presentational components below it stay free of fetching logic.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DentistSearchRequestError,
  fetchDentists,
  toSearchParams,
} from "@/lib/api-client";
import type { DentistSearchResponse, SearchQuery } from "@/lib/types";
import DentistResults from "@/components/DentistResults";
import DentistSearchForm from "@/components/DentistSearchForm";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import LoadingState from "@/components/LoadingState";

export default function DentistFinder({
  initial,
  sheetsEnabled,
}: {
  /** Parsed from the page URL on the server, so a shared link works on arrival. */
  initial: { query: SearchQuery; hasValidZip: boolean };
  /**
   * Whether the server has Sheets credentials. Read on the server and passed
   * down, so no configuration - not even its presence - is fetched by the
   * browser.
   */
  sheetsEnabled: boolean;
}) {
  const [result, setResult] = useState<DentistSearchResponse | null>(null);
  const [error, setError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);
  const [pendingQuery, setPendingQuery] = useState<SearchQuery | null>(null);
  const [pmsRunning, setPmsRunning] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastQuery = useRef<SearchQuery>(initial.query);

  const runSearch = useCallback(
    async (query: SearchQuery) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastQuery.current = query;

      setPendingQuery(query);
      setError(null);

      // Keep the search shareable and survivable across a refresh. The native
      // history API updates the address bar without a navigation, so re-running
      // a search never costs a server round trip just to rewrite the URL.
      window.history.replaceState(null, "", `?${toSearchParams(query)}`);

      try {
        const response = await fetchDentists(query, controller.signal);
        if (controller.signal.aborted) return;
        setResult(response);
      } catch (caught) {
        if (controller.signal.aborted) return;
        // Showing stale results next to a failure message reads as if they were
        // the answer to the new search, so they go.
        setResult(null);
        setError(
          caught instanceof DentistSearchRequestError
            ? { message: caught.message, detail: caught.detail }
            : { message: "Something went wrong. Please try again." },
        );
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setPendingQuery(null);
        }
      }
    },
    [],
  );

  // A shared link such as /?zip=92618&limit=20&radius=15000 searches on arrival.
  const autoSearched = useRef(false);
  useEffect(() => {
    if (autoSearched.current || !initial.hasValidZip) return;
    autoSearched.current = true;
    void runSearch(initial.query);
  }, [initial, runSearch]);

  // Abort a request still running when the user navigates away.
  useEffect(() => () => inFlight.current?.abort(), []);

  const isSearching = pendingQuery !== null;

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <DentistSearchForm
          initialQuery={initial.query}
          isSearching={isSearching}
          pmsRunning={pmsRunning}
          onSearch={(query) => void runSearch(query)}
        />
      </div>

      {/* Announced politely so a screen reader hears the outcome of a search. */}
      <div aria-live="polite" aria-busy={isSearching} className="flex flex-col gap-4">
        {pendingQuery && !result ? <LoadingState zip={pendingQuery.zip} /> : null}

        {pendingQuery && result ? (
          <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
            Searching for dentists near {pendingQuery.zip}...
          </p>
        ) : null}

        {error && !isSearching ? (
          <ErrorState
            message={error.message}
            detail={error.detail}
            onRetry={() => void runSearch(lastQuery.current)}
          />
        ) : null}

        {result && result.count === 0 && !isSearching ? (
          <EmptyState
            zip={result.query.zip}
            radiusMeters={result.query.radiusMeters}
            requireWebsite={result.query.requireWebsite}
          />
        ) : null}

        {result && result.count > 0 ? (
          <DentistResults
            // Keyed by the search, so a new search starts with a clean save
            // state and no PMS results carried over from the previous one.
            key={toSearchParams(result.query).toString()}
            result={result}
            isStale={isSearching}
            sheetsEnabled={sheetsEnabled}
            onPmsRunningChange={setPmsRunning}
          />
        ) : null}
      </div>
    </div>
  );
}
