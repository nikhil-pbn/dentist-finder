/**
 * Per-provider attribution.
 *
 * Crediting the data source is a property of the source, not of the page, so it
 * lives beside the providers. Keeping it in a `Record<ProviderId, ...>` means a
 * new provider cannot be added without declaring what it must credit - an
 * incomplete map is a build error, not a licence violation discovered later.
 *
 * Data only, with no server-only imports, so a Server Component can read it.
 */
import type { ProviderId } from "@/lib/constants";

export interface ProviderAttribution {
  /** Text before the required link. Ends with a space where one is wanted. */
  prefix: string;
  /** The credit link itself, which each licence requires by name. */
  link: { label: string; href: string };
  /** Text after the link. */
  suffix: string;
}

// "©" rather than a literal glyph, so the file stays pure ASCII on disk.
const COPYRIGHT = "©";

export const PROVIDER_ATTRIBUTION: Record<ProviderId, ProviderAttribution> = {
  /*
   * The ODbL requires the credit "Map data (c) OpenStreetMap contributors",
   * linking to the copyright page.
   */
  osm: {
    prefix: `Map data ${COPYRIGHT} `,
    link: {
      label: "OpenStreetMap contributors",
      href: "https://www.openstreetmap.org/copyright",
    },
    suffix:
      ", available under the Open Database License. Geocoding by Nominatim, search by the Overpass API.",
  },

  /*
   * Google Maps Platform requires a "Powered by Google" credit wherever Places
   * data is displayed outside a Google map - which is exactly this table.
   */
  google: {
    prefix: "Powered by ",
    link: {
      label: "Google",
      href: "https://developers.google.com/maps/documentation/places/web-service/policies",
    },
    suffix: `. Place details and ratings ${COPYRIGHT} Google, geocoding by the Google Geocoding API.`,
  },
};
