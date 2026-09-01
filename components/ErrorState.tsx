/**
 * Failure presentation. The message always arrives from the API's
 * `publicMessage`, so a stack trace or upstream URL can never surface here.
 */
export default function ErrorState({
  message,
  detail,
  onRetry,
}: {
  message: string;
  /** Operator-facing reason, sent only in development. */
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 dark:border-red-900/60 dark:bg-red-950/40"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-lg leading-5 text-red-600 dark:text-red-400">
          &#9888;
        </span>
        <div>
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {message}
          </p>
          {detail ? (
            <p className="mt-2 font-mono text-xs leading-5 break-words text-red-700/90 dark:text-red-300/90">
              {detail}
            </p>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 transition-colors hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 dark:border-red-800 dark:bg-transparent dark:text-red-200 dark:hover:bg-red-900/40"
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
