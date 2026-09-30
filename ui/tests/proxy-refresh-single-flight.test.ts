// @vitest-environment node
/**
 * #582 follow-up — the proxy's refresh is single-flight per refresh token.
 *
 * The server rotates a refresh token exactly once and refuses every other
 * request that presents it. A navigation plus its RSC prefetches (or two tabs)
 * reaching `proxy.ts` together with one lapsed access cookie must therefore
 * share ONE upstream refresh, and every one of them must get the new cookies —
 * otherwise each loser is bounced to /login.
 *
 * Runs the real `proxy` and the real `refreshUpstreamTokens`; only `fetch` (the
 * upstream Express call) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { proxyAuth } from "@/lib/auth-proxy";
import {
  REFRESH_CACHE_MAX_ENTRIES,
  REFRESH_RESULT_TTL_MS,
  refreshSingleFlightSize,
  refreshUpstreamTokens,
  resetRefreshSingleFlight,
} from "@/lib/edge-auth";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";

const fetchMock = vi.fn();

function upstreamOk(accessToken: string, refreshToken: string): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { accessToken, refreshToken } }),
  } as unknown as Response;
}

function upstream401(): Response {
  return { ok: false, status: 401, json: () => Promise.resolve({}) } as unknown as Response;
}

function pageRequest(path: string, refresh: string): NextRequest {
  const req = new NextRequest(new Request(`http://localhost${path}`));
  req.cookies.set(REFRESH_COOKIE, refresh);
  return req;
}

/** The browser api-client's `POST /api/auth/refresh`: no body, cookies only. */
function refreshCall(refresh: string): NextRequest {
  const req = new NextRequest(new Request("http://localhost/api/auth/refresh", { method: "POST" }));
  req.cookies.set(REFRESH_COOKIE, refresh);
  return req;
}

/** A real `Response`, so both the shared and the direct proxy path can read it. */
function realUpstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function envelope(accessToken: string, refreshToken: string) {
  return { success: true, data: { accessToken, refreshToken } };
}

beforeEach(() => {
  resetRefreshSingleFlight();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("proxy refresh single-flight", () => {
  it("N concurrent page requests with one refresh cookie make ONE upstream refresh and all get the new cookies", async () => {
    // Hold the upstream response until every request is in flight, so the test
    // cannot pass by the calls merely happening one after another.
    const waiting: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => waiting.push(resolve)));
    const release = (r: () => Response) => waiting.forEach((resolve) => resolve(r()));

    const N = 6;
    const pending = Array.from({ length: N }, (_, i) =>
      proxy(pageRequest(i === 0 ? "/chat" : `/chat?_rsc=${i}`, "rt-shared")),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let every other caller reach the map before the winner resolves.
    await new Promise((r) => setTimeout(r, 10));
    release(() => upstreamOk("AT-new", "RT-new"));
    const responses = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const res of responses) {
      expect(res.headers.get("location")).toBeNull();
      expect(res.cookies.get(ACCESS_COOKIE)?.value).toBe("AT-new");
      expect(res.cookies.get(REFRESH_COOKIE)?.value).toBe("RT-new");
    }
  });

  it("a follower within the result window reuses the winner's pair; one after it triggers a new call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    fetchMock.mockResolvedValueOnce(upstreamOk("AT-1", "RT-1"));

    const first = await proxy(pageRequest("/", "rt-window"));
    expect(first.cookies.get(ACCESS_COOKIE)?.value).toBe("AT-1");

    vi.setSystemTime(Date.now() + REFRESH_RESULT_TTL_MS - 1);
    const follower = await proxy(pageRequest("/docs", "rt-window"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(follower.cookies.get(ACCESS_COOKIE)?.value).toBe("AT-1");
    expect(follower.cookies.get(REFRESH_COOKIE)?.value).toBe("RT-1");

    vi.setSystemTime(Date.now() + 2);
    fetchMock.mockResolvedValueOnce(upstream401());
    const late = await proxy(pageRequest("/docs", "rt-window"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(late.headers.get("location")).toContain("/login");
  });

  it("does not cache a failed refresh — the next request tries again", async () => {
    fetchMock.mockResolvedValueOnce(upstream401());
    expect(await refreshUpstreamTokens("rt-fail")).toBeNull();
    fetchMock.mockResolvedValueOnce(upstreamOk("AT", "RT"));
    expect(await refreshUpstreamTokens("rt-fail")).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("different refresh tokens do not share a flight", async () => {
    fetchMock
      .mockResolvedValueOnce(upstreamOk("AT-a", "RT-a"))
      .mockResolvedValueOnce(upstreamOk("AT-b", "RT-b"));
    const [a, b] = await Promise.all([
      refreshUpstreamTokens("rt-a"),
      refreshUpstreamTokens("rt-b"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a?.accessToken).not.toBe(b?.accessToken);
  });

  it("bounds the map: it never holds more than the cap", async () => {
    fetchMock.mockImplementation(async () => upstreamOk("AT", "RT"));
    for (let i = 0; i < REFRESH_CACHE_MAX_ENTRIES + 25; i += 1) {
      await refreshUpstreamTokens(`rt-${i}`);
    }
    expect(refreshSingleFlightSize()).toBeLessThanOrEqual(REFRESH_CACHE_MAX_ENTRIES);
  });

  it("sweeps expired results on insert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    fetchMock.mockImplementation(async () => upstreamOk("AT", "RT"));
    await refreshUpstreamTokens("rt-old-1");
    await refreshUpstreamTokens("rt-old-2");
    expect(refreshSingleFlightSize()).toBe(2);
    vi.setSystemTime(Date.now() + REFRESH_RESULT_TTL_MS + 1);
    await refreshUpstreamTokens("rt-new");
    expect(refreshSingleFlightSize()).toBe(1);
  });

  it("N concurrent /api/auth/refresh calls with one cookie make ONE upstream call and all get the same cookies and body", async () => {
    const waiting: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => waiting.push(resolve)));

    const N = 5; // e.g. five tabs whose api-clients refresh at once
    const pending = Array.from({ length: N }, () => proxyAuth(refreshCall("rt-tabs"), "refresh"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    waiting.forEach((resolve) => resolve(realUpstream(200, envelope("AT-tabs", "RT-tabs"))));
    const responses = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(200);
      expect(res.cookies.get(ACCESS_COOKIE)?.value).toBe("AT-tabs");
      expect(res.cookies.get(REFRESH_COOKIE)?.value).toBe("RT-tabs");
      // Same envelope as the winner's, tokens stripped from every copy.
      expect(bodies[i]).toEqual({ success: true, data: {} });
    }
  });

  it("a proxy.ts page refresh and an /api/auth/refresh running together share ONE upstream call", async () => {
    const waiting: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => waiting.push(resolve)));

    const page = proxy(pageRequest("/chat", "rt-cross"));
    const api = proxyAuth(refreshCall("rt-cross"), "refresh");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    waiting.forEach((resolve) => resolve(realUpstream(200, envelope("AT-x", "RT-x"))));
    const [pageRes, apiRes] = await Promise.all([page, api]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pageRes.headers.get("location")).toBeNull();
    expect(apiRes.status).toBe(200);
    for (const res of [pageRes, apiRes]) {
      expect(res.cookies.get(ACCESS_COOKIE)?.value).toBe("AT-x");
      expect(res.cookies.get(REFRESH_COOKIE)?.value).toBe("RT-x");
    }
  });

  it("an in-flight upstream 401 is shared by concurrent callers and sets no cookies", async () => {
    const waiting: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => waiting.push(resolve)));
    const pending = Promise.all([
      proxyAuth(refreshCall("rt-dead"), "refresh"),
      proxyAuth(refreshCall("rt-dead"), "refresh"),
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    waiting.forEach((resolve) =>
      resolve(realUpstream(401, { success: false, error: { code: "REFRESH_FAILED" } })),
    );
    const responses = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.cookies.get(ACCESS_COOKIE)).toBeUndefined();
      expect(await res.json()).toMatchObject({ error: { code: "REFRESH_FAILED" } });
    }
  });

  it("a retryable 503 passes through /api/auth/refresh with Retry-After, and proxy.ts answers 503 instead of /login", async () => {
    const unavailable = () =>
      realUpstream(
        503,
        { success: false, error: { code: "REFRESH_UNAVAILABLE" } },
        { "Retry-After": "1" },
      );
    fetchMock.mockImplementation(async () => unavailable());

    const api = await proxyAuth(refreshCall("rt-blip"), "refresh");
    expect(api.status).toBe(503);
    expect(api.headers.get("retry-after")).toBe("1");
    expect(api.cookies.get(ACCESS_COOKIE)).toBeUndefined();
    expect(await api.json()).toMatchObject({ error: { code: "REFRESH_UNAVAILABLE" } });

    const page = await proxy(pageRequest("/chat", "rt-blip"));
    expect(page.status).toBe(503);
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("retry-after")).toBe("1");
    // Not cached: each request asked upstream again.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the map by a hash — the raw refresh token is never a key", async () => {
    const setSpy = vi.spyOn(Map.prototype, "set");
    fetchMock.mockResolvedValueOnce(upstreamOk("AT", "RT"));
    await refreshUpstreamTokens("rt-secret-value");
    const keys = setSpy.mock.calls.map(([k]) => k);
    setSpy.mockRestore();
    expect(keys).not.toContain("rt-secret-value");
    expect(keys.some((k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });
});
