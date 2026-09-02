/**
 * One website in, a vendor name out.
 *
 *   website -> crawl the homepage and its appointment / portal / forms /
 *   new-patient / contact pages, following redirects -> collect every URL
 *   seen (links, form actions, iframes, scripts, redirect hops) -> match
 *   their hosts against `identifiers.ts` -> "Denticon", "Weave, Denticon",
 *   or null.
 *
 * Never throws for a website problem: a site that cannot be fetched comes back
 * with `pms: null` and a note saying why.
 *
 * Server-only.
 */
import { logger } from "@/lib/logger";
import { PMS_CRAWL_LIMITS, PMS_USER_AGENT } from "@/lib/pms/constants";
import { crawlSite, type SiteCrawl } from "@/lib/pms/crawler/crawl";
import type { PageExtraction } from "@/lib/pms/crawler/extract";
import type { FetchFailure } from "@/lib/pms/crawler/fetch";
import { normalizeStartUrl } from "@/lib/pms/crawler/url";
import { identifyUrl, PMS_IDENTIFIERS } from "@/lib/pms/identifiers";
import type { PmsMatch, PmsScan } from "@/lib/pms/types";

const NO_MATCH = "No supported PMS URL found";

function urlsOf(extraction: PageExtraction): string[] {
  return [
    ...extraction.links.map((link) => link.url),
    ...extraction.forms.flatMap((form) => (form.action ? [form.action] : [])),
    ...extraction.iframes,
    ...extraction.scripts,
    ...extraction.inlineScriptUrls,
  ];
}

/** Every URL the crawl saw: the pages, what was on them, and where journeys led. */
function urlsSeen(crawl: SiteCrawl): string[] {
  const urls = [...crawl.redirectUrls];
  for (const page of crawl.pages) {
    urls.push(page.finalUrl, ...urlsOf(page.extraction));
  }
  for (const probe of crawl.probes) {
    urls.push(probe.url, probe.finalUrl);
    if (probe.extraction) urls.push(...urlsOf(probe.extraction));
  }
  return urls;
}

/** The vendors these URLs name, each with the first URL that named it. */
export function matchUrls(urls: readonly string[]): PmsMatch[] {
  const matches = new Map<string, string>();
  for (const url of urls) {
    const name = identifyUrl(url);
    if (name && !matches.has(name)) matches.set(name, url);
  }
  // "Denticon, Planet DDS" says one thing twice: a family is reported only
  // when none of its products was.
  const families = new Set(
    PMS_IDENTIFIERS.filter((id) => id.family && matches.has(id.name)).map((id) => id.family),
  );
  return [...matches]
    .filter(([name]) => !families.has(name))
    .map(([name, url]) => ({ name, url }));
}

function toScan(matches: PmsMatch[], noteWhenEmpty: string): PmsScan {
  const found = matches.length > 0;
  return {
    pms: found ? matches.map((match) => match.name).join(", ") : null,
    matches,
    note: found ? null : noteWhenEmpty,
  };
}

function describe(failure: FetchFailure): string {
  switch (failure.kind) {
    case "DNS":
      return "the domain name did not resolve";
    case "TIMEOUT":
      return "the request timed out";
    case "TLS":
      return "TLS/SSL error";
    case "CONNECTION":
      return "connection failed";
    case "ROBOTS_BLOCKED":
      return "robots.txt disallows crawling";
    case "HTTP_ERROR":
      return `the homepage returned ${failure.message}`;
    case "TOO_MANY_REDIRECTS":
      return "too many redirects";
    case "UNSAFE_URL":
      return "the address is not a public website";
    default:
      return failure.message;
  }
}

export async function detectPms(website: string | null): Promise<PmsScan> {
  const startUrl = normalizeStartUrl(website);
  if (!startUrl) {
    return toScan([], website ? "Website address is not a valid URL" : "No website");
  }
  const startedAt = Date.now();

  const crawl = await crawlSite(startUrl, {
    limits: PMS_CRAWL_LIMITS,
    userAgent: PMS_USER_AGENT,
    // A link that already names a vendor needs no request of its own.
    shouldProbe: (url) => identifyUrl(url) === null,
  });

  // Even a site that could not be fetched may have redirected somewhere telling.
  const matches = matchUrls([startUrl, ...urlsSeen(crawl)]);

  let note = NO_MATCH;
  if (crawl.fatal) {
    note = `Website could not be fetched: ${describe(crawl.fatal)}`;
  } else if (crawl.jsHeavy) {
    note = `${NO_MATCH}; the site renders its links with JavaScript, which this scan cannot see`;
  }
  const scan = toScan(matches, note);

  logger.info("pms_scan", {
    website: startUrl,
    pms: scan.pms,
    failed: crawl.fatal?.kind ?? null,
    pages: crawl.pages.length,
    probes: crawl.probes.length,
    requests: crawl.requestsUsed,
    durationMs: Date.now() - startedAt,
  });
  return scan;
}
