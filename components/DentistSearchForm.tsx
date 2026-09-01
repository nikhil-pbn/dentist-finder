"use client";

/**
 * The search form: ZIP, result count, radius, submit.
 *
 * Owns its own input state and its validation UI, and hands a valid
 * `SearchQuery` to its parent. It knows nothing about fetching.
 */
import { useState, type FormEvent } from "react";
import {
  ALLOWED_RADIUS_METERS,
  ALLOWED_RESULT_LIMITS,
  UNLIMITED_LIMIT_PARAM,
  type RadiusMeters,
  type ResultLimit,
  type ResultLimitOption,
} from "@/lib/constants";
import type { SearchQuery } from "@/lib/types";
import { getZipValidationError, isValidUsZip, normalizeZip } from "@/lib/validation";

const FIELD_CLASS =
  "w-full rounded-md border bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-950 dark:text-zinc-100";

const LABEL_CLASS =
  "mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300";

export default function DentistSearchForm({
  initialQuery,
  isSearching,
  onSearch,
}: {
  initialQuery: SearchQuery;
  isSearching: boolean;
  onSearch: (query: SearchQuery) => void;
}) {
  const [zip, setZip] = useState(initialQuery.zip);
  const [limit, setLimit] = useState<ResultLimitOption>(initialQuery.limit);
  const [radiusMeters, setRadiusMeters] = useState<RadiusMeters>(
    initialQuery.radiusMeters,
  );
  const [requireWebsite, setRequireWebsite] = useState(initialQuery.requireWebsite);
  const [zipError, setZipError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A duplicate submit while a search is running would double the load on the
    // public endpoints for no benefit.
    if (isSearching) return;

    const validationError = getZipValidationError(zip);
    setZipError(validationError);
    if (validationError) return;

    onSearch({ zip: normalizeZip(zip), limit, radiusMeters, requireWebsite });
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <div>
        <label htmlFor="zip" className={LABEL_CLASS}>
          ZIP code
        </label>
        <input
          id="zip"
          name="zip"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="92618"
          maxLength={10}
          value={zip}
          disabled={isSearching}
          aria-invalid={zipError ? true : undefined}
          aria-describedby={zipError ? "zip-error" : "zip-hint"}
          onChange={(event) => {
            setZip(event.target.value);
            // Clear a stale message as soon as the value becomes valid again.
            if (zipError && isValidUsZip(event.target.value)) setZipError(null);
          }}
          className={`${FIELD_CLASS} ${
            zipError
              ? "border-red-500 dark:border-red-500"
              : "border-zinc-300 dark:border-zinc-700"
          }`}
        />
        {zipError ? (
          <p
            id="zip-error"
            role="alert"
            className="mt-1.5 flex items-start gap-1 text-sm text-red-600 dark:text-red-400"
          >
            {/* An icon as well as colour: state is never signalled by hue alone. */}
            <span aria-hidden="true">&#9888;</span>
            {zipError}
          </p>
        ) : (
          <p id="zip-hint" className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
            US ZIP codes only, e.g. 92618
          </p>
        )}
      </div>

      <div>
        <label htmlFor="limit" className={LABEL_CLASS}>
          Results
        </label>
        <select
          id="limit"
          name="limit"
          value={limit === null ? UNLIMITED_LIMIT_PARAM : limit}
          disabled={isSearching}
          onChange={(event) =>
            setLimit(
              event.target.value === UNLIMITED_LIMIT_PARAM
                ? null
                : (Number(event.target.value) as ResultLimit),
            )
          }
          className={`${FIELD_CLASS} border-zinc-300 dark:border-zinc-700`}
        >
          {ALLOWED_RESULT_LIMITS.map((option) => (
            <option key={option} value={option}>
              {option} dentists
            </option>
          ))}
          {/* No cap: returns everything found inside the radius. */}
          <option value={UNLIMITED_LIMIT_PARAM}>All (no limit)</option>
        </select>
      </div>

      <div>
        <label htmlFor="radius" className={LABEL_CLASS}>
          Search radius
        </label>
        <select
          id="radius"
          name="radius"
          value={radiusMeters}
          disabled={isSearching}
          onChange={(event) =>
            setRadiusMeters(Number(event.target.value) as RadiusMeters)
          }
          className={`${FIELD_CLASS} border-zinc-300 dark:border-zinc-700`}
        >
          {ALLOWED_RADIUS_METERS.map((option) => (
            <option key={option} value={option}>
              {option / 1000} km
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-4 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between lg:col-span-3">
        {/* The filter is applied upstream in the provider query, not in the
            browser, so changing it changes what is searched for. */}
        <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            name="requireWebsite"
            checked={requireWebsite}
            disabled={isSearching}
            onChange={(event) => setRequireWebsite(event.target.checked)}
            className="size-4 rounded border-zinc-300 accent-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700"
          />
          Only show dentists that have a website
        </label>

        <button
          type="submit"
          disabled={isSearching}
          className="w-full rounded-md bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:bg-teal-700/60 sm:w-auto"
        >
          {isSearching ? "Searching..." : "Find dentists"}
        </button>
      </div>
    </form>
  );
}
