/**
 * The PMS cell, shared by the table and the cards: the vendor name and under it
 * the URL that named it; "No PMS" for a site that was inspected and named none;
 * a dash, with the reason, for a site that could not be inspected. Only the
 * value itself goes to the spreadsheet and the file exports.
 */
import { MissingValue } from "@/components/DentistFields";
import { PMS_NONE, type PmsScan } from "@/lib/pms/types";

const URL_DISPLAY_MAX = 70;

function shorten(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > URL_DISPLAY_MAX ? `${bare.slice(0, URL_DISPLAY_MAX - 3)}...` : bare;
}

export function PmsValue({ scan }: { scan: PmsScan | undefined }) {
  if (!scan) return <MissingValue label="Not scanned" />;
  return (
    <div className="text-sm">
      {scan.matches.length > 0 ? (
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{scan.pms}</span>
      ) : scan.pms === PMS_NONE ? (
        <span className="font-medium text-zinc-500 dark:text-zinc-400">{PMS_NONE}</span>
      ) : (
        <MissingValue label="Could not be checked" />
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
      {scan.matches.length === 0 && scan.note ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{scan.note}</p>
      ) : null}
    </div>
  );
}
