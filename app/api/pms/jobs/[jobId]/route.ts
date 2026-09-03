/**
 * GET /api/pms/jobs/[jobId]
 *
 * Progress and per-dentist results of a PMS scan job. Polled by the browser
 * every couple of seconds while a job runs. A job that this process does not
 * know - it finished over an hour ago, or the server restarted - is a 404,
 * which the client treats as "start again".
 *
 * DELETE /api/pms/jobs/[jobId]
 *
 * Stops the scan. The job stays readable with the results gathered so far.
 */
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { getJob, snapshot, stopJob } from "@/lib/pms/jobs/store";
import type { PMSJob } from "@/lib/pms/types";
import type { DentistSearchErrorResponse, PmsJobResponse } from "@/lib/types";

const JOB_ID = /^[0-9a-f-]{36}$/i;

type Params = { params: Promise<{ jobId: string }> };

/** The job named in the URL, or the response that explains why there is none. */
async function resolveJob(params: Params["params"]): Promise<PMSJob | Response> {
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
  return job;
}

function jobResponse(job: PMSJob): Response {
  const payload: PmsJobResponse = { success: true, job: snapshot(job) };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: NextRequest, { params }: Params): Promise<Response> {
  const job = await resolveJob(params);
  return job instanceof Response ? job : jobResponse(job);
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<Response> {
  const job = await resolveJob(params);
  if (job instanceof Response) return job;
  stopJob(job);
  logger.info("pms_job_stopped", { jobId: job.id, processed: job.processed, total: job.total });
  return jobResponse(job);
}
