"use client";

/**
 * The "Detect PMS" button and its progress line.
 *
 * Starts (or joins) a scan for the current search, polls it every couple of
 * seconds and hands each result up to the results view as it arrives. The
 * scan runs on the server; this component never touches a practice's website.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DentistSearchRequestError,
  fetchPmsJob,
  startPmsDetection,
} from "@/lib/api-client";
import type { PMSJob, PmsScan } from "@/lib/pms/types";
import type { SearchQuery } from "@/lib/types";

const POLL_INTERVAL_MS = 2_000;

const BUTTON_CLASS =
  "rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:bg-teal-700/60";

type PanelState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "running"; job: PMSJob }
  | { status: "finished"; job: PMSJob }
  | { status: "error"; message: string; job: PMSJob | null };

function scansOf(job: PMSJob): Record<string, PmsScan> {
  const scans: Record<string, PmsScan> = {};
  for (const item of job.items) {
    if (item.scan) scans[item.dentistId] = item.scan;
  }
  return scans;
}

export default function PmsDetectionPanel({
  query,
  onResults,
  onRunningChange,
}: {
  query: SearchQuery;
  /** Called with every scan seen so far, keyed by dentist id. */
  onResults: (scans: Record<string, PmsScan>) => void;
  onRunningChange: (running: boolean) => void;
}) {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const jobId = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Callbacks live in a ref so a parent re-render never restarts the poll timer.
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
    setState(job.status === "RUNNING" ? { status: "running", job } : { status: "finished", job });
  }, []);

  const start = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: "starting" });

    try {
      // The server re-runs the cached search and scans what it returned; if a
      // scan of this search is already running, it hands back that job.
      const started = await startPmsDetection(query, controller.signal);
      if (controller.signal.aborted) return;
      jobId.current = started.jobId;
      settle(started.job);
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        message:
          error instanceof DentistSearchRequestError
            ? error.message
            : "Could not start PMS detection. Please try again.",
        job: null,
      });
    }
  }, [query, settle]);

  // Poll while the job runs. Each answer produces new state, which schedules
  // the next poll; a finished job produces none, which ends the loop.
  useEffect(() => {
    if (state.status !== "running") return;
    const id = jobId.current;
    if (!id) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { job } = await fetchPmsJob(id, controller.signal);
        if (controller.signal.aborted) return;
        settle(job);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => ({
          status: "error",
          message:
            error instanceof DentistSearchRequestError
              ? error.message
              : "Lost contact with the PMS scan. Please try again.",
          job: current.status === "running" ? current.job : null,
        }));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [state, settle]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const job = "job" in state ? state.job : null;
  const percent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={running}
        className={BUTTON_CLASS}
      >
        {running ? "Detecting PMS..." : "Detect PMS"}
      </button>

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
            className="text-sm whitespace-nowrap text-zinc-600 dark:text-zinc-400"
          >
            {job.processed} / {job.total} scanned &middot; {job.detected} with a PMS
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
