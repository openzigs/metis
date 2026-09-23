import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server so we can assert which response the gate produced without
// constructing a real NextURL/Edge response.
vi.mock("next/server", () => ({
  NextResponse: {
    redirect: vi.fn((url: unknown) => ({ kind: "redirect", url })),
    next: vi.fn(() => ({ kind: "next", cookies: { set: vi.fn() } })),
  },
}));
// Mock the edge-auth refresh so no real network call happens.
vi.mock("@/lib/edge-auth", () => ({
  refreshUpstreamTokens: vi.fn(),
  applyRotatedCookies: vi.fn(),
}));

import { middleware } from "@/middleware";
import { NextResponse } from "next/server";
import { refreshUpstreamTokens, applyRotatedCookies } from "@/lib/edge-auth";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";

const nextMock = vi.mocked(NextResponse.next);
const redirectMock = vi.mocked(NextResponse.redirect);
const refreshMock = vi.mocked(refreshUpstreamTokens);
const applyMock = vi.mocked(applyRotatedCookies);

interface ClonedUrl {
  pathname: string;
  search: string;
  searchParams: URLSearchParams;
}
interface FakeReq {
  nextUrl: { pathname: string; search: string; clone: () => ClonedUrl };
  cookies: { get: (n: string) => { value: string } | undefined };
  _cloned: ClonedUrl;
}

function makeReq(
  pathname: string,
  cookies: { access?: string; refresh?: string } = {},
  search = "",
): FakeReq {
  const store = new Map<string, { value: string }>();
  if (cookies.access) store.set(ACCESS_COOKIE, { value: cookies.access });
  if (cookies.refresh) store.set(REFRESH_COOKIE, { value: cookies.refresh });
  const cloned: ClonedUrl = { pathname: "", search: "", searchParams: new URLSearchParams() };
  return {
    nextUrl: { pathname, search, clone: () => cloned },
    cookies: { get: (n: string) => store.get(n) },
    _cloned: cloned,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (req: FakeReq) => middleware(req as any);

beforeEach(() => {
  nextMock.mockClear();
  redirectMock.mockClear();
  refreshMock.mockReset();
  applyMock.mockClear();
  nextMock.mockReturnValue({ kind: "next", cookies: { set: vi.fn() } } as never);
});

describe("middleware auth gate (handler)", () => {
  it("lets the public /login path through without attempting a refresh", async () => {
    await run(makeReq("/login"));
    expect(nextMock).toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("lets Next internals and the auth-proxy prefix through", async () => {
    await run(makeReq("/_next/static/x.js"));
    await run(makeReq("/api/auth/refresh"));
    expect(refreshMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  // The invite landing page is for people who have no session yet — bouncing
  // them to /login makes the invitation link useless.
  it("lets an unauthenticated visitor reach a workspace invite link", async () => {
    refreshMock.mockResolvedValue(null);
    await run(makeReq("/invites/abc123"));
    expect(nextMock).toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("passes a request with a live access cookie straight through (no refresh)", async () => {
    await run(makeReq("/projects/abc", { access: "live" }));
    expect(nextMock).toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("refreshes and PROCEEDS (no redirect) when access is gone but refresh succeeds", async () => {
    refreshMock.mockResolvedValue({ accessToken: "AT", refreshToken: "RT" });
    const res = await run(makeReq("/projects/abc", { refresh: "rt" }));
    expect(refreshMock).toHaveBeenCalledWith("rt");
    expect(applyMock).toHaveBeenCalledWith(res, { accessToken: "AT", refreshToken: "RT" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects to /login?next when the refresh fails", async () => {
    refreshMock.mockResolvedValue(null);
    const req = makeReq("/projects/abc", { refresh: "bad" }, "?tab=1");
    await run(req);
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(req._cloned.pathname).toBe("/login");
    expect(req._cloned.searchParams.get("next")).toBe("/projects/abc?tab=1");
    // #411 — a present-but-failed refresh cookie means the session expired, so
    // flag it for the "session expired" banner.
    expect(req._cloned.searchParams.get("reason")).toBe("expired");
  });

  it("redirects when there is no session at all (no access, no refresh) WITHOUT reason=expired", async () => {
    refreshMock.mockResolvedValue(null);
    const req = makeReq("/dashboard");
    await run(req);
    expect(refreshMock).toHaveBeenCalledWith(undefined);
    expect(redirectMock).toHaveBeenCalled();
    expect(req._cloned.searchParams.get("next")).toBe("/dashboard");
    // No refresh cookie at all → never-logged-in (not "expired") → no banner.
    expect(req._cloned.searchParams.has("reason")).toBe(false);
  });

  it("does not attach ?next when bouncing from the root path", async () => {
    refreshMock.mockResolvedValue(null);
    const req = makeReq("/");
    await run(req);
    expect(redirectMock).toHaveBeenCalled();
    expect(req._cloned.searchParams.has("next")).toBe(false);
  });
});
