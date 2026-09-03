/**
 * GET /api/pms/jobs/[jobId]
 *
 * Progress and per-dentist results of a PMS scan job. Polled by the browser
 * every couple of seconds while a job runs. A job that this process does not
 * know - it finished over an hour ago, or the server restarted - is a 404,
 * which the client treats as "start again".
 *
 * PATCH /api/pms/jobs/[jobId]  with  { "action": "pause" | "resume" }
 *
 * Stops the scan where it is, or lets a stopped scan continue from the next
 * unscanned website. Either way the job stays readable.
 */
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { getJob, pauseJob, resumeJob, snapshot } from "@/lib/pms/jobs/store";
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

type JobAction = "pause" | "resume";

/** The action in a PATCH body, or null unless it is `{ "action": "pause" | "resume" }`. */
async function readAction(request: NextRequest): Promise<JobAction | null> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "action" in body) {
      const action = (body as { action: unknown }).action;
      if (action === "pause" || action === "resume") return action;
    }
  } catch {
    // Not JSON: reported below as an invalid request.
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const job = await resolveJob(params);
  if (job instanceof Response) return job;

  const action = await readAction(request);
  if (!action) {
    const body: DentistSearchErrorResponse = {
      success: false,
      error: 'The action must be "pause" or "resume".',
      code: "INVALID_PARAMETER",
    };
    return Response.json(body, { status: 400 });
  }

  if (action === "pause") pauseJob(job);
  else resumeJob(job);
  logger.info(`pms_job_${action}d`, { jobId: job.id, processed: job.processed, total: job.total });
  return jobResponse(job);
}
