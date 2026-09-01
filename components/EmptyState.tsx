/** Zero results is a valid answer - show it instead of an empty table. */
import { MAX_RADIUS_METERS } from "@/lib/constants";

export default function EmptyState({
  zip,
  radiusMeters,
  requireWebsite,
}: {
  zip: string;
  radiusMeters: number;
  requireWebsite: boolean;
}) {
  const canWiden = radiusMeters < MAX_RADIUS_METERS;

  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950"
    >
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        No dentists found in this search radius.
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        Nothing was found within {radiusMeters / 1000} km of {zip}
        {requireWebsite ? " with a website on record" : ""}.{" "}
        {canWiden
          ? "Try increasing the search radius."
          : "That is the widest radius available - the data source may not cover this area well."}
        {/* The filter is usually the bigger constraint, so name it explicitly. */}
        {requireWebsite
          ? " You can also clear the website filter to include practices with no website listed."
          : ""}
      </p>
    </div>
  );
}
