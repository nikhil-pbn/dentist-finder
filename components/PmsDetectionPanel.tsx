"use client";

/**
 * The "Detect PMS" button, its Stop and Resume controls, and the progress line.
 *
 * Starts (or joins) a scan for the current search, polls it every couple of
 * seconds and hands each result up to the results view as it arrives. The
 * scan runs on the server; this component never touches a practice's website.
 *
 * Stop holds the scan at the website it has reached; Resume lets it continue
 * from the next one. While stopped, the names found so far can be saved and
 * exported.
 *
 * Polling is patient: a failed poll is retried, not treated as the end, so a
 * blip between browser and server never abandons a scan that is still running.
 * If the server has forgotten the job (it restarted), the scan is started once
 * more rather than left half done.
 */
import { CircleCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DentistSearchRequestError,
  fetchPmsJob,
  pausePmsJob,
  resumePmsJob,
  startPmsDetection,
} from "@/lib/api-client";
import type { PMSJob, PmsScan } from "@/lib/pms/types";
import type { SearchQuery } from "@/lib/types";

const POLL_INTERVAL_MS = 2_000;
/** Consecutive failed polls tolerated before giving up: about twenty seconds of silence. */
const MAX_POLL_FAILURES = 10;

const PRIMARY_BUTTON_CLASS =
  "rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:bg-teal-700/60";

const SECONDARY_BUTTON_CLASS =
  "rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900";

type PanelState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "running"; job: PMSJob }
  | { status: "paused"; job: PMSJob }
  | { status: "finished"; job: PMSJob }
  | { status: "error"; message: string; job: PMSJob | null };

function stateFor(job: PMSJob): PanelState {
  switch (job.status) {
    case "RUNNING":
      return { status: "running", job };
    case "PAUSED":
      return { status: "paused", job };
    default:
      return { status: "finished", job };
  }
}

function scansOf(job: PMSJob): Record<string, PmsScan> {
  const scans: Record<string, PmsScan> = {};
  for (const item of job.items) {
    if (item.scan) scans[item.dentistId] = item.scan;
  }
  return scans;
}

/** Waits, but returns at once when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export default function PmsDetectionPanel({
  query,
  disabled = false,
  onResults,
  onRunningChange,
}: {
  query: SearchQuery;
  /** True while a new search runs: scanning results about to be replaced helps nobody. */
  disabled?: boolean;
  /** Called with every scan seen so far, keyed by dentist id. */
  onResults: (scans: Record<string, PmsScan>) => void;
  onRunningChange: (running: boolean) => void;
}) {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  /** A Stop or Resume request is on its way to the server. */
  const [switching, setSwitching] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);

  // Callbacks live in a ref so a parent re-render never disturbs a running poll.
  const callbacks = useRef({ onResults, onRunningChange });
  useEffect(() => {
    callbacks.current = { onResults, onRunningChange };
  }, [onResults, onRunningChange]);

  const running = state.status === "starting" || state.status === "running";
  useEffect(() => {
    callbacks.current.onRunningChange(running);
  }, [running]);

  const settle = useCallback((job: PMSJob) => {
    callbacks.current.onResults(scansOf(job));
    setState(stateFor(job));
  }, []);

  /** Reports a failure, keeping whatever job was on screen. */
  const fail = useCallback((error: unknown, fallback: string) => {
    setState((current) => ({
      status: "error",
      message: error instanceof DentistSearchRequestError ? error.message : fallback,
      job: "job" in current ? current.job : null,
    }));
  }, []);

  /** Cancels any request in flight and hands out the signal for the next one. */
  const takeOver = useCallback((): AbortSignal => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    return controller.signal;
  }, []);

  /**
   * Follows one job until it stops running, whether finished or stopped by the
   * user. Resolves "forgotten" when the server no longer knows the job; throws
   * only after many failed polls in a row.
   */
  const follow = useCallback(
    async (id: string, signal: AbortSignal): Promise<"done" | "forgotten"> => {
      let failures = 0;
      for (;;) {
        await sleep(POLL_INTERVAL_MS, signal);
        if (signal.aborted) return "done";
        try {
          const { job } = await fetchPmsJob(id, signal);
          failures = 0;
          settle(job);
          if (job.status !== "RUNNING") return "done";
        } catch (error) {
          if (signal.aborted) return "done";
          if (error instanceof DentistSearchRequestError && error.code === "JOB_NOT_FOUND") {
            return "forgotten";
          }
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) throw error;
        }
      }
    },
    [settle],
  );

  const start = useCallback(async () => {
    const signal = takeOver();
    setState({ status: "starting" });

    let started = false;
    try {
      // A forgotten job is started again once; the second time it is reported.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // The server re-runs the cached search and scans what it returned; if a
        // scan of this search is running or stopped, it hands back that job.
        const response = await startPmsDetection(query, signal);
        if (signal.aborted) return;
        started = true;
        jobId.current = response.jobId;
        settle(response.job);
        if (response.job.status !== "RUNNING") return;
        if ((await follow(response.jobId, signal)) === "done") return;
      }
      if (signal.aborted) return;
      fail(null, "The server lost this PMS scan. Please try again.");
    } catch (error) {
      if (signal.aborted) return;
      fail(
        error,
        started
          ? "Lost contact with the PMS scan. Press Detect PMS to reconnect."
          : "Could not start PMS detection. Please try again.",
      );
    }
  }, [query, settle, follow, fail, takeOver]);

  const pause = useCallback(async () => {
    const id = jobId.current;
    if (!id) return;
    setSwitching(true);
    // Polling ends first, so a late poll cannot overwrite the stopped state.
    inFlight.current?.abort();
    try {
      const { job } = await pausePmsJob(id);
      settle(job);
    } catch (error) {
      fail(error, "Could not reach the server to stop the scan; it may still be running.");
    } finally {
      setSwitching(false);
    }
  }, [settle, fail]);

  const resume = useCallback(async () => {
    const id = jobId.current;
    if (!id) return;
    const signal = takeOver();
    setSwitching(true);
    try {
      const { job } = await resumePmsJob(id, signal);
      if (signal.aborted) return;
      setSwitching(false);
      settle(job);
      if (job.status !== "RUNNING") return;
      if ((await follow(id, signal)) === "forgotten" && !signal.aborted) {
        fail(null, "The server lost this PMS scan. Press Detect PMS to start again.");
      }
    } catch (error) {
      setSwitching(false);
      if (signal.aborted) return;
      fail(error, "Lost contact with the PMS scan. Press Detect PMS to reconnect.");
    }
  }, [settle, follow, fail, takeOver]);

  // On unmount: stop polling, and tell the parent the scan is no longer running
  // here, so nothing stays locked on its account.
  useEffect(
    () => () => {
      inFlight.current?.abort();
      callbacks.current.onRunningChange(false);
    },
    [],
  );

  const job = "job" in state ? state.job : null;
  const percent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const paused = state.status === "paused";
  const finished = state.status === "finished";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {paused ? (
        <button
          type="button"
          onClick={() => void resume()}
          disabled={switching || disabled}
          className={PRIMARY_BUTTON_CLASS}
        >
          {switching ? "Resuming..." : "Resume"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={running || disabled}
          className={PRIMARY_BUTTON_CLASS}
        >
          {running ? "Detecting PMS..." : finished ? "Scan again" : "Detect PMS"}
        </button>
      )}

      {state.status === "running" ? (
        <button
          type="button"
          onClick={() => void pause()}
          disabled={switching}
          className={SECONDARY_BUTTON_CLASS}
        >
          {switching ? "Stopping..." : "Stop"}
        </button>
      ) : null}

      {job ? (
        <div className="flex min-w-64 flex-1 items-center gap-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="PMS scan progress"
            className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <div
              className="h-full rounded-full bg-teal-600 transition-[width] duration-500 dark:bg-teal-400"
              style={{ width: `${percent}%` }}
            />
          </div>
          {/* Announced politely, so progress reaches a screen reader too. */}
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-sm whitespace-nowrap text-zinc-600 dark:text-zinc-400"
          >
            {finished ? (
              <>
                <CircleCheckIcon className="size-4 text-teal-600 dark:text-teal-400" aria-hidden />
                <span className="font-medium text-zinc-800 dark:text-zinc-200">Scan complete</span>
                <span aria-hidden>&middot;</span>
              </>
            ) : null}
            <span>
              {paused ? "Stopped at " : ""}
              {job.processed} / {job.total} scanned &middot; {job.detected} with a PMS
            </span>
          </p>
        </div>
      ) : null}

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
