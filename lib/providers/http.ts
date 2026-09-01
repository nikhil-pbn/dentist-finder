/**
 * Shared outbound HTTP for providers. Server-side only.
 *
 * Guarantees every provider inherits the same properties:
 *   - a per-attempt timeout, so a hanging endpoint cannot hang a request;
 *   - a wall-clock budget for the whole operation, so retrying can never leave
 *     a user waiting for minutes;
 *   - limited, jittered, backed-off retries on genuinely temporary failures;
 *   - errors that name the real underlying cause for the server log, while the
 *     user still only ever sees a safe message.
 */
import {
  PROVIDER_MAX_ATTEMPTS,
  PROVIDER_MAX_ATTEMPTS_AFTER_429,
  PROVIDER_MAX_RETRY_DELAY_MS,
  PROVIDER_MIN_ATTEMPT_MS,
  PROVIDER_RETRY_BASE_DELAY_MS,
  PROVIDER_TOTAL_BUDGET_MS,
} from "@/lib/constants";
import { ProviderTimeoutError } from "@/lib/errors";

export interface HttpRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Timeout for a single attempt. Also capped by the remaining budget. */
  timeoutMs: number;
  /** Human readable name of the upstream, used in log messages only. */
  label: string;
}

/** Non-2xx response from an upstream. Providers map this to a domain error. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly bodySnippet: string,
    label: string,
  ) {
    super(`${label} responded with HTTP ${status}: ${bodySnippet}`);
    this.name = "HttpStatusError";
  }
}

/** Temporary by nature: worth retrying, never storming. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const MAX_HONOURED_RETRY_AFTER_MS = 5_000;
const BODY_SNIPPET_LENGTH = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Unwraps an error chain into one readable line.
 *
 * `fetch` rejects with a bare "fetch failed" and hides the interesting part -
 * the connect timeout, DNS failure or socket reset - in `cause`. Without this,
 * a production log says only "fetch failed", which is not enough to tell an
 * overloaded endpoint apart from a broken network.
 */
export function describeCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  // Bounded: a malformed cause chain must not loop forever.
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(`${current.name}: ${current.message}${code ? ` (${code})` : ""}`);
    current = current.cause;
  }

  if (parts.length === 0) return String(error);
  return parts.join(" <- ");
}

/** Honours `Retry-After` only when it asks for a short, sensible wait. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_HONOURED_RETRY_AFTER_MS);
}

/**
 * Exponential backoff with jitter. The jitter matters because several requests
 * can fail at the same moment; without it they would all retry in lockstep and
 * hit the struggling endpoint together.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    PROVIDER_MAX_RETRY_DELAY_MS,
  );
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * Performs a request and returns the response body as text.
 *
 * Retries temporary failures - connection errors and 5xx - up to
 * `PROVIDER_MAX_ATTEMPTS`, within `PROVIDER_TOTAL_BUDGET_MS` overall. A
 * per-attempt timeout is *not* retried on its own account beyond that budget:
 * re-asking a struggling public endpoint the same expensive question makes
 * things worse for everyone using it.
 *
 * @throws ProviderTimeoutError when the budget is exhausted by timeouts.
 * @throws HttpStatusError on a non-retryable or final non-2xx response.
 */
export async function requestText(
  target: string | readonly string[],
  options: HttpRequestOptions,
): Promise<string> {
  const { method = "GET", headers, body, timeoutMs, label } = options;
  const endpoints = typeof target === "string" ? [target] : [...target];
  if (endpoints.length === 0) {
    throw new Error(`${label} has no configured endpoint`);
  }

  const deadline = Date.now() + PROVIDER_TOTAL_BUDGET_MS;

  let maxAttempts = Math.max(PROVIDER_MAX_ATTEMPTS, endpoints.length);
  let lastError: unknown;
  let attempt = 0;
  // Rotates only on failure, so a healthy primary is always preferred.
  let endpointIndex = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining < PROVIDER_MIN_ATTEMPT_MS) break;

    const url = endpoints[endpointIndex];
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        cache: "no-store",
        // Never let one attempt eat the whole budget.
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
      });
    } catch (error) {
      lastError = error;
      // The host is unreachable, so retrying *it* is pointless - move to the
      // next configured endpoint if there is one.
      endpointIndex = (endpointIndex + 1) % endpoints.length;

      // A timeout has already consumed a large slice of the budget, so it only
      // gets another go if there is real time left for one.
      const worthRetrying =
        attempt < maxAttempts &&
        deadline - Date.now() > PROVIDER_MIN_ATTEMPT_MS + backoffMs(attempt);
      if (!worthRetrying) break;

      // Switching to a different, healthy endpoint need not wait.
      if (endpoints.length === 1) await delay(backoffMs(attempt));
      continue;
    }

    if (response.ok) return response.text();

    const snippet = (await response.text().catch(() => ""))
      .slice(0, BODY_SNIPPET_LENGTH)
      .replace(/\s+/g, " ")
      .trim();
    const statusError = new HttpStatusError(response.status, snippet, label);
    lastError = statusError;

    if (!RETRYABLE_STATUSES.has(response.status)) throw statusError;

    // A struggling endpoint gets the next request sent elsewhere too.
    endpointIndex = (endpointIndex + 1) % endpoints.length;

    // "You are over quota" is not the same as "I am briefly unwell": obey it
    // rather than trying repeatedly.
    if (response.status === 429) {
      maxAttempts = Math.min(maxAttempts, PROVIDER_MAX_ATTEMPTS_AFTER_429);
    }

    const wait = retryAfterMs(response) ?? backoffMs(attempt);
    if (
      attempt >= maxAttempts ||
      deadline - Date.now() < PROVIDER_MIN_ATTEMPT_MS + wait
    ) {
      throw statusError;
    }
    await delay(wait);
  }

  // Out of attempts or out of budget. Surface the real cause for the log.
  if (isTimeout(lastError)) {
    throw new ProviderTimeoutError(
      `${label} timed out after ${attempt} attempt(s): ${describeCause(lastError)}`,
      { cause: lastError },
    );
  }
  if (lastError instanceof HttpStatusError) throw lastError;
  const tried = endpoints.map((endpoint) => new URL(endpoint).host).join(", ");
  throw new Error(
    `${label} request failed after ${attempt} attempt(s) against ${tried}: ${describeCause(lastError)}`,
    { cause: lastError },
  );
}

/** Parses JSON, turning a malformed body into a descriptive Error. */
export function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const snippet = text.slice(0, BODY_SNIPPET_LENGTH).replace(/\s+/g, " ");
    throw new Error(`${label} returned malformed JSON: ${snippet}`, {
      cause: error,
    });
  }
}
