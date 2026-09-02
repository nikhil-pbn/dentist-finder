/**
 * robots.txt: fetched once per host, consulted before every request.
 *
 * Implements the parts of the Robots Exclusion Protocol (RFC 9309) that decide
 * access: user-agent groups, Allow and Disallow with `*` and `$`, longest
 * match wins, Allow wins a tie. Anything else in the file is ignored.
 *
 * A missing or unreadable file means "no restrictions".
 */
import { PMS_ROBOTS_TOKEN } from "@/lib/pms/constants";

interface RobotsRule {
  allow: boolean;
  pattern: RegExp;
  /** Length of the original path pattern, which decides precedence. */
  specificity: number;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  /** Whether a path may be fetched under these rules. */
  isAllowed(pathAndQuery: string): boolean;
}

export const ALLOW_ALL: RobotsRules = { isAllowed: () => true };

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function toRegExp(pathPattern: string): RegExp {
  let source = "";
  for (const char of pathPattern) {
    if (char === "*") source += ".*";
    else if (char === "$") source += "$";
    else source += char.replace(REGEXP_SPECIALS, "\\$&");
  }
  return new RegExp(`^${source}`);
}

/**
 * Parses a robots.txt body into rules for the given product token.
 *
 * The most specific matching group wins: one that names our token, then the
 * `*` group. A file with neither allows everything.
 */
export function parseRobots(body: string, token: string = PMS_ROBOTS_TOKEN): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True while the last line was a user-agent line, so several agents can
  // share one group.
  let collectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }

    collectingAgents = false;
    if (!current) continue;
    if (directive !== "allow" && directive !== "disallow") continue;

    // An empty Disallow means "nothing is disallowed"; an empty Allow says nothing.
    if (value.length === 0) continue;
    current.rules.push({
      allow: directive === "allow",
      pattern: toRegExp(value),
      specificity: value.length,
    });
  }

  const lowerToken = token.toLowerCase();
  const own = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && agent.length > 0 && lowerToken.includes(agent)),
  );
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const selected = own.length > 0 ? own : wildcard;
  const rules = selected.flatMap((group) => group.rules);

  return {
    isAllowed(pathAndQuery: string): boolean {
      let best: RobotsRule | null = null;
      for (const rule of rules) {
        if (!rule.pattern.test(pathAndQuery)) continue;
        if (
          !best ||
          rule.specificity > best.specificity ||
          (rule.specificity === best.specificity && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

/** Path plus query, which is what the rules are matched against. */
export function robotsPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
