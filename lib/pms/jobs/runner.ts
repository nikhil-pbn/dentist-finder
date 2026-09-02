/**
 * Runs a scan job: every dentist, a few websites at a time.
 *
 * One bad website never stops the job - a scan that throws is recorded as
 * "no PMS" with a note, and the next one starts. Counters are updated after
 * every dentist, so a poll always sees the latest state.
 *
 * Server-only.
 */
import { logger } from "@/lib/logger";
import { PMS_MAX_CONCURRENT_SITES } from "@/lib/pms/constants";
import { detectPms } from "@/lib/pms/detect";
import { finishJob } from "@/lib/pms/jobs/store";
import type { PMSJob, PMSJobItem, PmsScan } from "@/lib/pms/types";

/** Runs `worker` over `items`, at most `limit` at a time. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(lanes);
}

async function scanOne(item: PMSJobItem): Promise<PmsScan> {
  try {
    return await detectPms(item.website);
  } catch (error) {
    // The detector is built not to throw; this is a bug, not a website problem.
    logger.error("pms_scan_crashed", {
      website: item.website,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { pms: null, matches: [], note: "Scan failed unexpectedly" };
  }
}

/** Processes every item of the job in place, then marks it finished. */
export async function runJob(job: PMSJob): Promise<void> {
  const startedAt = Date.now();
  await mapWithConcurrency(job.items, PMS_MAX_CONCURRENT_SITES, async (item) => {
    const scan = await scanOne(item);
    item.scan = scan;
    job.processed += 1;
    if (scan.pms !== null) job.detected += 1;
  });
  finishJob(job);
  logger.info("pms_job_finished", {
    jobId: job.id,
    total: job.total,
    detected: job.detected,
    durationMs: Date.now() - startedAt,
  });
}
