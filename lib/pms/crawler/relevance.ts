/**
 * Decides which discovered URLs are worth a request.
 *
 * The crawler never walks a whole site. Each link is scored by what it is
 * about - its text, its accessible name, the words in its path - against the
 * relevance table in `constants.ts`, and only the highest-scoring pages are
 * fetched.
 */
import { PMS_NAVIGATION_BONUS, PMS_RELEVANCE_RULES } from "@/lib/pms/constants";
import type { FormArtifact, LinkArtifact } from "@/lib/pms/crawler/extract";
import { pageKey, pathWords } from "@/lib/pms/crawler/url";

/** Highest matching rule wins; zero when nothing matches. */
function scoreText(text: string): number {
  let best = 0;
  if (!text) return best;
  for (const rule of PMS_RELEVANCE_RULES) {
    if (rule.score > best && rule.pattern.test(text)) best = rule.score;
  }
  return best;
}

/** A link's relevance from everything it says about itself. */
function scoreLink(link: LinkArtifact): number {
  const base = scoreText([link.text, link.context, pathWords(link.url)].join(" "));
  if (base > 0 && link.inNavigation) return Math.min(100, base + PMS_NAVIGATION_BONUS);
  return base;
}

/** A form's relevance from its labels, buttons, fields and destination. */
export function scoreForm(form: FormArtifact): number {
  const words = [
    form.labels.join(" "),
    form.buttons.join(" "),
    form.inputs.map((input) => `${input.name ?? ""} ${input.placeholder ?? ""}`).join(" "),
    form.text,
    form.action ? pathWords(form.action) : "",
  ].join(" ");
  return scoreText(words);
}

export interface RankedLink {
  url: string;
  /** The `pageKey` of the URL, so the same page is never fetched twice. */
  key: string;
  score: number;
}

/**
 * Collapses the links of one page onto distinct destinations, keeping the
 * highest score each earned, and orders them most relevant first. Ties break
 * on URL so the crawl order is deterministic.
 */
export function rankLinks(links: readonly LinkArtifact[]): RankedLink[] {
  const byKey = new Map<string, RankedLink>();

  for (const link of links) {
    const score = scoreLink(link);
    const key = pageKey(link.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { url: link.url, key, score });
    } else if (score > existing.score) {
      existing.score = score;
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}
