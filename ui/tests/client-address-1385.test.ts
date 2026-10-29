// @vitest-environment node
/**
 * #1385 — the UI tells the API which client a proxied auth request came from,
 * signed with `METIS_UI_PROXY_SECRET`, so the API's auth limiter stops being one
 * bucket per UI pod. The address is the one the trusted proxies appended to
 * `X-Forwarded-For`; anything the browser wrote to the left of it is ignored.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
  clientAddressHeaders,
  resetClientAddressWarning,
  trustedClientAddress,
  trustedProxyHops,
} from "@/lib/client-address";
import { proxyAuth } from "@/lib/auth-proxy";
import { resetRefreshSingleFlight } from "@/lib/edge-auth";
import { REFRESH_COOKIE } from "@/lib/config";
import { GET } from "@/app/api/[...path]/route";

const SECRET = "ui-test-proxy-secret-long-enough-0123456789";
/** What the API computes (`server/src/middleware/auth-client-address.ts`). */
// A fixed clock: the signature covers the minute it was made in (#1385 review).
const NOW = Date.UTC(2026, 9, 21, 12, 0, 30);
const MINUTE = Math.floor(NOW / 60_000);
const apiSignature = (address: string) =>
  createHmac("sha256", SECRET)
    .update(`metis-client-address/v2\n${MINUTE}\n${address}`)
    .digest("hex");

const fetchMock = vi.fn();
beforeEach(() => {
  resetRefreshSingleFlight();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response(JSON.stringify({ success: false }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  );
  process.env.METIS_UI_PROXY_SECRET = SECRET;
  process.env.METIS_TRUSTED_PROXY_HOPS = "1";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.METIS_UI_PROXY_SECRET;
  delete process.env.METIS_TRUSTED_PROXY_HOPS;
});

const xff = (value: string) => new Headers({ "x-forwarded-for": value });

describe("trustedProxyHops", () => {
  it("defaults to 0 — the UI is the edge and trusts no forwarded address", () => {
    delete process.env.METIS_TRUSTED_PROXY_HOPS;
    expect(trustedProxyHops()).toBe(0);
    expect(trustedProxyHops("")).toBe(0);
  });
  it("reads a small non-negative integer and refuses anything else", () => {
    expect(trustedProxyHops("1")).toBe(1);
    expect(trustedProxyHops(" 2 ")).toBe(2);
    expect(trustedProxyHops("-1")).toBe(0);
    expect(trustedProxyHops("1.5")).toBe(0);
    expect(trustedProxyHops("eleven")).toBe(0);
    expect(trustedProxyHops("11")).toBe(0);
  });
});

describe("trustedClientAddress", () => {
  it("takes the entry the trusted proxy appended, ignoring what the browser wrote before it", () => {
    expect(trustedClientAddress(xff("6.6.6.6, 203.0.113.7"), 1)).toBe("203.0.113.7");
    expect(trustedClientAddress(xff("6.6.6.6, 203.0.113.7, 10.0.0.9"), 2)).toBe("203.0.113.7");
  });
  it("sends nothing at 0 hops, with too few entries, or no header", () => {
    expect(trustedClientAddress(xff("203.0.113.7"), 0)).toBeNull();
    expect(trustedClientAddress(xff("203.0.113.7"), 2)).toBeNull();
    expect(trustedClientAddress(new Headers(), 1)).toBeNull();
  });
  it("accepts only an IP address, tolerating a port", () => {
    expect(trustedClientAddress(xff("2001:db8::7"), 1)).toBe("2001:db8::7");
    expect(trustedClientAddress(xff("203.0.113.7:51234"), 1)).toBe("203.0.113.7");
    expect(trustedClientAddress(xff("[2001:db8::7]:443"), 1)).toBe("2001:db8::7");
    expect(trustedClientAddress(xff("unknown"), 1)).toBeNull();
    expect(trustedClientAddress(xff("203.0.113.7, "), 1)).toBeNull();
  });
});

describe("clientAddressHeaders", () => {
  it("signs the trusted address exactly as the API verifies it", async () => {
    expect(await clientAddressHeaders(xff("6.6.6.6, 203.0.113.7"))).toEqual({
      [CLIENT_ADDRESS_HEADER]: "203.0.113.7",
      [CLIENT_ADDRESS_SIGNATURE_HEADER]: apiSignature("203.0.113.7"),
    });
  });
  it("sends nothing without a secret of at least 32 characters", async () => {
    delete process.env.METIS_UI_PROXY_SECRET;
    expect(await clientAddressHeaders(xff("203.0.113.7"))).toEqual({});
    process.env.METIS_UI_PROXY_SECRET = "short";
    expect(await clientAddressHeaders(xff("203.0.113.7"))).toEqual({});
  });
  it("warns once when it trusts a proxy hop but has no secret to sign with", async () => {
    resetClientAddressWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env.METIS_UI_PROXY_SECRET;
      await clientAddressHeaders(xff("203.0.113.7"));
      await clientAddressHeaders(xff("203.0.113.7"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/METIS_UI_PROXY_SECRET/);
      resetClientAddressWarning();
      process.env.METIS_TRUSTED_PROXY_HOPS = "0";
      await clientAddressHeaders(xff("203.0.113.7"));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("sends nothing at the default 0 hops", async () => {
    delete process.env.METIS_TRUSTED_PROXY_HOPS;
    expect(await clientAddressHeaders(xff("203.0.113.7"))).toEqual({});
  });
});

function upstreamHeaders(call: number): Headers {
  return new Headers(fetchMock.mock.calls[call]![1]!.headers as Record<string, string>);
}

describe("auth proxy forwards the signed client address (#1385)", () => {
  it("a login carries the address the Ingress appended, not the browser's forged one", async () => {
    const req = new NextRequest(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "a", password: "b" }),
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "1.2.3.4, 203.0.113.7",
          // The browser's own attempt at the API's headers is never forwarded.
          [CLIENT_ADDRESS_HEADER]: "1.2.3.4",
          [CLIENT_ADDRESS_SIGNATURE_HEADER]: apiSignature("1.2.3.4"),
        },
      }),
    );
    await proxyAuth(req, "login");
    const sent = upstreamHeaders(0);
    expect(sent.get(CLIENT_ADDRESS_HEADER)).toBe("203.0.113.7");
    expect(sent.get(CLIENT_ADDRESS_SIGNATURE_HEADER)).toBe(apiSignature("203.0.113.7"));
    expect(sent.get("x-forwarded-for")).toBeNull();
  });

  it("a cookie refresh carries it through the shared single-flight", async () => {
    const req = new NextRequest(
      new Request("http://localhost/api/auth/refresh", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.4" },
      }),
    );
    req.cookies.set(REFRESH_COOKIE, "rt-1385");
    await proxyAuth(req, "refresh");
    expect(upstreamHeaders(0).get(CLIENT_ADDRESS_HEADER)).toBe("198.51.100.4");
  });

  it("the generic /api proxy drops a browser-supplied client address", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    const req = new NextRequest(
      new Request("http://localhost/api/projects", {
        headers: {
          [CLIENT_ADDRESS_HEADER]: "1.2.3.4",
          [CLIENT_ADDRESS_SIGNATURE_HEADER]: apiSignature("1.2.3.4"),
        },
      }),
    );
    await GET(req, { params: Promise.resolve({ path: ["projects"] }) });
    const sent = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(sent.get(CLIENT_ADDRESS_HEADER)).toBeNull();
    expect(sent.get(CLIENT_ADDRESS_SIGNATURE_HEADER)).toBeNull();
  });
  it("the generic /api proxy signs the trusted client address itself (#1539)", async () => {
    process.env.METIS_TRUSTED_PROXY_HOPS = "1";
    process.env.METIS_UI_PROXY_SECRET = SECRET;
    fetchMock.mockImplementation(async () => new Response("{}"));
    const req = new NextRequest(
      new Request("http://localhost/api/webhooks/github", {
        headers: { "x-forwarded-for": "198.51.100.9" },
      }),
    );
    await GET(req, { params: Promise.resolve({ path: ["webhooks", "github"] }) });
    const sent = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(sent.get(CLIENT_ADDRESS_HEADER)).toBe("198.51.100.9");
    expect(sent.get(CLIENT_ADDRESS_SIGNATURE_HEADER)).toBe(apiSignature("198.51.100.9"));
  });
});
