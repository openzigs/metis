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
