/**
 * GET /api/pms/jobs/[jobId]
 *
 * Progress and per-dentist results of a PMS scan job. Polled by the browser
 * every couple of seconds while a job runs. A job that this process does not
 * know - it finished over an hour ago, or the server restarted - is a 404,
 * which the client treats as "start again".
 */
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { getJob, snapshot } from "@/lib/pms/jobs/store";
import type { DentistSearchErrorResponse, PmsJobResponse } from "@/lib/types";

const JOB_ID = /^[0-9a-f-]{36}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;

  if (!JOB_ID.test(jobId)) {
    const body: DentistSearchErrorResponse = {
      success: false,
      error: "That job id is not valid.",
      code: "INVALID_PARAMETER",
    };
    return Response.json(body, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    logger.info("pms_job_not_found", { jobId });
    const body: DentistSearchErrorResponse = {
      success: false,
      error: "That PMS scan is no longer available. Start a new one.",
      code: "JOB_NOT_FOUND",
    };
    return Response.json(body, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const payload: PmsJobResponse = { success: true, job: snapshot(job) };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
