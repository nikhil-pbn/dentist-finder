/**
 * Retry, budget and diagnostics behaviour of the shared provider HTTP layer.
 *
 * These exist because the public Overpass endpoint fails intermittently under
 * load: a single unlucky attempt must not fail a user's search, and when a
 * search does fail the log has to say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_MAX_ATTEMPTS,
  PROVIDER_TOTAL_BUDGET_MS,
} from "@/lib/constants";
import { ProviderTimeoutError } from "@/lib/errors";
import {
  describeCause,
  HttpStatusError,
  requestText,
} from "@/lib/providers/http";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Backoff is real time; skip it so the suite stays fast.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(body: string): Response {
  return new Response(body, { status: 200 });
}

function status(code: number, body = "upstream error"): Response {
  return new Response(body, { status: code });
}

const options = { timeoutMs: 5_000, label: "Overpass" } as const;

describe("retrying a flaky upstream", () => {
  it("returns the body when the first attempt succeeds", async () => {
    fetchMock.mockResolvedValueOnce(ok("payload"));
    await expect(requestText("https://example.test", options)).resolves.toBe(
      "payload",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a 504, which is the observed Overpass failure", async () => {
    fetchMock
      .mockResolvedValueOnce(status(504))
      .mockResolvedValueOnce(ok("payload"));

    await expect(requestText("https://example.test", options)).resolves.toBe(
      "payload",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a dropped connection", async () => {
    fetchMock
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("Connect Timeout Error"), {
            name: "ConnectTimeoutError",
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        }),
      )
      .mockResolvedValueOnce(ok("payload"));

    await expect(requestText("https://example.test", options)).resolves.toBe(
      "payload",
    );
  });

  it("survives two consecutive failures before succeeding", async () => {
    // Roughly one Overpass request in three failed when measured, so two in a
    // row is not unusual and must not surface to the user.
    fetchMock
      .mockResolvedValueOnce(status(504))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok("payload"));

    await expect(requestText("https://example.test", options)).resolves.toBe(
      "payload",
    );
    expect(fetchMock).toHaveBeenCalledTimes(PROVIDER_MAX_ATTEMPTS);
  });

  it("gives up after the attempt limit rather than storming", async () => {
    fetchMock.mockResolvedValue(status(503));

    await expect(requestText("https://example.test", options)).rejects.toThrow(
      HttpStatusError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(PROVIDER_MAX_ATTEMPTS);
  });

  it("does not retry a non-retryable status", async () => {
    fetchMock.mockResolvedValue(status(400, "bad request"));

    await expect(requestText("https://example.test", options)).rejects.toThrow(
      HttpStatusError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("obeys a 429 instead of hammering through it", async () => {
    // Over-quota is the server asking us to stop, not a transient wobble.
    fetchMock.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );

    await expect(requestText("https://example.test", options)).rejects.toThrow(
      HttpStatusError,
    );
    expect(fetchMock.mock.calls.length).toBeLessThan(PROVIDER_MAX_ATTEMPTS);
  });
});

describe("endpoint failover", () => {
  const ENDPOINTS = [
    "https://primary.test/api",
    "https://fallback.test/api",
  ] as const;

  it("uses only the primary while it is healthy", async () => {
    fetchMock.mockResolvedValue(ok("payload"));
    await requestText(ENDPOINTS, options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINTS[0]);
  });

  it("moves to the fallback when the primary refuses the connection", async () => {
    // The measured real-world failure: the host stops accepting TCP entirely,
    // so retrying the same host cannot help.
    fetchMock
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("Connect Timeout Error"), {
            name: "ConnectTimeoutError",
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        }),
      )
      .mockResolvedValueOnce(ok("payload"));

    await expect(requestText(ENDPOINTS, options)).resolves.toBe("payload");
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINTS[0]);
    expect(fetchMock.mock.calls[1][0]).toBe(ENDPOINTS[1]);
  });

  it("moves to the fallback after a 5xx as well", async () => {
    fetchMock
      .mockResolvedValueOnce(status(504))
      .mockResolvedValueOnce(ok("payload"));

    await expect(requestText(ENDPOINTS, options)).resolves.toBe("payload");
    expect(fetchMock.mock.calls[1][0]).toBe(ENDPOINTS[1]);
  });

  it("names every endpoint it tried when all of them fail", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(requestText(ENDPOINTS, options)).rejects.toThrow(
      /primary\.test, fallback\.test/,
    );
  });

  it("refuses to run with no endpoint configured", async () => {
    await expect(requestText([], options)).rejects.toThrow(/no configured endpoint/);
  });
});

describe("the wall-clock budget", () => {
  it("stops retrying once the budget is spent", async () => {
    // Each attempt consumes the entire budget, so there is no time for another.
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + PROVIDER_TOTAL_BUDGET_MS);
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await expect(requestText("https://example.test", options)).rejects.toThrow(
        ProviderTimeoutError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a timeout as a timeout, not a generic failure", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    );
    await expect(requestText("https://example.test", options)).rejects.toThrow(
      ProviderTimeoutError,
    );
  });
});

describe("describeCause", () => {
  it("unwraps the cause that fetch hides behind 'fetch failed'", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        name: "ConnectTimeoutError",
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });

    const described = describeCause(wrapped);
    expect(described).toContain("fetch failed");
    expect(described).toContain("ConnectTimeoutError");
    expect(described).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("handles a plain error and a non-error", () => {
    expect(describeCause(new Error("boom"))).toBe("Error: boom");
    expect(describeCause("just a string")).toBe("just a string");
  });

  it("does not loop forever on a circular cause chain", () => {
    const a = new Error("a");
    a.cause = a;
    expect(describeCause(a).length).toBeLessThan(200);
  });

  it("reaches the diagnostic message a failed request throws", async () => {
    fetchMock.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      }),
    );

    await expect(
      requestText("https://example.test", options),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});
