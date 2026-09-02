/**
 * Outbound URL safety: keeps the crawler on the public internet.
 *
 * The crawler fetches URLs it found on third-party websites, which is exactly
 * the input an SSRF attack needs. Every URL - the start URL, every discovered
 * page, every redirect hop - passes through `assertSafe` first, which:
 *
 *   1. accepts only http and https on the default ports;
 *   2. rejects hostnames that can only mean "this machine" or "this network";
 *   3. resolves the hostname and rejects any answer inside a loopback, private,
 *      link-local, multicast, reserved or documentation range - IPv4-mapped
 *      IPv6 included - so a public-looking name cannot point at 127.0.0.1 or
 *      at a cloud metadata endpoint.
 *
 * Known limit: the address is checked and then `fetch` resolves the name
 * again, so a resolver that flips answers between the two lookups could slip
 * through. The window is milliseconds and the cache below keeps the answer
 * stable within one crawl; closing it fully needs a custom dispatcher.
 */
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

export type UrlSafetyFailure = "UNSAFE_URL" | "DNS";

export class UrlSafetyError extends Error {
  constructor(
    readonly kind: UrlSafetyFailure,
    message: string,
  ) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

const blocked = new BlockList();

// IPv4: everything IANA lists as special-purpose, plus multicast and "future use".
const BLOCKED_IPV4: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // Carrier NAT; also Alibaba's metadata endpoint.
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // Link-local, including AWS/Azure/GCP metadata.
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/*
 * IPv6: unspecified, loopback, NAT64 translation prefixes, discard,
 * documentation, 6to4, unique-local, link-local and multicast.
 *
 * Deliberately NOT the IPv4-mapped prefix `::ffff:0:0/96`. Node's `BlockList`
 * matches a plain IPv4 address against IPv4-mapped IPv6 rules, so adding that
 * prefix here would silently block the entire public IPv4 internet. Mapped
 * addresses are handled in `isBlockedAddress` instead, by checking the IPv4
 * address they carry.
 */
const BLOCKED_IPV6: readonly [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

for (const [address, prefix] of BLOCKED_IPV4) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of BLOCKED_IPV6) blocked.addSubnet(address, prefix, "ipv6");

/** The eight hextets of an IPv6 address, or null when it cannot be read. */
function expandIpv6(address: string): number[] | null {
  const [head, tail] = address.split("::");
  const parse = (part: string): string[] =>
    part.length === 0 ? [] : part.split(":").filter((group) => group.length > 0);

  let groups: string[];
  if (tail === undefined) {
    groups = parse(head);
    if (groups.length !== 8) return null;
  } else {
    const left = parse(head);
    const right = parse(tail);
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }

  const hextets: number[] = [];
  for (const group of groups) {
    // A trailing dotted-quad, as in "::ffff:127.0.0.1".
    if (group.includes(".")) {
      const octets = group.split(".").map(Number);
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return null;
      }
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    hextets.push(value);
  }

  return hextets.length === 8 ? hextets : null;
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, or null.
 *
 * `http://[::ffff:127.0.0.1]/` reaches loopback exactly as `http://127.0.0.1/`
 * does, and `URL` rewrites it to the hex form `[::ffff:7f00:1]`, so both forms
 * have to be recognised.
 */
export function mappedIpv4(address: string): string | null {
  const hextets = expandIpv6(address);
  if (!hextets) return null;
  const isMapped =
    hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
  if (!isMapped) return null;
  return [
    hextets[6] >> 8,
    hextets[6] & 0xff,
    hextets[7] >> 8,
    hextets[7] & 0xff,
  ].join(".");
}

/** True for any address the crawler must never connect to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // Judge a mapped address by the IPv4 address it actually reaches.
    const mapped = mappedIpv4(address);
    if (mapped) return blocked.check(mapped, "ipv4");
    return blocked.check(address, "ipv6");
  }
  // Not an address at all: treat as unsafe rather than guess.
  return true;
}

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".arpa",
  ".home",
  ".lan",
  ".intranet",
  ".corp",
];

/** Names that cannot refer to a public website, whatever DNS says. */
export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return true;
  if (host === "localhost" || host === "metadata" || host === "instance-data") {
    return true;
  }
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A bare label such as "intranet" or "router" is never a public site.
  if (!host.includes(".") && isIP(host) === 0) return true;
  return false;
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** Default resolver: every address, both families, as the OS would return. */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

export interface UrlSafetyChecker {
  /**
   * Parses the URL, checks the protocol, port and hostname, resolves the host
   * and checks every address. Resolves to the parsed URL.
   * @throws UrlSafetyError with `kind: "UNSAFE_URL"` or `kind: "DNS"`.
   */
  assertSafe(url: string): Promise<URL>;
}

/**
 * Builds a checker with a per-crawl resolution cache, so the many URLs on one
 * host are resolved once and always judged by the same answer.
 */
export function createUrlSafetyChecker(
  resolve: Resolver = systemResolver,
): UrlSafetyChecker {
  const resolved = new Map<string, Promise<string[]>>();

  return {
    async assertSafe(raw: string): Promise<URL> {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new UrlSafetyError("UNSAFE_URL", `Not a valid URL: ${raw.slice(0, 120)}`);
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UrlSafetyError(
          "UNSAFE_URL",
          `Refusing non-http(s) URL: ${url.protocol}`,
        );
      }
      if (url.username || url.password) {
        throw new UrlSafetyError(
          "UNSAFE_URL",
          "Refusing URL with embedded credentials",
        );
      }
      if (url.port && url.port !== "80" && url.port !== "443") {
        throw new UrlSafetyError(
          "UNSAFE_URL",
          `Refusing non-standard port ${url.port}`,
        );
      }

      // Bracketed IPv6 literals arrive with their brackets.
      const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (isForbiddenHostname(hostname)) {
        throw new UrlSafetyError(
          "UNSAFE_URL",
          `Refusing local or internal hostname: ${hostname}`,
        );
      }

      if (isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
          throw new UrlSafetyError(
            "UNSAFE_URL",
            `Refusing non-public address: ${hostname}`,
          );
        }
        return url;
      }

      let addresses: string[];
      try {
        let pending = resolved.get(hostname);
        if (!pending) {
          pending = resolve(hostname);
          resolved.set(hostname, pending);
        }
        addresses = await pending;
      } catch (error) {
        resolved.delete(hostname);
        const code = (error as NodeJS.ErrnoException).code;
        throw new UrlSafetyError(
          "DNS",
          `DNS lookup failed for ${hostname}${code ? ` (${code})` : ""}`,
        );
      }

      if (addresses.length === 0) {
        throw new UrlSafetyError("DNS", `DNS returned no address for ${hostname}`);
      }
      const offending = addresses.find((address) => isBlockedAddress(address));
      if (offending) {
        throw new UrlSafetyError(
          "UNSAFE_URL",
          `Refusing ${hostname}: it resolves to non-public address ${offending}`,
        );
      }
      return url;
    },
  };
}
