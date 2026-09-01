/**
 * Service-account access tokens for the Sheets API.
 *
 * Writing to someone's spreadsheet needs a real identity, which an API key is
 * not - so the app signs a JWT with the service account's private key and
 * exchanges it for an access token. That is the whole of Google's
 * `urn:ietf:params:oauth:grant-type:jwt-bearer` flow, and it is short enough to
 * do with `node:crypto` rather than pull in an auth library.
 *
 * Server-only. The private key never leaves this process, is never logged, and
 * never reaches the browser.
 */
import { createSign } from "node:crypto";
import {
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_TOKEN_URL,
  SHEETS_TIMEOUT_MS,
  SHEETS_TOKEN_LIFETIME_SECONDS,
  SHEETS_TOKEN_REFRESH_MARGIN_MS,
} from "@/lib/constants";
import type { SheetsConfig } from "@/lib/config";
import { AppError, ConfigurationError } from "@/lib/errors";
import { describeCause, parseJson, requestText } from "@/lib/providers/http";

const LABEL = "Google token endpoint";

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Builds and signs the assertion Google exchanges for an access token. */
export function buildAssertion(
  config: SheetsConfig,
  issuedAt: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + SHEETS_TOKEN_LIFETIME_SECONDS,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);

  let signature: string;
  try {
    signature = base64Url(signer.sign(config.privateKey));
  } catch (error) {
    // A malformed key fails here rather than as a puzzling 400 from Google.
    throw new ConfigurationError(
      `SHEETS_PRIVATE_KEY could not be used to sign: ${describeCause(error)}. Check that the whole PEM block was copied, including its BEGIN and END lines.`,
    );
  }

  return `${header}.${claims}.${signature}`;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/*
 * Tokens last an hour, so one is reused across requests rather than minted per
 * click. Keyed by client email: a configuration change mints a fresh one.
 */
const tokens = new Map<string, CachedToken>();

/** Test seam: drops cached access tokens. */
export function resetAccessTokenCache(): void {
  tokens.clear();
}

export async function getAccessToken(config: SheetsConfig): Promise<string> {
  const cached = tokens.get(config.clientEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildAssertion(config),
  });

  let payload: TokenResponse;
  try {
    const text = await requestText(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      timeoutMs: SHEETS_TIMEOUT_MS,
      label: LABEL,
    });
    payload = parseJson<TokenResponse>(text, LABEL);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ConfigurationError(
      `Could not obtain a Google access token: ${describeCause(error)}. Check SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY, and that the Google Sheets API is enabled for the project.`,
    );
  }

  if (!payload.access_token) {
    // Google's own wording says which of the several causes it is.
    const reason = payload.error_description ?? payload.error ?? "no reason given";
    throw new ConfigurationError(
      `Google refused the service-account credentials: ${reason}. Check SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY, and that the Google Sheets API is enabled for the project.`,
    );
  }

  const lifetimeMs = (payload.expires_in ?? SHEETS_TOKEN_LIFETIME_SECONDS) * 1_000;
  tokens.set(config.clientEmail, {
    token: payload.access_token,
    // Refreshed a minute early, so a token cannot expire mid-request.
    expiresAt: Date.now() + lifetimeMs - SHEETS_TOKEN_REFRESH_MARGIN_MS,
  });

  return payload.access_token;
}
