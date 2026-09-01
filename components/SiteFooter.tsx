import { getProviderIdForDisplay } from "@/lib/config";
import { PROVIDER_ATTRIBUTION } from "@/lib/providers/attribution";

export default function SiteFooter() {
  const { prefix, link, suffix } =
    PROVIDER_ATTRIBUTION[getProviderIdForDisplay()];

  return (
    <footer className="border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-5 text-zinc-500 sm:px-6 dark:text-zinc-400">
        <p>
          {prefix}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:decoration-zinc-600 dark:hover:text-zinc-200"
          >
            {link.label}
          </a>
          {suffix}
        </p>
        <p className="mt-1.5">
          Dentist Finder is an independent tool and is not affiliated with any
          practice listed. Always confirm details with the practice directly.
        </p>
      </div>
    </footer>
  );
}
