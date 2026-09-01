/** Shown while the first search of a session is running. */
export default function LoadingState({ zip }: { zip: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-teal-600 dark:border-zinc-700 dark:border-t-teal-400"
      />
      Searching for dentists near {zip}...
    </div>
  );
}
