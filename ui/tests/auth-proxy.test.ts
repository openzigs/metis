/**
 * Tests for the Next.js auth proxy. Verifies that upstream tokens are
 * captured into HttpOnly cookies on the Next origin and stripped from the
 * response body before it reaches the browser.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxyAuth } from "@/lib/auth-proxy";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(
  url: string,
  init: { method?: string; body?: string; cookies?: Record<string, string> } = {},
): NextRequest {
  const req = new NextRequest(
    new Request(`http://localhost${url}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    }),
  );
  if (init.cookies) {
    for (const [name, value] of Object.entries(init.cookies)) {
      req.cookies.set(name, value);
    }
  }
  return req;
}

function upstreamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("proxyAuth", () => {
  it("forwards login bodies and mints HttpOnly cookies from upstream tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({
        success: true,
        data: {
          user: { id: "u-1", username: "tester", role: "admin" },
          accessToken: "AT",
          refreshToken: "RT",
        },
      }),
    );

    const req = makeRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "tester", password: "pw" }),
    });

    const res = await proxyAuth(req, "login");
    expect(res.status).toBe(200);

    const setCookie = res.cookies.getAll();
    const access = setCookie.find((c) => c.name === ACCESS_COOKIE);
    const refresh = setCookie.find((c) => c.name === REFRESH_COOKIE);
    expect(access?.value).toBe("AT");
    expect(access?.httpOnly).toBe(true);
    expect(access?.sameSite).toBe("lax");
    expect(refresh?.value).toBe("RT");

    const body = await res.json();
    expect(body.data.user.username).toBe("tester");
    expect(body.data.accessToken).toBeUndefined();
    expect(body.data.refreshToken).toBeUndefined();

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toMatch(/\/auth\/login$/);
    expect(calledInit.method).toBe("POST");
    expect(calledInit.body).toBe(JSON.stringify({ username: "tester", password: "pw" }));
  });

  it("propagates upstream errors verbatim and does not set cookies", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({ success: false, error: { code: "AUTH_FAILED", message: "nope" } }, 401),
    );
    const req = makeRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "x", password: "y" }),
    });

    const res = await proxyAuth(req, "login");
    expect(res.status).toBe(401);
    expect(res.cookies.get(ACCESS_COOKIE)).toBeUndefined();
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_FAILED");
  });

  it("forwards stored access cookie as Authorization + Cookie on /me", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({ success: true, data: { user: { id: "u-1" } } }),
    );
    const req = makeRequest("/api/auth/me", {
      cookies: { [ACCESS_COOKIE]: "AT", [REFRESH_COOKIE]: "RT" },
    });

    await proxyAuth(req, "me");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer AT");
    expect(init.headers.Cookie).toContain("accessToken=AT");
    expect(init.headers.Cookie).toContain("refreshToken=RT");
  });

  it("clears both cookies on logout regardless of upstream body", async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({ success: true, data: { message: "ok" } }));
    const req = makeRequest("/api/auth/logout", {
      method: "POST",
      cookies: { [ACCESS_COOKIE]: "AT", [REFRESH_COOKIE]: "RT" },
    });

    const res = await proxyAuth(req, "logout");
    const cookies = res.cookies.getAll();
    const access = cookies.find((c) => c.name === ACCESS_COOKIE);
    const refresh = cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(access?.value).toBe("");
    expect(access?.maxAge).toBe(0);
    expect(refresh?.value).toBe("");
    expect(refresh?.maxAge).toBe(0);
  });

  it("rotates cookies on refresh when upstream returns new tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({
        success: true,
        data: { accessToken: "AT2", refreshToken: "RT2" },
      }),
    );
    const req = makeRequest("/api/auth/refresh", {
      method: "POST",
      cookies: { [ACCESS_COOKIE]: "AT", [REFRESH_COOKIE]: "RT" },
    });
    const res = await proxyAuth(req, "refresh");
    expect(res.cookies.get(ACCESS_COOKIE)?.value).toBe("AT2");
    expect(res.cookies.get(REFRESH_COOKIE)?.value).toBe("RT2");
  });

  it("proxies the public sso/providers list upstream and sets no cookies (#429)", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({
        success: true,
        data: {
          providers: [
            { id: "p1", label: "Okta SAML", type: "saml", loginUrl: "/api/auth/saml/login" },
          ],
        },
      }),
    );
    const req = makeRequest("/api/auth/sso/providers");

    const res = await proxyAuth(req, "sso/providers");
    expect(res.status).toBe(200);
    // Upstream path is /auth/sso/providers (the bespoke handler, not the generic
    // proxy that 404s every /api/auth/* path).
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toMatch(/\/auth\/sso\/providers$/);
    // No tokens in the response → no cookies minted.
    expect(res.cookies.get(ACCESS_COOKIE)).toBeUndefined();
    expect(res.cookies.get(REFRESH_COOKIE)).toBeUndefined();
    const body = await res.json();
    expect(body.data.providers[0].label).toBe("Okta SAML");
  });

  it("handles non-JSON upstream bodies without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("plain text", { status: 502 }));
    const req = makeRequest("/api/auth/me");
    const res = await proxyAuth(req, "me");
    expect(res.status).toBe(502);
  });
});
