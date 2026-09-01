/** Desktop presentation of the results. Purely presentational. */
import type { Dentist } from "@/lib/types";
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

export default function DentistTable({ dentists }: { dentists: Dentist[] }) {
  /*
   * Shown only when the results actually carry ratings - which is to say under
   * Google, and under any future provider that supplies them. Rendering two
   * columns of dashes for every OSM search would be worse than not offering
   * them at all.
   */
  const showRatings = hasRatings(dentists);

  return (
    // The scroll container keeps a wide table from stretching the page layout.
    <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 md:block dark:border-zinc-800">
      <table
        className={`w-full border-collapse text-sm ${
          showRatings ? "min-w-[74rem]" : "min-w-[62rem]"
        }`}
      >
        <caption className="sr-only">
          Dentists found near the searched ZIP code, nearest first
        </caption>
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className={`${HEADER_CLASS} w-12`}>
              #
            </th>
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
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {dentists.map((dentist, index) => (
            <tr
              key={dentist.id}
              className="align-top transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
            >
              <td className="px-4 py-3 text-zinc-400 tabular-nums dark:text-zinc-500">
                {index + 1}
              </td>
              <td className="px-4 py-3">
                <DentistName dentist={dentist} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                {dentist.shortAddress ?? dentist.address ?? (
                  <MissingValue label="No address available" />
                )}
              </td>
              <td className="px-4 py-3">
                <PhoneValue phone={dentist.phone} />
              </td>
              <td className="px-4 py-3">
                <EmailValue email={dentist.email} />
              </td>
              <td className="px-4 py-3">
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
              <td className="px-4 py-3">
                <MapLink dentist={dentist} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
