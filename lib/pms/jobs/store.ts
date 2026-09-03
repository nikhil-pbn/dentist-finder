/**
 * In-process job registry.
 *
 * A job is the scan of one search's dentists: created by POST /api/pms/detect,
 * advanced by the runner, read by GET /api/pms/jobs/[id]. Finished jobs are
 * kept for an hour so a browser that polls late still gets an answer. Keyed by
 * id for polling, and by the search it belongs to so a second click while a
 * scan is running is handed the running job rather than a duplicate - and so
 * the save endpoint can find the names the scan of the same search produced.
 *
 * One process, like every other in-memory structure here: a restart forgets
 * jobs, and the client treats the resulting 404 as "start again".
 *
 * Server-only.
 */
import { randomUUID } from "node:crypto";
import { PMS_JOB_TTL_MS, PMS_MAX_JOBS } from "@/lib/pms/constants";
import type { PMSJob, PMSJobItem, PmsScan } from "@/lib/pms/types";
import type { SearchQuery } from "@/lib/types";

interface StoredJob {
  job: PMSJob;
  /** The search this job scans, for idempotency. */
  key: string;
  /** When a finished job may be dropped. */
  expiresAt: number | null;
}

/*
 * Kept on globalThis so that, in development, a hot reload of a server module
 * does not replace the registry mid-scan and turn a running job into a 404.
 * In production the module is evaluated once and this is an ordinary Map.
 */
const jobs: Map<string, StoredJob> = ((globalThis as { __pmsJobs?: Map<string, StoredJob> }).__pmsJobs ??=
  new Map());

/** Forgets a job. Lanes waiting on a stopped job must not wait forever for it. */
function drop(id: string, stored: StoredJob): void {
  jobs.delete(id);
  if (stored.job.status === "PAUSED") stored.job.status = "DONE";
}

function prune(now: number): void {
  for (const [id, stored] of jobs) {
    if (stored.expiresAt !== null && stored.expiresAt <= now) drop(id, stored);
  }
  // Still too many: drop the oldest finished or stopped ones first.
  if (jobs.size > PMS_MAX_JOBS) {
    const inactive = [...jobs.entries()]
      .filter(([, stored]) => stored.job.status !== "RUNNING")
      .sort(([, a], [, b]) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
    for (const [id, stored] of inactive) {
      if (jobs.size <= PMS_MAX_JOBS) break;
      drop(id, stored);
    }
  }
}

/** The search a job belongs to. */
export function jobKeyFor(provider: string, query: SearchQuery): string {
  return [
    provider,
    query.zip,
    query.limit === null ? "all" : String(query.limit),
    String(query.radiusMeters),
    query.requireWebsite ? "web" : "any",
  ].join("|");
}

/** The job for this search that is still going, running or stopped, if any. */
export function findActiveJob(key: string): PMSJob | null {
  for (const stored of jobs.values()) {
    if (stored.key === key && stored.job.status !== "DONE") return stored.job;
  }
  return null;
}

/**
 * The scans of the newest job for this search, keyed by dentist id. Empty when
 * no scan has run (or the job has been dropped), so every PMS cell stays blank.
 */
export function latestScans(key: string): Map<string, PmsScan> {
  let newest: PMSJob | null = null;
  // Insertion order is creation order, so the last match is the newest job.
  for (const stored of jobs.values()) {
    if (stored.key === key) newest = stored.job;
  }
  const scans = new Map<string, PmsScan>();
  for (const item of newest?.items ?? []) {
    if (item.scan) scans.set(item.dentistId, item.scan);
  }
  return scans;
}

export function createJob(
  key: string,
  items: readonly Pick<PMSJobItem, "dentistId" | "website">[],
): PMSJob {
  prune(Date.now());
  const job: PMSJob = {
    id: randomUUID(),
    status: "RUNNING",
    total: items.length,
    processed: 0,
    detected: 0,
    items: items.map((item) => ({ ...item, scan: null })),
  };
  jobs.set(job.id, { job, key, expiresAt: null });
  return job;
}

export function getJob(id: string): PMSJob | null {
  return jobs.get(id)?.job ?? null;
}

function scheduleRemoval(job: PMSJob): void {
  const stored = jobs.get(job.id);
  if (stored) stored.expiresAt = Date.now() + PMS_JOB_TTL_MS;
}

/** Marks a job finished, unless it was stopped first, and schedules its removal. */
export function finishJob(job: PMSJob): void {
  if (job.status === "RUNNING") job.status = "DONE";
  scheduleRemoval(job);
}

/**
 * Holds a running job where it is. The websites being scanned at that moment
 * finish; no further one starts until `resumeJob`. The names found so far stay
 * readable for the table, the exports and "Save to spreadsheet". A job left
 * stopped is forgotten after the usual hour.
 */
export function pauseJob(job: PMSJob): void {
  if (job.status !== "RUNNING") return;
  job.status = "PAUSED";
  scheduleRemoval(job);
}

/** Lets a stopped job continue from the next unscanned website. */
export function resumeJob(job: PMSJob): void {
  if (job.status !== "PAUSED") return;
  job.status = "RUNNING";
  const stored = jobs.get(job.id);
  if (stored) stored.expiresAt = null;
}

/** A detached copy safe to serialise while the runner keeps mutating the job. */
export function snapshot(job: PMSJob): PMSJob {
  return { ...job, items: job.items.map((item) => ({ ...item })) };
}
