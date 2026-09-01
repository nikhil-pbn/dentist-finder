/**
 * Structured server-side logging.
 *
 * Only ever receives operational metadata (provider, zip, radius, counts,
 * durations, error codes). API keys, secrets and user identity are never
 * passed in - see the API route for exactly what is logged.
 */
type LogFields = Record<string, string | number | boolean | null | undefined>;

type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const payload = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
