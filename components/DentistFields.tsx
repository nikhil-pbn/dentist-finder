/**
 * The small pieces of dentist presentation shared by the table and the cards.
 *
 * Centralised so a missing value looks identical everywhere, and so the two
 * layouts can never drift apart in how they render a link or a phone number.
 */
import type { Dentist } from "@/lib/types";

/** Shown wherever the source has no value. Never a fabricated placeholder. */
export function MissingValue({ label = "Not available" }: { label?: string }) {
  return (
    <span className="text-zinc-400 dark:text-zinc-500" title={label}>
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Whether any result in this set carries a rating, which decides whether the
 * ratings columns appear at all.
 *
 * Driven by the data, never by `dentist.source`: OSM supplies no ratings and
 * would show two columns of dashes, Google supplies them. A future provider
 * gets the columns the moment it populates the fields, and nothing here has to
 * learn which provider is configured.
 */
export function hasRatings(dentists: readonly Dentist[]): boolean {
  return dentists.some(
    (dentist) => dentist.rating !== null || dentist.reviews !== null,
  );
}

/** Google reports one decimal place; this never invents precision. */
export function RatingValue({ rating }: { rating: number | null }) {
  if (rating === null) return <MissingValue label="No rating available" />;
  return (
    <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
      {rating.toFixed(1)}
      <span className="sr-only"> out of 5</span>
    </span>
  );
}

export function ReviewsValue({ reviews }: { reviews: number | null }) {
  if (reviews === null) {
    return <MissingValue label="No review count available" />;
  }
  return (
    <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
      {reviews.toLocaleString("en-US")}
      <span className="sr-only">
        {reviews === 1 ? " review" : " reviews"}
      </span>
    </span>
  );
}

export function PhoneValue({ phone }: { phone: string | null }) {
  if (!phone) return <MissingValue label="No phone number available" />;
  return (
    <a
      href={`tel:${phone.replace(/[^+\d]/g, "")}`}
      className="rounded-sm text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-teal-700 hover:decoration-teal-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-zinc-300 dark:decoration-zinc-600 dark:hover:text-teal-400"
    >
      {phone}
    </a>
  );
}

export function WebsiteLink({ dentist }: { dentist: Dentist }) {
  if (!dentist.website) return <MissingValue label="No website available" />;
  return (
    <a
      href={dentist.website}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm font-medium text-teal-700 underline decoration-teal-600/40 underline-offset-2 hover:decoration-teal-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-teal-400 dark:decoration-teal-400/40"
    >
      Website
      <span className="sr-only">
        {dentist.name ? ` for ${dentist.name}` : ""} (opens in a new tab)
      </span>
    </a>
  );
}

/**
 * The URL comes from the provider, so this component never has to know whether
 * the result came from OpenStreetMap, Google, or anything else.
 */
export function MapLink({ dentist }: { dentist: Dentist }) {
  if (!dentist.mapUrl) return <MissingValue label="No map link available" />;
  return (
    <a
      href={dentist.mapUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm font-medium text-teal-700 underline decoration-teal-600/40 underline-offset-2 hover:decoration-teal-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-teal-400 dark:decoration-teal-400/40"
    >
      Map
      <span className="sr-only">
        {dentist.name ? ` for ${dentist.name}` : ""} (opens in a new tab)
      </span>
    </a>
  );
}

export function EmailValue({ email }: { email: string | null }) {
  if (!email) return <MissingValue label="No email address available" />;
  return (
    <a
      href={`mailto:${email}`}
      className="rounded-sm break-all text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-teal-700 hover:decoration-teal-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-zinc-300 dark:decoration-zinc-600 dark:hover:text-teal-400"
    >
      {email}
    </a>
  );
}

export function DentistName({ dentist }: { dentist: Dentist }) {
  if (!dentist.name) {
    return (
      <span className="italic text-zinc-500 dark:text-zinc-400">
        Unnamed dental practice
      </span>
    );
  }
  return <span className="font-medium text-zinc-900 dark:text-zinc-100">{dentist.name}</span>;
}
