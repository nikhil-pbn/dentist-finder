/** Mobile presentation of a single result: a table row is unusable at 375px. */
import type { PmsScan } from "@/lib/pms/types";
import type { Dentist } from "@/lib/types";
import { PmsValue } from "@/components/PmsFields";
import {
  DentistName,
  EmailValue,
  hasRatings,
  MapLink,
  MissingValue,
  PhoneValue,
  RatingValue,
  ReviewsValue,
  WebsiteLink,
} from "@/components/DentistFields";

export default function DentistCard({
  dentist,
  pmsScan,
}: {
  dentist: Dentist;
  /** This practice's scan details, once a scan has run. */
  pmsScan: PmsScan | undefined;
}) {
  // Same rule as the desktop table: the row appears only where there is
  // something to put in it, so an OSM card never shows an empty Rating line.
  const showRating = hasRatings([dentist]);

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="text-base leading-6">
        <DentistName dentist={dentist} />
      </h3>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">Address</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">
            {dentist.shortAddress ??
              dentist.address ?? <MissingValue label="No address available" />}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">Phone</dt>
          <dd>
            <PhoneValue phone={dentist.phone} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">Email</dt>
          <dd>
            <EmailValue email={dentist.email} />
          </dd>
        </div>
        {showRating ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">Rating</dt>
            <dd className="flex gap-2 text-zinc-700 dark:text-zinc-300">
              <RatingValue rating={dentist.rating} />
              <span className="text-zinc-400 dark:text-zinc-500">
                (<ReviewsValue reviews={dentist.reviews} />)
              </span>
            </dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">Links</dt>
          <dd className="flex gap-3">
            <WebsiteLink dentist={dentist} />
            <MapLink dentist={dentist} />
          </dd>
        </div>
        {/* Shown once this practice has been scanned, whatever the outcome. */}
        {pmsScan ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">PMS</dt>
            <dd>
              <PmsValue scan={pmsScan} />
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}
