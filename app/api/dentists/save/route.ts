/**
 * POST /api/dentists/save?zip=92618&limit=20&radius=15000&requireWebsite=1
 *
 * Saves the results of that search into the configured Google Sheet, in the tab
 * named for the active provider: new practices are appended, ones already
 * there are updated where something changed, and the rest are left alone.
 *
 * It takes a *query*, not a list of rows. The browser could otherwise ask this
 * endpoint to write anything at all into someone's spreadsheet; instead the
 * server re-runs the search and appends what the provider actually returned.
 * The search is cached, so re-running it costs nothing and, under Google, is
 * not billed twice.
 */
import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { AppError, ConfigurationError, RateLimitedError, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { jobKeyFor, latestScans } from "@/lib/pms/jobs/store";
import { getDentistSearchProvider } from "@/lib/providers";
import { checkRateLimit } from "@/lib/rate-limit";
import { ensureSheetReady, saveRows } from "@/lib/sheets/client";
import { diagnoseSheets } from "@/lib/sheets/diagnose";
import type { DentistSearchErrorResponse, SheetSaveResponse } from "@/lib/types";
import { parseSearchQuery } from "@/lib/validation";

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Configuration errors are shown in development only, and never carry a
 * credential: the Sheets errors quote Google's wording and the spreadsheet id,
 * neither of which is secret, but the key is scrubbed regardless.
 */
function developmentDetail(error: AppError): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  if (error.code !== "CONFIGURATION_ERROR") return undefined;

  const secrets = [
    process.env.SHEETS_PRIVATE_KEY?.trim(),
    process.env.GOOGLE_MAPS_API_KEY?.trim(),
  ].filter((secret): secret is string => Boolean(secret));

  return secrets.reduce(
    (message, secret) => message.split(secret).join("[redacted]"),
    error.message,
  );
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
      logger.warn("sheet_save_rate_limited", { code: limited.code });
      return errorResponse(
        { success: false, error: limited.publicMessage, code: limited.code },
        limited.status,
        { "Retry-After": String(budget.retryAfterSeconds) },
      );
    }

    const config = getConfig();
    provider = config.mapProvider;

    if (!config.sheets) {
      throw new ConfigurationError(
        "Google Sheets integration is not configured. Set SHEETS_SPREADSHEET_ID, SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY.",
        "Saving to a spreadsheet is not configured on this server.",
      );
    }

    const query = parseSearchQuery(request.nextUrl.searchParams);

    /*
     * The spreadsheet is checked first, on purpose. An unwritable one - the
     * wrong id, not shared with the service account, or an uploaded .xlsx -
     * then fails in about a second instead of after a full search whose results
     * are thrown away, and without spending Overpass goodwill or Places quota
     * to learn something the first API call already knew.
     */
    const target = await ensureSheetReady(config.sheets, config.mapProvider);

    const searchProvider = getDentistSearchProvider();
    const location = await searchProvider.geocodeZip(query.zip);
    const dentists = await searchProvider.searchDentists({
      latitude: location.latitude,
      longitude: location.longitude,
      radiusMeters: query.radiusMeters,
      limit: query.limit,
      requireWebsite: query.requireWebsite,
    });

    /*
     * The PMS names come from this server's own scan of the same search, never
     * from the browser: the same rule as the rows themselves. A dentist that
     * was not scanned gets an empty cell.
     */
    const scans = latestScans(jobKeyFor(config.mapProvider, query));
    const withPms = dentists.map((dentist) => {
      const scan = scans.get(dentist.id);
      return scan ? { ...dentist, pms: scan.pms } : dentist;
    });

    // The searched ZIP rides along as its own column, so a sheet collecting
    // many searches records which one each row came from. Rows are matched on
    // Map URL: new practices are appended, changed ones updated, the rest kept.
    const saved = await saveRows(config.sheets, target, withPms, {
      zip: query.zip,
    });

    logger.info("sheet_save", {
      provider,
      zip: query.zip,
      tab: target.tab,
      ...saved,
      pmsRows: withPms.filter((dentist) => dentist.pms !== null).length,
      // Which of the two write paths ran, since they fail in different ways.
      mode: target.mode,
      createdTab: target.createdTab,
      wroteHeader: target.wroteHeader,
      durationMs: Date.now() - startedAt,
    });

    const payload: SheetSaveResponse = {
      success: true,
      tab: target.tab,
      ...saved,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${config.sheets.spreadsheetId}/edit`,
    };

    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const appError = toAppError(error);
    const level = appError.status >= 500 ? "error" : "warn";

    logger[level]("sheet_save_failed", {
      provider,
      code: appError.code,
      status: appError.status,
      zip: request.nextUrl.searchParams.get("zip")?.slice(0, 10) ?? null,
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

/**
 * GET /api/dentists/save - setup diagnosis, development only.
 *
 * Four things have to line up before a save works, and a wrong one surfaces as
 * one opaque HTTP error. Visiting this in a browser walks them in order and
 * names the first that fails, with the fix.
 *
 * Not available in production: it reports on configuration.
 */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return Response.json(
      { success: false, error: "Not found", code: "NOT_FOUND" },
      { status: 404 },
    );
  }

  const diagnosis = await diagnoseSheets();
  logger.info("sheet_save_diagnosed", {
    ok: diagnosis.ok,
    failedAt: diagnosis.steps.find((step) => !step.ok)?.step ?? null,
  });

  return Response.json(diagnosis, {
    status: diagnosis.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
