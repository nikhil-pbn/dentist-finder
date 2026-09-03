/**
 * Runs a scan job: every dentist, a few websites at a time.
 *
 * One bad website never stops the job. A scan that throws is recorded as
 * "no PMS" with a note, a scan that overruns its time is cut off and recorded
 * the same way, and the next website starts. Counters are updated after every
 * dentist, so a poll always sees the latest state.
 *
 * The user can stop a job at any point and resume it later: the lanes simply
 * wait while the job is paused, so it continues from the next unscanned site.
 *
 * Server-only.
 */
import { logger } from "@/lib/logger";
import { PMS_CRAWL_LIMITS, PMS_MAX_CONCURRENT_SITES } from "@/lib/pms/constants";
import { detectPms } from "@/lib/pms/detect";
import { finishJob } from "@/lib/pms/jobs/store";
import type { PMSJob, PMSJobItem, PmsScan } from "@/lib/pms/types";

/**
 * Hard ceiling for one website. The crawler checks its own time budget only
 * between requests, so a site that answers slowly on every hop can overrun it;
 * this makes sure the job moves on regardless.
 */
const SITE_HARD_LIMIT_MS = PMS_CRAWL_LIMITS.siteTimeBudgetMs + 30_000;

/** How often a lane looks whether a stopped job has been resumed. */
const PAUSE_POLL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `worker` over the job's unscanned items, at most `limit` at a time. A
 * stopped job keeps its place: the lanes wait for it to resume, and give up
 * only once the job is finished or has been forgotten.
 */
async function runLanes(
  job: PMSJob,
  limit: number,
  worker: (item: PMSJobItem) => Promise<void>,
): Promise<void> {
  const queue = job.items.filter((item) => item.scan === null);
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      while (job.status === "PAUSED") await sleep(PAUSE_POLL_MS);
      if (job.status !== "RUNNING") return;
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(lanes);
}

/** Scans one website. Always resolves: a crash or an overrun becomes a note. */
function scanOne(item: PMSJobItem): Promise<PmsScan> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn("pms_scan_timed_out", { website: item.website, limitMs: SITE_HARD_LIMIT_MS });
      resolve({ pms: null, matches: [], note: "Scan took too long and was stopped" });
    }, SITE_HARD_LIMIT_MS);

    detectPms(item.website).then(
      (scan) => {
        clearTimeout(timer);
        resolve(scan);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // The detector is built not to throw; this is a bug, not a website problem.
        logger.error("pms_scan_crashed", {
          website: item.website,
          reason: error instanceof Error ? error.message : String(error),
        });
        resolve({ pms: null, matches: [], note: "Scan failed unexpectedly" });
      },
    );
  });
}

/** Processes every item of the job in place, then marks it finished. */
export async function runJob(job: PMSJob): Promise<void> {
  const startedAt = Date.now();
  await runLanes(job, PMS_MAX_CONCURRENT_SITES, async (item) => {
    const scan = await scanOne(item);
    item.scan = scan;
    job.processed += 1;
    if (scan.pms !== null) job.detected += 1;
  });
  finishJob(job);
  logger.info("pms_job_finished", {
    jobId: job.id,
    status: job.status,
    total: job.total,
    detected: job.detected,
    durationMs: Date.now() - startedAt,
  });
}
