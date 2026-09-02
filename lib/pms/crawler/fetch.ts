/**
 * The crawler's HTTP layer.
 *
 * Deliberately separate from `lib/providers/http.ts`. That client is built for
 * trusted JSON APIs: it follows redirects itself, retries for up to fifty
 * seconds and returns whatever text comes back. A crawler needs the opposite
 * on every count. Each redirect hop is inspected and safety-checked before it
 * is followed and recorded; the per-site request budget, timeout and body-size
 * cap are enforced here; only HTML is downloaded; and a failing website earns
 * at most one retry.
 *
 * Server-only.
 */
import { PMS_HTML_CONTENT_TYPES } from "@/lib/pms/constants";
import { robotsPath, type RobotsRules } from "@/lib/pms/crawler/robots";
import { UrlSafetyError, type UrlSafetyChecker } from "@/lib/pms/crawler/ssrf";
import { redirectKey, resolveUrl } from "@/lib/pms/crawler/url";
import { describeCause, isUnreachable } from "@/lib/providers/http";

export type FetchFailureKind =
  | "DNS"
  | "TIMEOUT"
  | "TLS"
  | "CONNECTION"
  | "UNSAFE_URL"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "BUDGET_EXHAUSTED"
  | "ROBOTS_BLOCKED"
  | "OTHER";

export interface FetchFailure {
  kind: FetchFailureKind;
  message: string;
}

export interface CrawlFetchResult {
  /** Where the response actually came from, after redirects. */
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  /** Body text when the response was an accepted type; otherwise null. */
  body: string | null;
  /** Every URL a redirect led to, in order. Empty when there was none. */
  redirects: string[];
  failure: FetchFailure | null;
}

/** Counts requests against a per-site ceiling. */
export interface RequestBudget {
  remaining(): number;
  used(): number;
  /** Reserves one request; false when the budget is spent. */
  take(): boolean;
}

export function createRequestBudget(max: number): RequestBudget {
  let spent = 0;
  return {
    remaining: () => Math.max(0, max - spent),
    used: () => spent,
    take: () => {
      if (spent >= max) return false;
      spent += 1;
      return true;
    },
  };
}

/** Resolves the robots.txt rules that govern a URL's host. */
export interface RobotsRegistry {
  rulesFor(url: string): Promise<RobotsRules>;
}

export interface CrawlFetchContext {
  budget: RequestBudget;
  safety: UrlSafetyChecker;
  robots: RobotsRegistry;
  timeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  userAgent: string;
}

export interface FetchPageOptions {
  /** For fetching robots.txt itself, which the rules cannot govern. */
  ignoreRobots?: boolean;
  /** `html` downloads pages only; `text` also accepts `text/*` such as robots.txt. */
  accept?: "html" | "text";
}

const RETRY_DELAY_MS = 750;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function mimeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function isHtmlContentType(contentType: string | null): boolean {
  return PMS_HTML_CONTENT_TYPES.includes(mimeOf(contentType));
}

function isAccepted(contentType: string | null, accept: "html" | "text"): boolean {
  if (isHtmlContentType(contentType)) return true;
  if (accept === "text") {
    const mime = mimeOf(contentType);
    return mime.length === 0 || mime.startsWith("text/");
  }
  return false;
}

/** Sorts a thrown network error into a category the result can report. */
function classifyNetworkError(error: unknown): FetchFailure {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return { kind: "TIMEOUT", message: "Request timed out" };
  }
  const detail = describeCause(error);
  if (
    /CERT_|certificate|ERR_TLS|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|altname|EPROTO|wrong version number/i.test(
      detail,
    )
  ) {
    return { kind: "TLS", message: `TLS handshake failed: ${detail}` };
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/i.test(detail)) {
    return { kind: "DNS", message: `DNS lookup failed: ${detail}` };
  }
  if (
    isUnreachable(error) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|socket hang up|EPIPE|other side closed/i.test(
      detail,
    )
  ) {
    return { kind: "CONNECTION", message: `Connection failed: ${detail}` };
  }
  return { kind: "OTHER", message: detail };
}

function decodeBody(bytes: Buffer, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (charset && charset.toLowerCase() !== "utf-8" && charset.toLowerCase() !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8, which reads most pages fine.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Reads at most `maxBytes` of the body, cancelling the rest. */
async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  const bytes = Buffer.concat(chunks);
  return total > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the body is simply not read.
  }
}

/**
 * Fetches one URL, following redirects hop by hop.
 *
 * Never throws for a website problem: DNS failures, timeouts, TLS errors,
 * blocked robots, exhausted budgets and HTTP errors all come back as a
 * `failure` on the result, with whatever redirects had been followed.
 */
export async function fetchPage(
  url: string,
  ctx: CrawlFetchContext,
  options: FetchPageOptions = {},
): Promise<CrawlFetchResult> {
  const accept = options.accept ?? "html";

  const redirects: string[] = [];
  const visitedKeys = new Set<string>();
  let current = url;
  let retried = false;

  const fail = (
    kind: FetchFailureKind,
    message: string,
    status: number | null = null,
    contentType: string | null = null,
  ): CrawlFetchResult => ({
    finalUrl: current,
    status,
    contentType,
    body: null,
    redirects,
    failure: { kind, message },
  });

  for (let hop = 0; hop <= ctx.maxRedirects; hop += 1) {
    let safe: URL;
    try {
      safe = await ctx.safety.assertSafe(current);
    } catch (error) {
      if (error instanceof UrlSafetyError) return fail(error.kind, error.message);
      return fail("OTHER", describeCause(error));
    }
    current = safe.toString();

    if (!options.ignoreRobots) {
      const rules = await ctx.robots.rulesFor(current);
      const path = robotsPath(current);
      if (!rules.isAllowed(path)) {
        return fail("ROBOTS_BLOCKED", `robots.txt disallows ${path} on ${safe.host}`);
      }
    }

    if (!ctx.budget.take()) {
      return fail("BUDGET_EXHAUSTED", "Per-site request budget exhausted");
    }

    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: {
          "User-Agent": ctx.userAgent,
          Accept:
            accept === "html"
              ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
              : "text/plain,text/html;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    } catch (error) {
      const failure = classifyNetworkError(error);
      const retryable = failure.kind === "TIMEOUT" || failure.kind === "CONNECTION";
      if (retryable && !retried && ctx.budget.remaining() > 0) {
        retried = true;
        await sleep(RETRY_DELAY_MS);
        hop -= 1;
        continue;
      }
      return fail(failure.kind, failure.message);
    }

    const status = response.status;
    const contentType = response.headers.get("content-type");

    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      await discard(response);
      if (!location) {
        return fail("HTTP_ERROR", `HTTP ${status} without a Location header`, status);
      }
      const next = resolveUrl(current, location);
      if (!next) {
        return fail(
          "OTHER",
          `Redirected to an unsupported destination: ${location.slice(0, 120)}`,
          status,
        );
      }
      // Compared with the host intact, so the usual apex-to-www hop is not
      // mistaken for a cycle.
      const key = redirectKey(next);
      if (visitedKeys.has(key) || key === redirectKey(current)) {
        redirects.push(next);
        current = next;
        return fail("TOO_MANY_REDIRECTS", "Redirect loop detected", status);
      }
      visitedKeys.add(redirectKey(current));
      redirects.push(next);
      current = next;
      continue;
    }

    if (status >= 500 && !retried && ctx.budget.remaining() > 0) {
      await discard(response);
      retried = true;
      await sleep(RETRY_DELAY_MS);
      hop -= 1;
      continue;
    }

    if (status >= 400) {
      await discard(response);
      return fail("HTTP_ERROR", `HTTP ${status}`, status, contentType);
    }

    if (!isAccepted(contentType, accept)) {
      await discard(response);
      return { finalUrl: current, status, contentType, body: null, redirects, failure: null };
    }

    try {
      const bytes = await readBody(response, ctx.maxBodyBytes);
      return {
        finalUrl: current,
        status,
        contentType,
        body: decodeBody(bytes, contentType),
        redirects,
        failure: null,
      };
    } catch (error) {
      const failure = classifyNetworkError(error);
      return fail(failure.kind, `Reading the body failed: ${failure.message}`, status, contentType);
    }
  }

  return fail("TOO_MANY_REDIRECTS", `More than ${ctx.maxRedirects} redirects`);
}
