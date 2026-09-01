/**
 * Centralised, validated environment configuration.
 *
 * This is the ONLY module in the application that reads `process.env`.
 * Everything else consumes the typed `getConfig()` result, which is why
 * swapping providers is a configuration change rather than a code change.
 *
 * Server-only: never import this from a Client Component.
 */
import {
  DEFAULT_NOMINATIM_BASE_URL,
  DEFAULT_OSM_USER_AGENT,
  DEFAULT_OVERPASS_URL,
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  type ProviderId,
} from "@/lib/constants";
import { ConfigurationError } from "@/lib/errors";

export interface OsmConfig {
  nominatimBaseUrl: string;
  /**
   * Overpass endpoints in preference order. Usually one; a comma-separated
   * `OVERPASS_URL` adds fallbacks that are tried when the primary cannot be
   * reached. See the README for the data-coverage caveat on public mirrors.
   */
  overpassUrls: string[];
  /** Sent as `User-Agent`; Nominatim requires an identifying value. */
  userAgent: string;
}

export interface GoogleConfig {
  /** Server-side only. Never exposed to the browser. */
  apiKey: string | null;
}

export interface AppConfig {
  mapProvider: ProviderId;
  osm: OsmConfig;
  google: GoogleConfig;
}

type Env = Record<string, string | undefined>;

function readOptional(env: Env, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateUrl(key: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${key} is not a valid URL: "${value}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigurationError(`${key} must use http or https: "${value}"`);
  }
  return value.replace(/\/+$/, "");
}

function readUrl(env: Env, key: string, fallback: string): string {
  const value = readOptional(env, key);
  return value ? validateUrl(key, value) : fallback;
}

/**
 * Reads one or more comma-separated URLs. Order is preference order: the first
 * is the primary and the rest are only tried when it cannot be reached.
 */
function readUrlList(env: Env, key: string, fallback: string): string[] {
  const value = readOptional(env, key);
  if (!value) return [fallback];

  const urls = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => validateUrl(key, entry));

  if (urls.length === 0) {
    throw new ConfigurationError(`${key} contains no usable URL: "${value}"`);
  }
  return urls;
}

function readProvider(env: Env): ProviderId {
  const raw = readOptional(env, "MAP_PROVIDER");
  if (!raw) return DEFAULT_PROVIDER_ID;
  const normalized = raw.toLowerCase();
  const match = PROVIDER_IDS.find((id) => id === normalized);
  if (!match) {
    throw new ConfigurationError(
      `Unknown MAP_PROVIDER "${raw}". Supported values: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return match;
}

/**
 * Pure loader: builds and validates configuration from an environment object.
 * Exported (rather than only the memoised `getConfig`) so tests can exercise
 * provider selection without mutating `process.env`.
 *
 * @throws ConfigurationError when the environment is invalid or incomplete.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const mapProvider = readProvider(env);
  const googleApiKey = readOptional(env, "GOOGLE_MAPS_API_KEY") ?? null;

  // Fail loudly and early rather than at the first user search.
  if (mapProvider === "google" && !googleApiKey) {
    throw new ConfigurationError(
      "Google provider selected but GOOGLE_MAPS_API_KEY is not configured.",
    );
  }

  return {
    mapProvider,
    osm: {
      nominatimBaseUrl: readUrl(
        env,
        "NOMINATIM_BASE_URL",
        DEFAULT_NOMINATIM_BASE_URL,
      ),
      overpassUrls: readUrlList(env, "OVERPASS_URL", DEFAULT_OVERPASS_URL),
      userAgent: readOptional(env, "OSM_USER_AGENT") ?? DEFAULT_OSM_USER_AGENT,
    },
    google: { apiKey: googleApiKey },
  };
}

let cachedConfig: AppConfig | null = null;

/**
 * Memoised application configuration.
 *
 * Deliberately lazy: reading the environment at module-evaluation time would
 * make a production build fail on a machine that has no `.env.local`.
 */
export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

/** Test seam: drops the memoised config so the next call re-reads the env. */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * The configured provider id, for display purposes only.
 *
 * Deliberately does not go through `getConfig()`. A missing API key must fail
 * the *search* with a clear message, not blank the whole page, so this reads
 * `MAP_PROVIDER` alone and falls back to the default rather than throwing: a
 * typo shows the default credit while `/api/dentists` reports the real problem.
 */
export function getProviderIdForDisplay(env: Env = process.env): ProviderId {
  try {
    return readProvider(env);
  } catch {
    return DEFAULT_PROVIDER_ID;
  }
}
