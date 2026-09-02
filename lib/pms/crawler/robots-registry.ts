/**
 * One robots.txt lookup per host per crawl.
 *
 * The practice's own host is looked up against the site's request budget. Hosts
 * reached through booking links and redirects get a small separate allowance,
 * so following a journey to a vendor stays polite without eating the budget
 * meant for the practice's pages.
 */
import type { CrawlFetchResult, RobotsRegistry } from "@/lib/pms/crawler/fetch";
import { ALLOW_ALL, parseRobots, type RobotsRules } from "@/lib/pms/crawler/robots";
import { canonicalHost, hostMatchesDomain, hostOf } from "@/lib/pms/crawler/url";

export interface RobotsRegistryOptions {
  /** Canonical host of the site being crawled. */
  primaryHost: string;
  /** Fetches a robots.txt URL; `primary` says whose budget it comes from. */
  fetchRobots: (url: string, primary: boolean) => Promise<CrawlFetchResult>;
  maxExternalLookups: number;
}

export function createRobotsRegistry(options: RobotsRegistryOptions): RobotsRegistry {
  const byHost = new Map<string, Promise<RobotsRules>>();
  let externalLookups = 0;

  async function lookup(host: string, protocol: string, isPrimary: boolean): Promise<RobotsRules> {
    const result = await options.fetchRobots(`${protocol}//${host}/robots.txt`, isPrimary);

    // A network fault, a budget refusal, a 4xx or a non-text body: no rules
    // can be read, which the protocol treats as "no restrictions".
    if (result.failure || result.body === null) return ALLOW_ALL;
    /*
     * A robots.txt that redirects to another site is not that site's rules -
     * some CDNs answer a missing file with a redirect to an unrelated page.
     * Better no rules than someone else's.
     */
    const finalHost = hostOf(result.finalUrl);
    if (finalHost && !hostMatchesDomain(finalHost, canonicalHost(host))) return ALLOW_ALL;
    return parseRobots(result.body);
  }

  return {
    async rulesFor(url: string): Promise<RobotsRules> {
      const host = hostOf(url);
      if (!host) return ALLOW_ALL;
      const protocol = url.startsWith("http:") ? "http:" : "https:";
      const isPrimary = canonicalHost(host) === options.primaryHost;

      let pending = byHost.get(host);
      if (!pending) {
        if (!isPrimary) {
          if (externalLookups >= options.maxExternalLookups) return ALLOW_ALL;
          externalLookups += 1;
        }
        pending = lookup(host, protocol, isPrimary);
        byHost.set(host, pending);
      }
      return pending;
    },
  };
}
