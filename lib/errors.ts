/**
 * Application error types.
 *
 * Each error carries a machine readable `code`, an HTTP `status`, and a
 * `publicMessage` that is safe to show a user. The `message`/`cause` fields may
 * contain technical detail and are only ever written to the server log.
 */

export type AppErrorCode =
  | "INVALID_ZIP"
  | "INVALID_PARAMETER"
  | "ZIP_NOT_FOUND"
  | "GEOCODING_FAILED"
  | "SEARCH_FAILED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  /** User-facing text. Must not leak stack traces, URLs or provider internals. */
  readonly publicMessage: string;

  constructor(
    code: AppErrorCode,
    status: number,
    publicMessage: string,
    internalMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(internalMessage ?? publicMessage, options);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export class InvalidZipError extends AppError {
  constructor(internalMessage?: string) {
    super(
      "INVALID_ZIP",
      400,
      "Please enter a valid US ZIP code.",
      internalMessage,
    );
  }
}

export class InvalidParameterError extends AppError {
  constructor(publicMessage: string, internalMessage?: string) {
    super("INVALID_PARAMETER", 400, publicMessage, internalMessage);
  }
}

export class ZipNotFoundError extends AppError {
  constructor(zip: string) {
    super(
      "ZIP_NOT_FOUND",
      404,
      "We couldn't find that ZIP code.",
      `No geocoding result for ZIP ${zip}`,
    );
  }
}

/** Base class for anything that went wrong while talking to a provider. */
export class ProviderError extends AppError {
  constructor(
    code: AppErrorCode,
    status: number,
    publicMessage: string,
    internalMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(code, status, publicMessage, internalMessage, options);
  }
}

const PROVIDER_UNAVAILABLE_MESSAGE =
  "The dentist search service is temporarily unavailable. Please try again.";

export class GeocodingError extends ProviderError {
  constructor(internalMessage: string, options?: { cause?: unknown }) {
    super(
      "GEOCODING_FAILED",
      502,
      PROVIDER_UNAVAILABLE_MESSAGE,
      internalMessage,
      options,
    );
  }
}

export class SearchError extends ProviderError {
  constructor(internalMessage: string, options?: { cause?: unknown }) {
    super(
      "SEARCH_FAILED",
      502,
      PROVIDER_UNAVAILABLE_MESSAGE,
      internalMessage,
      options,
    );
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(internalMessage: string, options?: { cause?: unknown }) {
    super(
      "PROVIDER_TIMEOUT",
      504,
      "The dentist search service took too long to respond. Please try again.",
      internalMessage,
      options,
    );
  }
}

export class RateLimitedError extends AppError {
  constructor(internalMessage?: string) {
    super(
      "RATE_LIMITED",
      429,
      "Too many searches. Please wait a moment and try again.",
      internalMessage,
    );
  }
}

/** Misconfigured environment, e.g. `MAP_PROVIDER=google` with no API key. */
export class ConfigurationError extends AppError {
  constructor(internalMessage: string) {
    super(
      "CONFIGURATION_ERROR",
      500,
      "The dentist search service is not configured correctly.",
      internalMessage,
    );
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "INTERNAL_ERROR",
    500,
    "Something went wrong. Please try again.",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
