/**
 * URL handling for the crawler.
 *
 * Everything that decides whether two URLs are "the same page", whether a link
 * stays on the practice's site, and whether a resource could possibly be HTML
 * lives here, so the crawler and the tests reason about URLs one way.
 */
import {
  PMS_IGNORED_EXTERNAL_HOSTS,
  PMS_SKIPPED_EXTENSIONS,
} from "@/lib/pms/constants";
import { normalizeWebsite } from "@/lib/providers/osm/normalize";

/**
 * Normalises a practice website into a crawlable start URL.
 *
 * Accepts `example.com`, `www.example.com`, `http://...` and `https://...`,
 * upgrades bare hosts to https, drops fragments and keeps any path: a Places
 * website of `https://example.com/locations/irvine` is that page, not the root.
 * Returns `null` for anything that is not an http(s) URL.
 */
export function normalizeStartUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeWebsite(raw.trim());
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The same URL at the other spelling of its host: `example.com` becomes
 * `www.example.com` and vice versa. Returns null when there is no sensible
 * alternative (an IP address, or a deeper subdomain).
 *
 * Practices are listed under whichever form their directory entry happens to
 * carry, and plenty of sites serve only one of the two - the apex may have a
 * certificate covering `www` alone, or answer 404. Trying the other spelling
 * once is what a person typing the address would end up doing.
 */
export function alternateHostUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;

    if (host.startsWith("www.")) {
      parsed.hostname = host.slice(4);
    } else {
      // Only for a bare registrable name; "book.example.com" has no www form.
      if (host.split(".").length > 2) return null;
      parsed.hostname = `www.${host}`;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Host without a leading `www.`, lower-cased. */
export function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A key under which `example.com/book`, `www.example.com/book/`,
 * `https://example.com/book#top` and `http://example.com/book?utm_source=x`
 * all collide, so the same page is never fetched twice.
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = canonicalHost(parsed.hostname);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const params = new URLSearchParams(parsed.search);
    for (const name of [...params.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(name)) params.delete(name);
    }
    params.sort();
    const query = params.toString();
    return `${host}${path}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Like `pageKey`, but keeping the host exactly as it is.
 *
 * Redirect loop detection needs this rather than `pageKey`: almost every site
 * redirects `example.com` to `www.example.com`, and under a key that collapses
 * `www.` that ordinary hop looks like a page redirecting to itself.
 */
export function redirectKey(url: string): string {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.search);
    params.sort();
    const query = params.toString();
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return url;
  }
}

/** True when both URLs sit on the same site, www and non-www being one site. */
export function isSameSite(a: string, b: string): boolean {
  const hostA = hostOf(a);
  const hostB = hostOf(b);
  if (!hostA || !hostB) return false;
  return canonicalHost(hostA) === canonicalHost(hostB);
}

/** True when `host` is `domain` itself or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Resolves an attribute value against the page it appeared on. Returns `null`
 * for anything that is not a fetchable http(s) URL: `mailto:`, `tel:`,
 * `javascript:`, `data:`, empty strings, bare fragments.
 */
export function resolveUrl(
  base: string,
  href: string | null | undefined,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|sms|javascript|data|blob|file|ftp|about|whatsapp|skype):/i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Whether the path could plausibly be an HTML page rather than a file. */
export function mayBeHtml(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    if (dot === -1) return true;
    const extension = last.slice(dot + 1).toLowerCase();
    if (extension.length === 0 || extension.length > 5) return true;
    return !PMS_SKIPPED_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

/** Social networks, map providers and the like: never PMS infrastructure. */
export function isIgnoredExternalHost(host: string): boolean {
  return PMS_IGNORED_EXTERNAL_HOSTS.some((ignored) =>
    hostMatchesDomain(host, ignored),
  );
}

/** The path and query, turned into words a relevance rule can match. */
export function pathWords(url: string): string {
  try {
    const parsed = new URL(url);
    let decoded = `${parsed.pathname} ${parsed.search}`;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Malformed escapes: match the raw path instead.
    }
    return decoded.replace(/[/\-_.?=&+%]+/g, " ").trim();
  } catch {
    return "";
  }
}
