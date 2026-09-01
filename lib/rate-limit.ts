/**
 * Fixed-window, in-process request budget.
 *
 * This exists so an accidental loop in a browser tab cannot hammer the public
 * OSM endpoints through this app. It is intentionally dependency-free.
 *
 * Limitation (see README): counters live in the memory of a single server
 * process, so on a multi-instance or serverless deployment the effective limit
 * is per instance. A shared store would be required for a real quota.
 */
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "@/lib/constants";

const windows = new Map<string, { count: number; resetAt: number }>();

const MAX_TRACKED_KEYS = 5_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  maxRequests: number = RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    if (windows.size > MAX_TRACKED_KEYS) pruneExpired(now);
    return {
      allowed: true,
      remaining: maxRequests - 1,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  existing.count += 1;

  return {
    allowed: existing.count <= maxRequests,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

function pruneExpired(now: number): void {
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }
}

/** Test seam. */
export function resetRateLimits(): void {
  windows.clear();
}
