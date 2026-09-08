/** Desktop presentation of the results. Purely presentational. */
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

const HEADER_CLASS =
  "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

export default function DentistTable({
  dentists,
  pmsScans,
}: {
  dentists: Dentist[];
  /** Scan details keyed by dentist id, for the PMS column. */
  pmsScans: Record<string, PmsScan>;
}) {
  /*
   * Shown only when the results actually carry ratings - which is to say under
   * Google, and under any future provider that supplies them. Rendering two
   * columns of dashes for every OSM search would be worse than not offering
   * them at all.
   */
  const showRatings = hasRatings(dentists);
  // The PMS column appears once a scan has produced its first result.
  const showPms = Object.keys(pmsScans).length > 0;

  return (
    // The table fits the page: short columns stay on one line, long values wrap.
    // The scroll container is only a safety net for a narrow window.
    <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Dentists found near the searched ZIP code, nearest first
        </caption>
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className={HEADER_CLASS}>
              Dentist
            </th>
            <th scope="col" className={HEADER_CLASS}>
              Address
            </th>
            <th scope="col" className={HEADER_CLASS}>
              Phone
            </th>
            <th scope="col" className={HEADER_CLASS}>
              Email
            </th>
            <th scope="col" className={HEADER_CLASS}>
              Website
            </th>
            {showRatings ? (
              <>
                <th scope="col" className={HEADER_CLASS}>
                  Rating
                </th>
                <th scope="col" className={HEADER_CLASS}>
                  Reviews
                </th>
              </>
            ) : null}
            <th scope="col" className={HEADER_CLASS}>
              Map
            </th>
            {showPms ? (
              <th scope="col" className={HEADER_CLASS}>
                PMS
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {dentists.map((dentist) => (
            <tr
              key={dentist.id}
              className="align-top transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
            >
              <td className="px-4 py-3">
                <DentistName dentist={dentist} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                {dentist.shortAddress ?? dentist.address ?? (
                  <MissingValue label="No address available" />
                )}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <PhoneValue phone={dentist.phone} />
              </td>
              <td className="px-4 py-3 break-all">
                <EmailValue email={dentist.email} />
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <WebsiteLink dentist={dentist} />
              </td>
              {showRatings ? (
                <>
                  <td className="px-4 py-3">
                    <RatingValue rating={dentist.rating} />
                  </td>
                  <td className="px-4 py-3">
                    <ReviewsValue reviews={dentist.reviews} />
                  </td>
                </>
              ) : null}
              <td className="px-4 py-3 whitespace-nowrap">
                <MapLink dentist={dentist} />
              </td>
              {showPms ? (
                <td className="px-4 py-3">
                  <PmsValue scan={pmsScans[dentist.id]} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
