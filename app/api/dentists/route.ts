/**
 * GET /api/dentists?zip=92618&limit=20&radius=15000
 */
import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { AppError, RateLimitedError, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getDentistSearchProvider } from "@/lib/providers";
import { checkRateLimit } from "@/lib/rate-limit";
import type {
  DentistSearchErrorResponse,
  DentistSearchResponse,
} from "@/lib/types";
import { parseSearchQuery } from "@/lib/validation";

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function developmentDetail(error: AppError): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  if (error.code !== "CONFIGURATION_ERROR") return undefined;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const message = error.message;
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

function errorResponse(
  body: DentistSearchErrorResponse,
  status: number,
  headers?: HeadersInit,
): Response {
  return Response.json(body, { status, headers });
}

export async function GET(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  // Unknown until the configuration is read - which itself can fail, so it
  // happens inside the try block.
  let provider: string = "unconfigured";

  try {
    const budget = checkRateLimit(clientKey(request));
    if (!budget.allowed) {
      const limited = new RateLimitedError("Request budget exhausted");
      logger.warn("dentist_search_rate_limited", { code: limited.code });
      return errorResponse(
        { success: false, error: limited.publicMessage, code: limited.code },
        limited.status,
        { "Retry-After": String(budget.retryAfterSeconds) },
      );
    }

    provider = getConfig().mapProvider;
    const query = parseSearchQuery(request.nextUrl.searchParams);
    const searchProvider = getDentistSearchProvider();

    const location = await searchProvider.geocodeZip(query.zip);
    const dentists = await searchProvider.searchDentists({
      latitude: location.latitude,
      longitude: location.longitude,
      radiusMeters: query.radiusMeters,
      limit: query.limit,
      requireWebsite: query.requireWebsite,
    });

    logger.info("dentist_search", {
      provider,
      zip: query.zip,
      radiusMeters: query.radiusMeters,
      requested: query.limit,
      requireWebsite: query.requireWebsite,
      returned: dentists.length,
      durationMs: Date.now() - startedAt,
    });

    const payload: DentistSearchResponse = {
      success: true,
      query,
      location,
      count: dentists.length,
      dentists,
    };

    // Results depend on live upstream data and on the caller's own parameters;
    // caching them at the edge would only serve stale answers.
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const appError = toAppError(error);
    const level = appError.status >= 500 ? "error" : "warn";

    // The internal message and cause stay here. The client gets publicMessage.
    logger[level]("dentist_search_failed", {
      provider,
      code: appError.code,
      status: appError.status,
      zip: request.nextUrl.searchParams.get("zip")?.slice(0, 10) ?? null,
      radius: request.nextUrl.searchParams.get("radius")?.slice(0, 10) ?? null,
      limit: request.nextUrl.searchParams.get("limit")?.slice(0, 10) ?? null,
      reason: appError.message,
      durationMs: Date.now() - startedAt,
    });

    return errorResponse(
      {
        success: false,
        error: appError.publicMessage,
        code: appError.code,
        detail: developmentDetail(appError),
      },
      appError.status,
    );
  }
}
