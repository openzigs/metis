/**
 * #1296 — the link in the §13 chain that nothing else covers.
 *
 * The footer fetches `/api/source`. The server serves `/api/source`. Both are tested.
 * Neither test touches the piece BETWEEN them: the Next.js catch-all proxy at
 * `ui/src/app/api/[...path]/route.ts`, which is what actually turns the browser's
 * `/api/source` into a request to the Express server.
 *
 * That gap is the classic shape — a producer and a consumer each green against their
 * own mock, with the real wiring between them unexercised. Three things about the
 * proxy could break the offer and be invisible in both suites:
 *
 *   1. it 404s anything whose first segment it special-cases (today only `auth`);
 *   2. it injects a `Bearer` header from a cookie — and the §13 offer has to work for
 *      a visitor who has no cookie at all, which is the case that matters most;
 *   3. it rewrites the URL, so the upstream path has to be asserted, not assumed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/[...path]/route";
import { ACCESS_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const OFFER = {
  license: "AGPL-3.0-only",
  repositoryUrl: "https://github.com/openzigs/metis",
  commit: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
  sourceUrl: "https://github.com/openzigs/metis/tree/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
};

function sourceRequest(cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new Request("http://localhost/api/source", { method: "GET" }));
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

/** The ctx shape Next.js hands a catch-all route handler. */
const sourceCtx = { params: Promise.resolve({ path: ["source"] }) };

describe("the Next.js proxy carries /api/source through to the server", () => {
  it("forwards to the upstream /source endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(OFFER), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await GET(sourceRequest(), sourceCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OFFER);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${UPSTREAM_API_BASE}/source`);
  });

  // The whole point of §13: an unauthenticated remote user must be able to get the
  // offer. If the proxy required a session for it, the footer on /login — the only
  // page such a user can see — would render a link fed by a 401.
  it("works with no session cookie, and sends no Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(OFFER), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await GET(sourceRequest(), sourceCtx);

    expect(res.status).toBe(200);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has("Authorization")).toBe(false);
  });

  it("still forwards the offer for a signed-in user", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(OFFER), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await GET(sourceRequest({ [ACCESS_COOKIE]: "token-abc" }), sourceCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OFFER);
  });

  // `source` must not collide with the proxy's one special-cased first segment.
  // Asserted rather than assumed, because that branch returns a 404 envelope with a
  // 200-shaped body and would be easy to misread as "the endpoint is missing".
  it("does not hit the auth short-circuit", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OFFER), { status: 200 }));
    const res = await GET(sourceRequest(), sourceCtx);
    expect(res.status).not.toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
