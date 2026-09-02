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

/**
 * Credentials for appending results to a Google Sheet.
 *
 * Optional: the app runs, searches and exports files without any of it. Only
 * the "Save to sheet" button needs it, and that button is hidden when it is
 * absent rather than failing when pressed.
 */
export interface SheetsConfig {
  /** The spreadsheet's Drive file id, from its URL. */
  spreadsheetId: string;
  /** Service-account address; the sheet must be shared with it as an editor. */
  clientEmail: string;
  /** PEM private key. Server-side only, and never logged. */
  privateKey: string;
}

export interface AppConfig {
  mapProvider: ProviderId;
  osm: OsmConfig;
  google: GoogleConfig;
  /** `null` when the integration is not configured, which is the default. */
  sheets: SheetsConfig | null;
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
    sheets: readSheetsConfig(env),
  };
}

/**
 * Reads the Sheets credentials, or `null` when the integration is switched off.
 *
 * All three values are required together: a half-configured integration would
 * fail at the first click rather than at startup, so a partial set is treated
 * as a configuration error rather than quietly ignored.
 */
function readSheetsConfig(env: Env): SheetsConfig | null {
  const spreadsheetId = readOptional(env, "SHEETS_SPREADSHEET_ID");
  const clientEmail = readOptional(env, "SHEETS_CLIENT_EMAIL");
  const rawKey = readOptional(env, "SHEETS_PRIVATE_KEY");

  const present = [spreadsheetId, clientEmail, rawKey].filter(Boolean).length;
  if (present === 0) return null;
  if (present < 3) {
    throw new ConfigurationError(
      "Google Sheets integration is partly configured. SHEETS_SPREADSHEET_ID, SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY are all required, or all omitted.",
    );
  }

  /*
   * A PEM key cannot survive a single-line .env value, so it is stored with
   * escaped newlines and restored here. Both forms are accepted, since a
   * secret manager may inject the real thing.
   */
  const privateKey = (rawKey as string).replace(/\\n/g, "\n");
  if (!privateKey.includes("BEGIN")) {
    throw new ConfigurationError(
      "SHEETS_PRIVATE_KEY does not look like a PEM private key. Copy the private_key field from the service-account JSON, newlines and all.",
    );
  }

  return {
    spreadsheetId: spreadsheetId as string,
    clientEmail: clientEmail as string,
    privateKey,
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

/**
 * Whether the Google Sheets destination is configured.
 *
 * Never throws: this decides whether a button is rendered, and a page must not
 * fail to render because a secret is missing.
 */
export function isSheetsConfigured(env: Env = process.env): boolean {
  try {
    return readSheetsConfig(env) !== null;
  } catch {
    // Partly configured. The button stays hidden; the log carries the reason.
    return false;
  }
}
