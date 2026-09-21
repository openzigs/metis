/**
 * Issue #302 — canonical safeFetch tests.
 *
 * Cover: scheme rejection, IPv4 + IPv6 private classification (loopback,
 * link-local, ULA, multicast, AWS metadata, IPv4-mapped-IPv6), DNS rebinding
 * race (resolver returns public on validation, private on next call →
 * subsequent calls fail closed), allow-list bypass, loopback bypass,
 * redirect:'error' default, redirect:'follow' with re-validation on cross-
 * origin hops, dispatcher build per hop, multiple resolved addresses with
 * one private (fail-closed), DNS lookup empty, DNS lookup error,
 * IP-literal short circuit.
 */
import { describe, expect, it, vi } from "vitest";
import {
  safeFetch,
  type DispatcherFactory,
  type ResolvedAddress,
  type SafeFetchResolver,
} from "../../../src/lib/net/safe-fetch.js";
import {
  SafeFetchDnsError,
  SafeFetchPrivateIpError,
  SafeFetchRedirectError,
  SafeFetchSchemeError,
  SafeFetchUrlError,
} from "../../../src/lib/net/safe-fetch.errors.js";

function mkResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function publicResolver(addr: ResolvedAddress = { address: "140.82.112.10", family: 4 }) {
  return vi.fn<SafeFetchResolver>().mockResolvedValue([addr]);
}

const noopDispatcher: DispatcherFactory = vi.fn(async () => ({
  close: async () => {
    /* noop */
  },
}));

describe("safeFetch — scheme validation", () => {
  it("rejects file: URLs", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SafeFetchSchemeError);
  });
  it("rejects gopher: URLs", async () => {
    await expect(safeFetch("gopher://example.com/")).rejects.toBeInstanceOf(SafeFetchSchemeError);
  });
  it("rejects ftp: URLs", async () => {
    await expect(safeFetch("ftp://example.com/")).rejects.toBeInstanceOf(SafeFetchSchemeError);
  });
  it("rejects data: URLs", async () => {
    await expect(safeFetch("data:text/plain,boom")).rejects.toBeInstanceOf(SafeFetchSchemeError);
  });
  it("rejects malformed URLs", async () => {
    await expect(safeFetch("http://[::garbage")).rejects.toBeInstanceOf(SafeFetchUrlError);
  });
});

describe("safeFetch — private IP rejection", () => {
  it("rejects 169.254.169.254 (AWS metadata) by literal", async () => {
    await expect(safeFetch("http://169.254.169.254/latest/")).rejects.toMatchObject({
      name: "SafeFetchPrivateIpError",
      classification: "ipv4-aws-metadata",
    });
  });

  it("rejects 127.0.0.1 by literal", async () => {
    await expect(safeFetch("http://127.0.0.1:8080/")).rejects.toMatchObject({
      classification: "ipv4-loopback",
    });
  });

  it("rejects 10.0.0.1 by literal", async () => {
    await expect(safeFetch("http://10.0.0.1/")).rejects.toMatchObject({
      classification: "ipv4-private",
    });
  });

  it("rejects 100.64.0.1 (CGNAT) by literal", async () => {
    await expect(safeFetch("http://100.64.0.1/")).rejects.toMatchObject({
      classification: "ipv4-cgnat",
    });
  });

  it("rejects 224.0.0.1 (multicast) by literal", async () => {
    await expect(safeFetch("http://224.0.0.1/")).rejects.toMatchObject({
      classification: "ipv4-multicast",
    });
  });

  it("rejects 192.0.2.1 (TEST-NET-1) as ipv4-reserved", async () => {
    await expect(safeFetch("http://192.0.2.1/")).rejects.toMatchObject({
      classification: "ipv4-reserved",
    });
  });

  it("rejects [::1] (loopback) by literal", async () => {
    await expect(safeFetch("http://[::1]/")).rejects.toMatchObject({
      classification: "ipv6-loopback",
    });
  });

  it("rejects [fe80::1] (link-local) by literal", async () => {
    await expect(safeFetch("http://[fe80::1]/")).rejects.toMatchObject({
      classification: "ipv6-link-local",
    });
  });

  it("rejects [fc00::1] (ULA) by literal", async () => {
    await expect(safeFetch("http://[fc00::1]/")).rejects.toMatchObject({
      classification: "ipv6-ula",
    });
  });

  it("rejects [ff02::1] (multicast) by literal", async () => {
    await expect(safeFetch("http://[ff02::1]/")).rejects.toMatchObject({
      classification: "ipv6-multicast",
    });
  });

  it("rejects IPv4-mapped IPv6 of 169.254.169.254 returned by DNS", async () => {
    const resolver = vi
      .fn<SafeFetchResolver>()
      .mockResolvedValue([{ address: "::ffff:169.254.169.254", family: 6 }]);
    await expect(
      safeFetch("https://evil.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });

  it("rejects IPv4-mapped IPv6 of RFC1918 returned by DNS", async () => {
    const resolver = vi
      .fn<SafeFetchResolver>()
      .mockResolvedValue([{ address: "::ffff:10.0.0.1", family: 6 }]);
    await expect(
      safeFetch("https://evil.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });
});

describe("safeFetch — DNS validation", () => {
  it("rejects when ANY resolved address is private", async () => {
    const resolver = vi.fn<SafeFetchResolver>().mockResolvedValue([
      { address: "140.82.112.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      safeFetch("https://evil.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });

  it("rejects when DNS returns empty", async () => {
    const resolver = vi.fn<SafeFetchResolver>().mockResolvedValue([]);
    await expect(
      safeFetch("https://no.records/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchDnsError);
  });

  it("wraps resolver errors as SafeFetchDnsError", async () => {
    const resolver = vi.fn<SafeFetchResolver>().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      safeFetch("https://ghost.invalid/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchDnsError);
  });

  it("permits public hostname through", async () => {
    const resolver = publicResolver();
    const fetchImpl = vi.fn(async () => mkResponse("ok", { status: 200 }));
    const res = await safeFetch("https://api.github.com/", {
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(resolver).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("safeFetch — DNS rebinding TOCTOU defence", () => {
  it("each call re-resolves and re-validates; a flipped resolver fails closed on the next call", async () => {
    let n = 0;
    const resolver: SafeFetchResolver = async () => {
      n += 1;
      return n === 1
        ? [{ address: "140.82.112.10", family: 4 }]
        : [{ address: "10.0.0.5", family: 4 }];
    };
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    const ok = await safeFetch("https://evil.example/", {
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl,
    });
    expect(ok.status).toBe(200);
    // Second call sees the flipped DNS and refuses.
    await expect(
      safeFetch("https://evil.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });

  it("dispatcher is built with the FIRST validated address (rebind-safe)", async () => {
    const resolver = publicResolver({ address: "140.82.112.20", family: 4 });
    const seen: ResolvedAddress[] = [];
    const dispatcherFactory: DispatcherFactory = vi.fn(async (pinned) => {
      seen.push(pinned);
      return { close: async () => undefined };
    });
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    await safeFetch("https://api.github.com/", { resolver, dispatcherFactory, fetchImpl });
    expect(seen).toEqual([{ address: "140.82.112.20", family: 4 }]);
  });
});

describe("safeFetch — allow-list bypass", () => {
  it("allowedHosts skips the private-IP check", async () => {
    const resolver = vi
      .fn<SafeFetchResolver>()
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    const res = await safeFetch("https://internal.svc/", {
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl,
      allowedHosts: new Set(["internal.svc"]),
    });
    expect(res.status).toBe(200);
  });

  it("allowLoopback permits localhost", async () => {
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    const res = await safeFetch("http://localhost:8080/", {
      dispatcherFactory: noopDispatcher,
      fetchImpl,
      allowLoopback: true,
    });
    expect(res.status).toBe(200);
  });

  it("loopback without allow is rejected", async () => {
    await expect(
      safeFetch("http://localhost/", {
        dispatcherFactory: noopDispatcher,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });
});

describe("safeFetch — redirects", () => {
  it("default policy throws on any 3xx with Location", async () => {
    const resolver = publicResolver();
    const fetchImpl = vi.fn(async () =>
      mkResponse("", { status: 302, headers: { location: "https://other.example/" } }),
    );
    await expect(
      safeFetch("https://api.github.com/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(SafeFetchRedirectError);
  });

  it("3xx without Location is returned as-is", async () => {
    const resolver = publicResolver();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const res = await safeFetch("https://api.github.com/", {
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl,
    });
    expect(res.status).toBe(304);
  });

  it("redirect:'follow' walks public→public hops and re-validates each", async () => {
    let calls = 0;
    const resolver = vi.fn<SafeFetchResolver>().mockImplementation(async (host) => {
      // Each host returns its own public IP.
      const map: Record<string, string> = {
        "a.example": "140.82.112.10",
        "b.example": "151.101.1.1",
      };
      return [{ address: map[host] ?? "1.1.1.1", family: 4 }];
    });
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return mkResponse("", { status: 302, headers: { location: "https://b.example/x" } });
      }
      return mkResponse("done", { status: 200 });
    });
    const dispatcherFactory = vi.fn<DispatcherFactory>(async () => ({
      close: async () => undefined,
    }));
    const res = await safeFetch("https://a.example/", {
      resolver,
      dispatcherFactory,
      fetchImpl,
      redirect: "follow",
    });
    expect(res.status).toBe(200);
    // Resolver called for each host; dispatcher rebuilt per hop.
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(dispatcherFactory).toHaveBeenCalledTimes(2);
  });

  it("redirect:'follow' refuses to redirect to a private host", async () => {
    let calls = 0;
    const resolver = vi.fn<SafeFetchResolver>().mockImplementation(async (host) => {
      if (host === "good.example") return [{ address: "140.82.112.10", family: 4 }];
      return [{ address: "10.0.0.5", family: 4 }];
    });
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return mkResponse("", { status: 302, headers: { location: "https://evil.example/" } });
      }
      return mkResponse("never", { status: 200 });
    });
    await expect(
      safeFetch("https://good.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl,
        redirect: "follow",
      }),
    ).rejects.toBeInstanceOf(SafeFetchPrivateIpError);
  });

  it("redirect:'follow' enforces hop limit", async () => {
    const resolver = vi.fn<SafeFetchResolver>(async () => [
      { address: "140.82.112.10", family: 4 },
    ]);
    const fetchImpl = vi.fn(async () =>
      mkResponse("", { status: 302, headers: { location: "https://hop.example/" } }),
    );
    await expect(
      safeFetch("https://hop.example/", {
        resolver,
        dispatcherFactory: noopDispatcher,
        fetchImpl,
        redirect: "follow",
        maxRedirects: 1,
      }),
    ).rejects.toBeInstanceOf(SafeFetchRedirectError);
  });

  it("303 forces GET and clears body across the hop", async () => {
    const resolver = vi.fn<SafeFetchResolver>(async () => [
      { address: "140.82.112.10", family: 4 },
    ]);
    const seenInits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      seenInits.push(init);
      if (seenInits.length === 1) {
        return mkResponse("", { status: 303, headers: { location: "https://target.example/q" } });
      }
      return mkResponse("ok", { status: 200 });
    });
    const res = await safeFetch("https://api.example/", {
      method: "POST",
      body: "payload",
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redirect: "follow",
    });
    expect(res.status).toBe(200);
    expect(seenInits[1].method).toBe("GET");
    expect(seenInits[1].body).toBeUndefined();
  });
});

describe("safeFetch — request-init pass-through", () => {
  it("forwards method/headers/body to the underlying fetch", async () => {
    const resolver = publicResolver();
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    await safeFetch("https://api.example/", {
      method: "PUT",
      headers: { "x-marker": "abc" },
      body: "{}",
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["x-marker"]).toBe("abc");
    expect(init.body).toBe("{}");
    // Always force manual redirect mode internally.
    expect(init.redirect).toBe("manual");
    // Dispatcher attached for undici pinning.
    expect(init.dispatcher).toBeDefined();
  });

  it("does not allow callers to override the dispatcher", async () => {
    const resolver = publicResolver();
    const fetchImpl = vi.fn(async () => mkResponse("ok"));
    const evil = { close: async () => undefined };
    // Cast: the public type intentionally omits `dispatcher`, but a sloppy
    // caller could try to sneak it through with `as any`. Verify it's
    // stripped before reaching fetchImpl.
    await safeFetch("https://api.example/", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ dispatcher: evil } as any),
      resolver,
      dispatcherFactory: noopDispatcher,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0][1] as { dispatcher?: unknown };
    expect(init.dispatcher).not.toBe(evil);
  });

  it("closes every dispatcher built during a redirect chain", async () => {
    const closes: number[] = [];
    let id = 0;
    const dispatcherFactory: DispatcherFactory = async () => {
      const myId = ++id;
      return {
        close: async () => {
          closes.push(myId);
        },
      };
    };
    const resolver = vi.fn<SafeFetchResolver>(async () => [
      { address: "140.82.112.10", family: 4 },
    ]);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return mkResponse("", { status: 302, headers: { location: "https://b.example/" } });
      }
      return mkResponse("ok", { status: 200 });
    });
    await safeFetch("https://a.example/", {
      resolver,
      dispatcherFactory,
      fetchImpl,
      redirect: "follow",
    });
    expect(closes.length).toBe(2);
  });
});
