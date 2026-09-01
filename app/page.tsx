/**
 * Home page - a Server Component that renders the shell and reads the search
 * parameters, so a shared link such as
 * `/?zip=92618&limit=20&radius=15000` arrives with the form already filled in.
 *
 * Reading `searchParams` opts this route into request-time rendering, which is
 * the right trade for a search tool: the form is in the initial HTML rather
 * than appearing after hydration.
 */
import { isSheetsConfigured } from "@/lib/config";
import DentistFinder from "@/components/DentistFinder";
import SiteFooter from "@/components/SiteFooter";
import { readSearchQuery } from "@/lib/validation";

/** Flattens Next's `searchParams` record into the shape validation expects. */
function toUrlSearchParams(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value.length > 0) params.set(key, value[0]);
  }
  return params;
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const initial = readSearchQuery(toUrlSearchParams(await searchParams));

  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <DentistFinder initial={initial} sheetsEnabled={isSheetsConfigured()} />
      </main>

      <SiteFooter />
    </div>
  );
}
