/**
 * Provider registry - the single place that maps configuration to an
 * implementation.
 *
 * This is the only `switch` on provider identity in the application. Callers
 * ask for `getDentistSearchProvider()` and receive something that satisfies
 * `DentistSearchProvider`; they never learn which one it is.
 */
import { getConfig, type AppConfig } from "@/lib/config";
import type { ProviderId } from "@/lib/constants";
import type { DentistSearchProvider } from "@/lib/providers/types";
import { OsmDentistSearchProvider } from "@/lib/providers/osm";
import { GoogleDentistSearchProvider } from "@/lib/providers/google";

export type { DentistSearchProvider, SearchDentistsParams } from "@/lib/providers/types";

function createProvider(config: AppConfig): DentistSearchProvider {
  switch (config.mapProvider) {
    case "osm":
      return new OsmDentistSearchProvider(config.osm);
    case "google":
      return new GoogleDentistSearchProvider(config.google);
    default: {
      // Exhaustiveness: adding a ProviderId without a case is a build error.
      const unreachable: never = config.mapProvider;
      throw new Error(`Unhandled provider: ${String(unreachable)}`);
    }
  }
}

const instances = new Map<ProviderId, DentistSearchProvider>();

/**
 * Returns the configured provider.
 *
 * Instances are memoised per provider id because they own their caches; a fresh
 * instance per request would throw away every cached ZIP and search.
 */
export function getDentistSearchProvider(
  config: AppConfig = getConfig(),
): DentistSearchProvider {
  const existing = instances.get(config.mapProvider);
  if (existing) return existing;

  const provider = createProvider(config);
  instances.set(config.mapProvider, provider);
  return provider;
}

/** Test seam: drops memoised provider instances (and therefore their caches). */
export function resetProviderRegistry(): void {
  instances.clear();
}
