/**
 * The PMS cell, shared by the table and the cards: the vendor name, and under
 * it the URL that named it - or why nothing was found - so a result can be
 * checked by eye. Only the name goes to the spreadsheet and the file exports.
 */
import { MissingValue } from "@/components/DentistFields";
import type { PmsScan } from "@/lib/pms/types";

const URL_DISPLAY_MAX = 70;

function shorten(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > URL_DISPLAY_MAX ? `${bare.slice(0, URL_DISPLAY_MAX - 3)}...` : bare;
}

export function PmsValue({ scan }: { scan: PmsScan | undefined }) {
  if (!scan) return <MissingValue label="Not scanned" />;
  return (
    <div className="max-w-xs text-sm">
      {scan.pms !== null ? (
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{scan.pms}</span>
      ) : (
        <MissingValue label="No PMS found" />
      )}
      {scan.matches.map((match) => (
        <a
          key={match.name}
          href={match.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={match.url}
          className="block break-all text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-teal-700 dark:text-zinc-400 dark:decoration-zinc-600"
        >
          {scan.matches.length > 1 ? `${match.name}: ` : ""}
          {shorten(match.url)}
        </a>
      ))}
      {scan.pms === null && scan.note ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{scan.note}</p>
      ) : null}
    </div>
  );
}
