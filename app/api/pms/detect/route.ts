/**
 * POST /api/pms/detect?zip=92618&limit=20&radius=15000&requireWebsite=1
 *
 * Starts a PMS scan of the dentists a search returns, and answers at once
 * with a job id the browser polls at /api/pms/jobs/[jobId]. The scan itself
 * runs after the response, in this server process, a few websites at a time.
 *
 * Like the save endpoint, it takes a *query*, not a list of websites: the
 * server re-runs the (cached) search and scans what the provider returned,
 * so this route cannot be used to point the crawler at arbitrary URLs.
 *
 * Idempotent per search: clicking twice while a scan is running returns the
 * running job rather than starting a second crawl of the same sites.
 */
import { after, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { RateLimitedError, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { runJob } from "@/lib/pms/jobs/runner";
import { createJob, findActiveJob, jobKeyFor, snapshot } from "@/lib/pms/jobs/store";
import { getDentistSearchProvider } from "@/lib/providers";
import { checkRateLimit } from "@/lib/rate-limit";
import type { DentistSearchErrorResponse, PmsDetectStartResponse } from "@/lib/types";
import { parseSearchQuery } from "@/lib/validation";

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function errorResponse(
  body: DentistSearchErrorResponse,
  status: number,
  headers?: HeadersInit,
): Response {
  return Response.json(body, { status, headers });
}

export async function POST(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  let provider: string = "unconfigured";

  try {
    const budget = checkRateLimit(clientKey(request));
    if (!budget.allowed) {
      const limited = new RateLimitedError("Request budget exhausted");
      logger.warn("pms_detect_rate_limited", { code: limited.code });
      return errorResponse(
        { success: false, error: limited.publicMessage, code: limited.code },
        limited.status,
        { "Retry-After": String(budget.retryAfterSeconds) },
      );
    }

    provider = getConfig().mapProvider;
    const query = parseSearchQuery(request.nextUrl.searchParams);
    const key = jobKeyFor(provider, query);

    const running = findActiveJob(key);
    if (running) {
      logger.info("pms_detect_reused", { jobId: running.id, zip: query.zip });
      const payload: PmsDetectStartResponse = {
        success: true,
        jobId: running.id,
        reused: true,
        job: snapshot(running),
      };
      return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    }

    const searchProvider = getDentistSearchProvider();
    const location = await searchProvider.geocodeZip(query.zip);
    const dentists = await searchProvider.searchDentists({
      latitude: location.latitude,
      longitude: location.longitude,
      radiusMeters: query.radiusMeters,
      limit: query.limit,
      requireWebsite: query.requireWebsite,
    });

    const job = createJob(
      key,
      dentists.map((dentist) => ({ dentistId: dentist.id, website: dentist.website })),
    );

    // Runs once the response has been sent. The job store keeps the state.
    after(() => runJob(job));

    logger.info("pms_detect_started", {
      provider,
      jobId: job.id,
      zip: query.zip,
      total: job.total,
      durationMs: Date.now() - startedAt,
    });

    const payload: PmsDetectStartResponse = {
      success: true,
      jobId: job.id,
      reused: false,
      job: snapshot(job),
    };
    return Response.json(payload, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const appError = toAppError(error);
    const level = appError.status >= 500 ? "error" : "warn";
    logger[level]("pms_detect_failed", {
      provider,
      code: appError.code,
      status: appError.status,
      zip: request.nextUrl.searchParams.get("zip")?.slice(0, 10) ?? null,
      reason: appError.message,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(
      { success: false, error: appError.publicMessage, code: appError.code },
      appError.status,
    );
  }
}
