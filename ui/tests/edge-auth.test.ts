import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshUpstreamTokens, applyRotatedCookies } from "@/lib/edge-auth";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";
import type { NextResponse } from "next/server";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function upstream(ok: boolean, body?: unknown, throwJson = false): Response {
  return {
    ok,
    status: ok ? 200 : 401,
    json: () => (throwJson ? Promise.reject(new Error("bad json")) : Promise.resolve(body)),
  } as unknown as Response;
}

describe("refreshUpstreamTokens", () => {
  it("returns null WITHOUT calling fetch when there is no refresh token", async () => {
    expect(await refreshUpstreamTokens(undefined)).toBeNull();
    expect(await refreshUpstreamTokens("")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the refresh token as the upstream refreshToken cookie and returns the rotated pair", async () => {
    fetchMock.mockResolvedValue(
      upstream(true, { data: { accessToken: "AT", refreshToken: "RT" } }),
    );
    const out = await refreshUpstreamTokens("rt-value");
    expect(out).toEqual({ accessToken: "AT", refreshToken: "RT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/auth/refresh");
    expect(init.method).toBe("POST");
    // Security: forward ONLY the refresh token (as the cookie), never an access
    // token or Authorization header, and never anything else from the client.
    expect((init.headers as Record<string, string>).Cookie).toBe("refreshToken=rt-value");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("returns null on a non-ok response (expired/invalid/revoked refresh token → 401)", async () => {
    fetchMock.mockResolvedValue(upstream(false));
    expect(await refreshUpstreamTokens("rt")).toBeNull();
  });

  it("returns null when the body is missing a rotated access or refresh token", async () => {
    fetchMock.mockResolvedValue(upstream(true, { data: { accessToken: "AT" } }));
    expect(await refreshUpstreamTokens("rt")).toBeNull();
  });

  it("returns null on a malformed JSON body", async () => {
    fetchMock.mockResolvedValue(upstream(true, undefined, true));
    expect(await refreshUpstreamTokens("rt")).toBeNull();
  });

  it("never throws — resolves null on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(refreshUpstreamTokens("rt")).resolves.toBeNull();
  });
});

describe("applyRotatedCookies", () => {
  it("sets both Next-origin cookies with HttpOnly/SameSite/path and the right TTLs", () => {
    const set = vi.fn();
    const response = { cookies: { set } } as unknown as NextResponse;
    applyRotatedCookies(response, { accessToken: "AT", refreshToken: "RT" });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(
      ACCESS_COOKIE,
      "AT",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 }),
    );
    expect(set).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      "RT",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      }),
    );
  });
});
