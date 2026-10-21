// @vitest-environment node
/**
 * #913 — the UI proxy refuses a cross-origin write before turning the session
 * cookie into a bearer token, and vouches for a same-origin one to the API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { crossOriginRejectionReason, rejectCrossOrigin, CSRF_HEADER } from "@/lib/csrf-guard";
import { POST, GET } from "@/app/api/[...path]/route";
import { proxyAuth } from "@/lib/auth-proxy";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";
import { refreshUpstream, resetRefreshSingleFlight } from "@/lib/edge-auth";

const req = (method: string, headers: Record<string, string> = {}) => ({
  method,
  headers: new Headers({ host: "metis.example.com", ...headers }),
});

describe("crossOriginRejectionReason", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never gates a safe method", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(crossOriginRejectionReason(req(m, { "sec-fetch-site": "cross-site" }))).toBe(null);
    }
  });

  it("passes same-origin and user-initiated Fetch Metadata", () => {
    expect(crossOriginRejectionReason(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(null);
    expect(crossOriginRejectionReason(req("DELETE", { "sec-fetch-site": "none" }))).toBe(null);
  });

  it("refuses same-site and cross-site Fetch Metadata", () => {
    expect(crossOriginRejectionReason(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(
      "Sec-Fetch-Site: cross-site",
    );
    expect(crossOriginRejectionReason(req("PATCH", { "sec-fetch-site": "same-site" }))).toBe(
      "Sec-Fetch-Site: same-site",
    );
  });

  it("falls back to Origin against Host or X-Forwarded-Host", () => {
    expect(crossOriginRejectionReason(req("POST", { origin: "https://metis.example.com" }))).toBe(
      null,
    );
    expect(
      crossOriginRejectionReason(
        req("POST", {
          host: "ui:3000",
          origin: "https://metis.example.com",
          "x-forwarded-host": "metis.example.com, inner",
        }),
      ),
    ).toBe(null);
    expect(crossOriginRejectionReason(req("POST", { origin: "https://evil.example" }))).toBe(
      "cross-origin Origin",
    );
    expect(crossOriginRejectionReason(req("POST", { origin: "null" }))).toBe("opaque Origin");
  });

  it("passes a request with neither header (webhooks, scripts)", () => {
    expect(crossOriginRejectionReason(req("POST"))).toBe(null);
  });

  it("passes an origin listed in METIS_TRUSTED_ORIGINS", () => {
    vi.stubEnv("METIS_TRUSTED_ORIGINS", " https://other.example , not a url");
    expect(
      crossOriginRejectionReason(
        req("POST", { "sec-fetch-site": "same-site", origin: "https://other.example" }),
      ),
    ).toBe(null);
    expect(
      crossOriginRejectionReason(
        req("POST", { "sec-fetch-site": "same-site", origin: "https://third.example" }),
      ),
    ).not.toBe(null);
  });

  it("rejectCrossOrigin answers 403 CSRF_REJECTED", async () => {
    const res = rejectCrossOrigin(req("POST", { "sec-fetch-site": "cross-site" }));
    expect(res?.status).toBe(403);
    expect((await res!.json()).error.code).toBe("CSRF_REJECTED");
    expect(rejectCrossOrigin(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(null);
  });
});

const fetchMock = vi.fn();
beforeEach(() => {
  resetRefreshSingleFlight();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => new Response("{}"));
});
afterEach(() => vi.unstubAllGlobals());

function nextReq(method: string, url: string, headers: Record<string, string>): NextRequest {
  const r = new NextRequest(
    new Request(`http://localhost${url}`, {
      method,
      headers,
      body: method === "GET" ? undefined : "{}",
    }),
  );
  r.cookies.set(ACCESS_COOKIE, "AT");
  r.cookies.set(REFRESH_COOKIE, "RT");
  return r;
}

describe("the /api/* proxy", () => {
  const ctx = () => ({ params: Promise.resolve({ path: ["projects", "p1"] }) });

  it("refuses a cross-site write without contacting the API", async () => {
    const res = await POST(
      nextReq("POST", "/api/projects/p1", { "sec-fetch-site": "cross-site" }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a same-origin write with the bearer token and the CSRF header", async () => {
    const res = await POST(
      nextReq("POST", "/api/projects/p1", { "sec-fetch-site": "same-origin" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer AT");
    expect(headers.get(CSRF_HEADER)).toBe("1");
  });

  it("still serves a cross-site read", async () => {
    const res = await GET(
      nextReq("GET", "/api/projects/p1", { "sec-fetch-site": "cross-site" }),
      ctx(),
    );
    expect(res.status).toBe(200);
  });
});

describe("the auth proxy", () => {
  it("refuses a cross-site login, logout or refresh", async () => {
    for (const endpoint of ["login", "logout", "refresh"] as const) {
      const res = await proxyAuth(
        nextReq("POST", `/api/auth/${endpoint}`, { "sec-fetch-site": "cross-site" }),
        endpoint,
      );
      expect(res.status, endpoint).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the CSRF header upstream on a same-origin call", async () => {
    await proxyAuth(
      nextReq("POST", "/api/auth/logout", { "sec-fetch-site": "same-origin" }),
      "logout",
    );
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers[CSRF_HEADER]).toBe("1");
  });

  it("sends the CSRF header on the server-initiated refresh", async () => {
    await refreshUpstream("RT-1");
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers[CSRF_HEADER]).toBe("1");
  });
});
