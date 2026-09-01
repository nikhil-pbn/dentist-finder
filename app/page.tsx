/**
 * Home page - a Server Component that renders the shell and reads the search
 * parameters, so a shared link such as
 * `/?zip=92618&limit=20&radius=15000` arrives with the form already filled in.
 *
 * Reading `searchParams` opts this route into request-time rendering, which is
 * the right trade for a search tool: the form is in the initial HTML rather
 * than appearing after hydration.
 */
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
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl dark:text-zinc-50">
            Dentist Finder
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Find dentists near any US ZIP code. Enter a ZIP code, choose how many
            results you want and how far.
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <DentistFinder initial={initial} />
      </main>

      <SiteFooter />
    </div>
  );
}
