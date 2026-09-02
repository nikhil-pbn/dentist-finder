/**
 * Crawls one practice website the way a prospective patient would use it.
 *
 *   robots.txt -> homepage -> rank every link -> fetch the appointment, portal,
 *   forms, new-patient and contact pages -> follow the external destinations
 *   those journeys lead to, recording every redirect.
 *
 * Conservative by construction: a fixed page cap, a fixed request cap that
 * counts every hop, a time budget, HTML only, one retry, and no external link
 * followed unless it is part of a patient journey or embedded in the page.
 *
 * Produces URLs and page artefacts only. Matching them against the vendor list
 * is `detect.ts`'s job, so a new vendor never touches this file.
 *
 * Server-only.
 */
import {
  PMS_MAX_EXTERNAL_ROBOTS_LOOKUPS,
  PMS_MIN_CRAWL_RELEVANCE,
  PMS_MIN_PROBE_RELEVANCE,
} from "@/lib/pms/constants";
import { extractPage, type PageExtraction } from "@/lib/pms/crawler/extract";
import {
  createRequestBudget,
  fetchPage,
  type CrawlFetchContext,
  type FetchFailure,
  type FetchFailureKind,
} from "@/lib/pms/crawler/fetch";
import { rankLinks, scoreForm } from "@/lib/pms/crawler/relevance";
import { ALLOW_ALL } from "@/lib/pms/crawler/robots";
import { createRobotsRegistry } from "@/lib/pms/crawler/robots-registry";
import { createUrlSafetyChecker } from "@/lib/pms/crawler/ssrf";
import {
  alternateHostUrl,
  canonicalHost,
  hostOf,
  isIgnoredExternalHost,
  isSameSite,
  mayBeHtml,
  pageKey,
} from "@/lib/pms/crawler/url";

export interface CrawlLimits {
  maxPagesPerSite: number;
  maxRequestsPerSite: number;
  requestTimeoutMs: number;
  maxRedirects: number;
  maxHtmlBytes: number;
  maxExternalProbes: number;
  siteTimeBudgetMs: number;
}

export interface CrawlOptions {
  limits: CrawlLimits;
  userAgent: string;
  /**
   * Whether an external destination is worth a request. The detector answers
   * "no" for hosts that already name a vendor: the link is evidence enough.
   */
  shouldProbe?: (url: string) => boolean;
}

/** A page of the practice's own site that was fetched and parsed. */
export interface SitePage {
  finalUrl: string;
  extraction: PageExtraction;
}

/** An external destination a journey led to. */
export interface ProbeResult {
  url: string;
  finalUrl: string;
  /** Landing page artefacts when the destination was HTML. */
  extraction: PageExtraction | null;
}

export interface SiteCrawl {
  pages: SitePage[];
  probes: ProbeResult[];
  /** Every URL a redirect led to, from any request made. */
  redirectUrls: string[];
  /** Set when the homepage itself could not be analysed. */
  fatal: FetchFailure | null;
  /** True when the homepage looks like a JavaScript-only shell. */
  jsHeavy: boolean;
  requestsUsed: number;
}

/**
 * Homepage failures worth retrying at the other spelling of the host. A
 * robots block, an unsafe URL or an exhausted budget would say the same thing
 * again, so they are not retried.
 */
const RETRY_ALTERNATE_HOST = new Set<FetchFailureKind>([
  "TLS",
  "DNS",
  "CONNECTION",
  "HTTP_ERROR",
  "TOO_MANY_REDIRECTS",
]);

export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<SiteCrawl> {
  const deadline = Date.now() + options.limits.siteTimeBudgetMs;
  const shouldProbe = options.shouldProbe ?? (() => true);

  const budget = createRequestBudget(options.limits.maxRequestsPerSite);
  const safety = createUrlSafetyChecker();
  const startHost = hostOf(startUrl);
  let siteHost = startHost ? canonicalHost(startHost) : "";

  const baseContext: Omit<CrawlFetchContext, "robots" | "budget"> = {
    safety,
    timeoutMs: options.limits.requestTimeoutMs,
    maxRedirects: options.limits.maxRedirects,
    maxBodyBytes: options.limits.maxHtmlBytes,
    userAgent: options.userAgent,
  };

  const externalRobotsBudget = createRequestBudget(PMS_MAX_EXTERNAL_ROBOTS_LOOKUPS);
  const noRobots = { rulesFor: async () => ALLOW_ALL };
  const robots = createRobotsRegistry({
    primaryHost: siteHost,
    maxExternalLookups: PMS_MAX_EXTERNAL_ROBOTS_LOOKUPS,
    fetchRobots: (url, primary) =>
      fetchPage(
        url,
        { ...baseContext, robots: noRobots, budget: primary ? budget : externalRobotsBudget },
        { ignoreRobots: true, accept: "text" },
      ),
  });

  const ctx: CrawlFetchContext = { ...baseContext, robots, budget };

  const pages: SitePage[] = [];
  const probes: ProbeResult[] = [];
  const redirectUrls: string[] = [];
  let jsHeavy = false;

  const finish = (fatal: FetchFailure | null): SiteCrawl => ({
    pages,
    probes,
    redirectUrls,
    fatal,
    jsHeavy,
    requestsUsed: budget.used(),
  });
  const outOfTime = (): boolean => Date.now() >= deadline;

  /* Homepage --------------------------------------------------------------- */
  const planned = new Map<string, { url: string; score: number }>();
  const visited = new Set<string>([pageKey(startUrl)]);
  const probeCandidates = new Map<string, { url: string; relevance: number }>();

  let home = await fetchPage(startUrl, ctx);
  redirectUrls.push(...home.redirects);

  /*
   * A host-level failure on the homepage earns one attempt at the other
   * spelling of the host. A certificate that covers only `www`, or an apex
   * that answers 404, is common enough that giving up would report nothing for
   * sites a person can open perfectly well.
   */
  if (home.failure && RETRY_ALTERNATE_HOST.has(home.failure.kind)) {
    const alternate = alternateHostUrl(startUrl);
    if (alternate && budget.remaining() > 0) {
      const retry = await fetchPage(alternate, ctx);
      redirectUrls.push(...retry.redirects);
      if (!retry.failure) {
        home = retry;
        visited.add(pageKey(alternate));
      }
    }
  }

  if (home.failure) return finish(home.failure);
  if (home.body === null) {
    return finish({
      kind: "OTHER",
      message: `Homepage is not an HTML document (${home.contentType ?? "no content type"})`,
    });
  }

  // A site that moved to a new domain is followed there.
  const finalHost = hostOf(home.finalUrl);
  if (finalHost) siteHost = canonicalHost(finalHost);
  visited.add(pageKey(home.finalUrl));

  const addProbe = (url: string, relevance: number): void => {
    const key = pageKey(url);
    const existing = probeCandidates.get(key);
    if (!existing || relevance > existing.relevance) {
      probeCandidates.set(key, { url, relevance });
    }
  };

  const discover = (extraction: PageExtraction): void => {
    for (const link of rankLinks(extraction.links)) {
      if (!mayBeHtml(link.url)) continue;

      if (isSameSite(link.url, home.finalUrl)) {
        if (link.score < PMS_MIN_CRAWL_RELEVANCE || visited.has(link.key)) continue;
        const existing = planned.get(link.key);
        if (!existing || link.score > existing.score) {
          planned.set(link.key, { url: link.url, score: link.score });
        }
        continue;
      }

      const host = hostOf(link.url);
      if (!host || isIgnoredExternalHost(host)) continue;
      if (link.score < PMS_MIN_PROBE_RELEVANCE || !shouldProbe(link.url)) continue;
      addProbe(link.url, link.score);
    }

    for (const src of extraction.iframes) {
      if (isSameSite(src, home.finalUrl)) continue;
      const host = hostOf(src);
      if (!host || isIgnoredExternalHost(host) || !shouldProbe(src)) continue;
      // An embedded frame is part of the page itself: always worth a look.
      addProbe(src, 100);
    }

    for (const form of extraction.forms) {
      if (!form.action || isSameSite(form.action, home.finalUrl)) continue;
      const host = hostOf(form.action);
      if (!host || isIgnoredExternalHost(host)) continue;
      const score = scoreForm(form);
      if (score < PMS_MIN_PROBE_RELEVANCE || !shouldProbe(form.action)) continue;
      addProbe(form.action, score);
    }
  };

  const homeExtraction = extractPage(home.body, home.finalUrl);
  jsHeavy = homeExtraction.jsHeavy;
  pages.push({ finalUrl: home.finalUrl, extraction: homeExtraction });
  discover(homeExtraction);

  /* Relevant internal pages ------------------------------------------------ */
  while (pages.length < options.limits.maxPagesPerSite && budget.remaining() > 0 && !outOfTime()) {
    let next: { key: string; url: string; score: number } | null = null;
    for (const [key, entry] of planned) {
      if (visited.has(key)) continue;
      if (!next || entry.score > next.score || (entry.score === next.score && entry.url < next.url)) {
        next = { key, url: entry.url, score: entry.score };
      }
    }
    if (!next) break;
    visited.add(next.key);

    const result = await fetchPage(next.url, ctx);
    redirectUrls.push(...result.redirects);
    if (result.failure || result.body === null) continue;

    const extraction = extractPage(result.body, result.finalUrl);
    // A page that redirected off-site is a journey, not a page of ours.
    if (!isSameSite(result.finalUrl, home.finalUrl)) {
      probes.push({ url: next.url, finalUrl: result.finalUrl, extraction });
      continue;
    }
    visited.add(pageKey(result.finalUrl));
    pages.push({ finalUrl: result.finalUrl, extraction });
    discover(extraction);
  }

  /* External destinations -------------------------------------------------- */
  const ordered = [...probeCandidates.values()].sort(
    (a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url),
  );
  for (const candidate of ordered) {
    if (probes.length >= options.limits.maxExternalProbes || budget.remaining() === 0 || outOfTime()) break;
    const result = await fetchPage(candidate.url, ctx);
    redirectUrls.push(...result.redirects);
    probes.push({
      url: candidate.url,
      finalUrl: result.finalUrl,
      extraction: result.body !== null ? extractPage(result.body, result.finalUrl) : null,
    });
  }

  return finish(null);
}
