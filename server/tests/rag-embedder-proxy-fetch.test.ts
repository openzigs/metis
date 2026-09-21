/**
 * Epic #930 — proxy-aware fetch for remote embedding backends.
 *
 * Covers the proxy-selection logic (scheme matching, NO_PROXY bypass) and that
 * `createProxyFetch` only attaches a dispatcher when a proxy actually applies.
 * No real network or undici `ProxyAgent` is touched — the dispatcher factory is
 * injected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createProxyFetch,
  getProxyDispatcherUrl,
  selectProxyUrl,
  shouldBypassProxy,
  type ProxyEnvLike,
} from "../src/lib/rag/backends/proxy-fetch.js";

describe("selectProxyUrl", () => {
  it("uses HTTPS_PROXY for https targets", () => {
    const env: ProxyEnvLike = { HTTPS_PROXY: "http://proxy:3128" };
    expect(selectProxyUrl("https://api.example.com/embeddings", env)).toBe("http://proxy:3128");
  });

  it("uses HTTP_PROXY for http targets", () => {
    const env: ProxyEnvLike = { HTTP_PROXY: "http://proxy:3128" };
    expect(selectProxyUrl("http://gateway.internal/embeddings", env)).toBe("http://proxy:3128");
  });

  it("does NOT use HTTP_PROXY for an https target", () => {
    const env: ProxyEnvLike = { HTTP_PROXY: "http://proxy:3128" };
    expect(selectProxyUrl("https://api.example.com", env)).toBeUndefined();
  });

  it("honours lowercase env var aliases", () => {
    const env: ProxyEnvLike = { https_proxy: "http://low:8080" };
    expect(selectProxyUrl("https://api.example.com", env)).toBe("http://low:8080");
  });

  it("returns undefined when no proxy is configured", () => {
    expect(selectProxyUrl("https://api.example.com", {})).toBeUndefined();
  });

  it("returns undefined for a malformed url", () => {
    const env: ProxyEnvLike = { HTTPS_PROXY: "http://proxy:3128" };
    expect(selectProxyUrl("not a url", env)).toBeUndefined();
  });
});

describe("shouldBypassProxy", () => {
  it("bypasses everything when NO_PROXY is '*'", () => {
    expect(shouldBypassProxy("https://api.example.com", "*")).toBe(true);
  });

  it("bypasses an exact host match", () => {
    expect(shouldBypassProxy("https://internal.corp", "internal.corp")).toBe(true);
  });

  it("bypasses a suffix / subdomain match", () => {
    expect(shouldBypassProxy("https://api.example.com", "example.com")).toBe(true);
    expect(shouldBypassProxy("https://api.example.com", ".example.com")).toBe(true);
    expect(shouldBypassProxy("https://api.example.com", "*.example.com")).toBe(true);
  });

  it("strips a port from the NO_PROXY entry", () => {
    expect(shouldBypassProxy("https://api.example.com", "example.com:443")).toBe(true);
  });

  it("does NOT bypass a non-matching host", () => {
    expect(shouldBypassProxy("https://api.example.com", "other.com")).toBe(false);
  });

  it("does not treat a partial label as a suffix match", () => {
    // notexample.com must not match example.com
    expect(shouldBypassProxy("https://notexample.com", "example.com")).toBe(false);
  });

  it("returns false when NO_PROXY is empty/undefined", () => {
    expect(shouldBypassProxy("https://api.example.com", undefined)).toBe(false);
    expect(shouldBypassProxy("https://api.example.com", "   ")).toBe(false);
  });
});

describe("getProxyDispatcherUrl", () => {
  it("returns the proxy url when a proxy applies and NO_PROXY does not exempt it", () => {
    const env: ProxyEnvLike = { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "other.com" };
    expect(getProxyDispatcherUrl("https://api.example.com", env)).toBe("http://proxy:3128");
  });

  it("returns undefined when NO_PROXY exempts the host", () => {
    const env: ProxyEnvLike = { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "example.com" };
    expect(getProxyDispatcherUrl("https://api.example.com", env)).toBeUndefined();
  });

  it("returns undefined when no proxy is configured", () => {
    expect(getProxyDispatcherUrl("https://api.example.com", {})).toBeUndefined();
  });
});

describe("createProxyFetch", () => {
  it("routes through a dispatcher when a proxy is selected", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const dispatcher = { marker: "proxy-agent" };
    const dispatcherFactory = vi.fn(async () => dispatcher);
    const fetchImpl = createProxyFetch({
      env: { HTTPS_PROXY: "http://proxy:3128" },
      baseFetch,
      dispatcherFactory,
    });

    await fetchImpl("https://api.example.com/embeddings", { method: "POST" });

    expect(dispatcherFactory).toHaveBeenCalledWith("http://proxy:3128");
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
    expect(init.method).toBe("POST");
  });

  it("goes direct (no dispatcher) when no proxy applies", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const dispatcherFactory = vi.fn();
    const fetchImpl = createProxyFetch({ env: {}, baseFetch, dispatcherFactory });

    await fetchImpl("https://api.example.com/embeddings", { method: "POST" });

    expect(dispatcherFactory).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });

  it("goes direct when NO_PROXY exempts the target host", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const dispatcherFactory = vi.fn();
    const fetchImpl = createProxyFetch({
      env: { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "example.com" },
      baseFetch,
      dispatcherFactory,
    });

    await fetchImpl("https://api.example.com/embeddings", { method: "POST" });

    expect(dispatcherFactory).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});
