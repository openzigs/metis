import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ApiError,
  apiFetch,
  streamFetch,
  refreshAccessToken,
  setOnRefreshFailure,
  setOnRefreshSuccess,
  _resetAuthRetryState,
} from "@/lib/api-client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  _resetAuthRetryState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAuthRetryState();
});

function makeResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: init.ok ?? status < 400,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

describe("apiFetch", () => {
  it("unwraps the data payload from a success envelope", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: { hello: "world" } }));
    const result = await apiFetch<{ hello: string }>("/ping");
    expect(result).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ping",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
      }),
    );
  });

  it("serializes body to JSON automatically", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: null }));
    await apiFetch("/things", { method: "POST", body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  // #14 — a pre-serialised body is double-encoded by apiFetch. Fail loudly
  // outside production rather than send a JSON string the server rejects.
  it("rejects an already-serialised string body outside production", async () => {
    await expect(
      apiFetch("/things", { method: "POST", body: JSON.stringify({ a: 1 }) }),
    ).rejects.toThrow(/already a string.*pass the plain object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw on a string body in production (behaviour unchanged there)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: null }));
      await apiFetch("/things", { method: "POST", body: "plain" });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.body).toBe(JSON.stringify("plain"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows non-string bodies (arrays, numbers, booleans, null)", async () => {
    for (const body of [[1, 2], 0, false, null]) {
      fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: null }));
      await apiFetch("/things", { method: "POST", body });
    }
    expect(fetchMock.mock.calls.map(([, init]) => init.body)).toEqual([
      "[1,2]",
      "0",
      "false",
      "null",
    ]);
  });

  it("appends defined query params and skips undefined ones", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: [] }));
    await apiFetch("/list", {
      params: { page: 2, q: "abc", missing: undefined },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/list?page=2&q=abc");
  });

  it("omits the query string when every param is undefined", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: [] }));
    await apiFetch("/list", { params: { a: undefined, b: undefined } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/list");
  });

  it("falls back to the response statusText when the error payload omits a message", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ success: false, error: { code: "BOOM" } }, { status: 500 }),
    );
    await expect(apiFetch("/things")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: "BOOM",
      message: "Error",
    });
  });

  it("uses the default message when neither an error message nor statusText is present", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: undefined,
      text: () => Promise.resolve(JSON.stringify({ success: false })),
    } as unknown as Response);
    await expect(apiFetch("/things")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "Request failed",
    });
  });

  it("normalizes 4xx responses into ApiError with code + message", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        {
          success: false,
          error: { code: "AUTH_FAILED", message: "Bad credentials" },
        },
        { status: 401 },
      ),
    );
    await expect(apiFetch("/auth/login")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "AUTH_FAILED",
      message: "Bad credentials",
    });
  });

  it("falls back to status text on a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse("oops", { status: 500 }));
    await expect(apiFetch("/x")).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined when the upstream body is empty", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(""));
    const result = await apiFetch("/empty");
    expect(result).toBeUndefined();
  });

  it("prefixes paths without a leading slash", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true, data: 1 }));
    await apiFetch("ping");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ping");
  });
});

describe("ApiError", () => {
  it("captures status, code, message, and details", () => {
    const err = new ApiError(418, "I'm a teapot", "TEAPOT", { brewing: true });
    expect(err.status).toBe(418);
    expect(err.code).toBe("TEAPOT");
    expect(err.details).toEqual({ brewing: true });
    expect(err.message).toBe("I'm a teapot");
    expect(err.name).toBe("ApiError");
  });
});

describe("401 → refresh → retry", () => {
  it("refreshes once and retries the original request on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 })) // /auth/refresh
      .mockResolvedValueOnce(makeResponse({ success: true, data: { ok: 1 } }));

    const result = await apiFetch<{ ok: number }>("/things");
    expect(result).toEqual({ ok: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/things");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/things");
  });

  it("propagates the 401 and fires onRefreshFailure when refresh fails", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);

    fetchMock
      .mockResolvedValueOnce(
        makeResponse(
          { success: false, error: { message: "expired", code: "AUTH_EXPIRED" } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 })); // /auth/refresh fails

    await expect(apiFetch("/things")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the 401 when the retry itself returns 401 and notifies on failure", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);

    fetchMock
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 })) // refresh ok
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 })); // retry still 401

    await expect(apiFetch("/things")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("never retries the refresh endpoint itself", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }));
    await expect(apiFetch("/auth/refresh", { method: "POST" })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent 401s into a single refresh call", async () => {
    // Each of the 3 concurrent callers sees 401, then we expect ONE refresh,
    // then 3 successful retries.
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/auth/refresh") {
        return Promise.resolve(makeResponse({ success: true }, { status: 200 }));
      }
      // First call to a given endpoint returns 401, subsequent ones succeed.
      const callsForUrl = fetchMock.mock.calls.filter(([u]) => u === url).length;
      if (callsForUrl === 1) {
        return Promise.resolve(makeResponse({ success: false }, { status: 401 }));
      }
      return Promise.resolve(makeResponse({ success: true, data: { url } }));
    });

    const [a, b, c] = await Promise.all([
      apiFetch<{ url: string }>("/a"),
      apiFetch<{ url: string }>("/b"),
      apiFetch<{ url: string }>("/c"),
    ]);
    expect(a).toEqual({ url: "/api/a" });
    expect(b).toEqual({ url: "/api/b" });
    expect(c).toEqual({ url: "/api/c" });

    const refreshCalls = fetchMock.mock.calls.filter(([u]) => u === "/api/auth/refresh");
    expect(refreshCalls.length).toBe(1);
  });

  it("handles refresh fetch rejection gracefully", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);

    fetchMock
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }))
      .mockRejectedValueOnce(new Error("network down"));

    await expect(apiFetch("/things")).rejects.toMatchObject({ status: 401 });
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});

// #414 — refresh-success signal. The socket-client subscribes to this so it can
// re-handshake with the FRESH `metis.at` cookie when the access token rolls over.
// The signal must fire from the ONE place every refresh flows through
// (`refreshOnce`) so it covers BOTH the reactive 401 retry path AND the proactive
// sliding-session timer (#410) with no extra `/auth/refresh` calls.
describe("setOnRefreshSuccess — refresh-success signal (#414)", () => {
  it("fires exactly once on a successful proactive refreshAccessToken()", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 }));

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/refresh");
  });

  it("does NOT fire when the refresh response is non-ok", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    fetchMock.mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }));

    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does NOT fire when the refresh fetch rejects (thrown)", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("fires via the reactive 401 → refresh → retry path (apiFetch)", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    fetchMock
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 })) // /auth/refresh
      .mockResolvedValueOnce(makeResponse({ success: true, data: { ok: 1 } }));

    await expect(apiFetch<{ ok: number }>("/things")).resolves.toEqual({ ok: 1 });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("a throwing success-handler does NOT break the refresh result", async () => {
    setOnRefreshSuccess(() => {
      throw new Error("subscriber blew up");
    });
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 }));

    // The refresh promise still resolves true even though the subscriber threw.
    await expect(refreshAccessToken()).resolves.toBe(true);
  });

  it("coalesced concurrent refreshes fire the success signal once", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    fetchMock.mockResolvedValue(makeResponse({ success: true }, { status: 200 }));

    const [a, b, c] = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    // Single-flight: one /auth/refresh, one success signal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("is cleared by _resetAuthRetryState()", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    _resetAuthRetryState();
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 }));

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("setOnRefreshSuccess(null) unregisters the handler", async () => {
    const onSuccess = vi.fn();
    setOnRefreshSuccess(onSuccess);
    setOnRefreshSuccess(null);
    fetchMock.mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 }));

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

// #412 — distinguish auth-expiry 401s (refresh-eligible) from authz 401s
// (surface like a 403; never refresh, never log out).
describe("401 taxonomy — authz vs auth-expiry (apiFetch)", () => {
  it("auth-expiry 401 (TOKEN_EXPIRED) still refreshes + retries", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ success: false, error: { code: "TOKEN_EXPIRED" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(makeResponse({ success: true }, { status: 200 })) // /auth/refresh
      .mockResolvedValueOnce(makeResponse({ success: true, data: { ok: 1 } }));

    const result = await apiFetch<{ ok: number }>("/things");
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
    expect(onFail).not.toHaveBeenCalled();
  });

  it("authz 401 (FORBIDDEN) surfaces as ApiError WITHOUT refresh or logout", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        { success: false, error: { code: "FORBIDDEN", message: "Requires permission" } },
        { status: 401 },
      ),
    );

    await expect(apiFetch("/admin/thing")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "FORBIDDEN",
    });
    // No refresh call, no logout callback.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("authz 401 (INSUFFICIENT_SCOPE) also surfaces without refresh or logout", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock.mockResolvedValueOnce(
      makeResponse({ success: false, error: { code: "INSUFFICIENT_SCOPE" } }, { status: 401 }),
    );

    await expect(apiFetch("/scoped")).rejects.toMatchObject({
      status: 401,
      code: "INSUFFICIENT_SCOPE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("default-on-unknown: a 401 with no recognized code stays refresh-eligible", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 })) // no code
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 })); // refresh fails

    await expect(apiFetch("/things")).rejects.toMatchObject({ status: 401 });
    // Refresh WAS attempted and, on failure, logout fired — today's behavior.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});

// H1 — streamFetch must reuse the same single-flight refresh logic so that
// streaming endpoints (SSE) get a fresh access token before the connection
// opens, instead of silently 401'ing mid-conversation.
describe("streamFetch", () => {
  function streamingResponse(body: string, status = 200): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const res = {
      ok: status < 400,
      status,
      body: stream,
      json: () => Promise.resolve(body ? JSON.parse(body) : { error: { message: "auth" } }),
      // streamFetch clones the response to peek at the error code on a 401
      // without disturbing the body the caller may still read.
      clone() {
        return {
          text: () => Promise.resolve(body),
        } as unknown as Response;
      },
    };
    return res as unknown as Response;
  }

  it("returns the raw Response untouched on success — body is preserved", async () => {
    fetchMock.mockResolvedValueOnce(streamingResponse("data: hi\n\n"));
    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);
  });

  it("refreshes once on 401 and reopens the stream", async () => {
    fetchMock
      .mockResolvedValueOnce(streamingResponse("", 401))
      .mockResolvedValueOnce(makeResponse({ success: true })) // /auth/refresh ok
      .mockResolvedValueOnce(streamingResponse("ok"));

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
  });

  it("returns the 401 and fires onRefreshFailure when refresh fails", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(streamingResponse("", 401))
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 }));

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(401);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("returns the 401 when the retry itself returns 401", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(streamingResponse("", 401))
      .mockResolvedValueOnce(makeResponse({ success: true }))
      .mockResolvedValueOnce(streamingResponse("", 401));

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(401);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("does not retry the refresh endpoint itself", async () => {
    fetchMock.mockResolvedValueOnce(streamingResponse("", 401));
    const res = await streamFetch("/auth/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends query params and uses same-origin credentials", async () => {
    fetchMock.mockResolvedValueOnce(streamingResponse("ok"));
    await streamFetch("/ai/stream", { method: "POST", params: { sessionId: "s1" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/stream?sessionId=s1");
    expect((init as RequestInit).credentials).toBe("same-origin");
  });

  // #412 — streamFetch parity for the 401 taxonomy.
  it("auth-expiry 401 (TOKEN_EXPIRED) still refreshes and reopens the stream", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(
        streamingResponse(
          JSON.stringify({ success: false, error: { code: "TOKEN_EXPIRED" } }),
          401,
        ),
      )
      .mockResolvedValueOnce(makeResponse({ success: true })) // /auth/refresh ok
      .mockResolvedValueOnce(streamingResponse("ok"));

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
    expect(onFail).not.toHaveBeenCalled();
  });

  it("authz 401 (FORBIDDEN) is returned untouched — NO refresh, NO logout", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock.mockResolvedValueOnce(
      streamingResponse(JSON.stringify({ success: false, error: { code: "FORBIDDEN" } }), 401),
    );

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(401);
    // Body still readable by the caller (clone was used to peek the code).
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("default-on-unknown: a 401 with no code still refreshes (today's behavior)", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(streamingResponse("", 401)) // no code
      .mockResolvedValueOnce(makeResponse({ success: false }, { status: 401 })); // refresh fails

    const res = await streamFetch("/ai/stream", { method: "POST" });
    expect(res.status).toBe(401);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
